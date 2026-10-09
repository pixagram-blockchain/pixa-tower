// Rollup engine: turns event tables into metric_rollup rows.
// Every step recomputes whole buckets (delete + insert), so it can be re-run at any time.

import type { TowerConfig } from "./config";
import { gini, median, nakamoto, PXP_BUCKETS, pxpBucket, topShare } from "./formulas";
import { METRICS, METRIC_BY_ID, type MetricDef } from "./metrics";
import { all, first, type Stmt } from "./sql";
import { bucketEnd, bucketStart, DAY, type Grain, HOUR } from "./time";

export interface MetricRow {
  metric: string;
  grain: Grain;
  dim: string;
  bucket: number;
  value: number | null;
  extra?: unknown;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function upsertRows(rows: MetricRow[], computedAt: number): Stmt[] {
  return rows.map((r) => ({
    sql: `INSERT INTO metric_rollup (metric, grain, dim, bucket, value, extra, def_version, computed_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(metric, grain, dim, bucket) DO UPDATE SET value=excluded.value, extra=excluded.extra,
            def_version=excluded.def_version, computed_at=excluded.computed_at`,
    params: [
      r.metric, r.grain, r.dim ?? "", r.bucket,
      r.value === null || r.value === undefined || !Number.isFinite(r.value) ? null : r.value,
      r.extra === undefined || r.extra === null ? null : typeof r.extra === "string" ? r.extra : JSON.stringify(r.extra),
      METRIC_BY_ID.get(r.metric)?.version ?? 1, computedAt,
    ],
  }));
}

function clearBucket(metric: string, grain: Grain, bucket: number): Stmt {
  return { sql: `DELETE FROM metric_rollup WHERE metric = ? AND grain = ? AND bucket = ?`, params: [metric, grain, bucket] };
}

async function batch(db: D1Database, stmts: Stmt[], size = 400) {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size).map((s) => db.prepare(s.sql).bind(...s.params)));
  }
}

/** Write rows for one metric bucket, replacing whatever was there. */
export async function replaceBucket(db: D1Database, metric: string, grain: Grain, bucket: number, rows: Omit<MetricRow, "metric" | "grain" | "bucket">[]) {
  const full = rows.map((r) => ({ ...r, metric, grain, bucket }));
  await batch(db, [clearBucket(metric, grain, bucket), ...upsertRows(full, nowSec())]);
}

/** Upsert gauge values into the current bucket of each of the metric's grains (last value wins). */
export function gaugeStmts(metric: string, ts: number, rows: { dim?: string; value: number | null; extra?: unknown }[]): Stmt[] {
  const def = METRIC_BY_ID.get(metric);
  if (!def) throw new Error(`unknown metric ${metric}`);
  const out: MetricRow[] = [];
  for (const grain of def.grains) {
    for (const r of rows) out.push({ metric, grain, dim: r.dim ?? "", bucket: bucketStart(ts, grain), value: r.value, extra: r.extra });
  }
  return upsertRows(out, ts);
}

export async function syncMetricDefs(db: D1Database) {
  await batch(
    db,
    METRICS.map((m) => ({
      sql: `INSERT INTO metric_defs (metric, title, unit, section, grains, kind, description, def_version) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(metric) DO UPDATE SET title=excluded.title, unit=excluded.unit, section=excluded.section, grains=excluded.grains,
              kind=excluded.kind, description=excluded.description, def_version=excluded.def_version`,
      params: [m.id, m.title, m.unit, m.section, m.grains.join(","), m.kind, m.description, m.version],
    })),
  );
}

// ------------------------------------------------------------------ SQL metrics

function sqlFor(def: MetricDef, cfg: TowerConfig): string | null {
  if (def.id === "exchange_inflow") {
    if (cfg.exchangeAccounts.size === 0) return null;
    const list = [...cfg.exchangeAccounts].map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
    return `SELECT '' AS dim, COALESCE(SUM(amount), 0) / 1e3 AS value FROM transfers WHERE receiver IN (${list}) AND asset IN ('PIXA','PXS') AND ts >= ?1 AND ts < ?2
            UNION ALL SELECT receiver, SUM(amount) / 1e3 FROM transfers WHERE receiver IN (${list}) AND asset IN ('PIXA','PXS') AND ts >= ?1 AND ts < ?2 GROUP BY receiver`;
  }
  if (def.id === "dpf_paid") {
    // '' = paid out to receivers other than the fund; payments to the fund are the return proposal's.
    const fund = `'${cfg.dpfAccount.replace(/'/g, "''")}'`;
    return `SELECT '' AS dim, COALESCE(SUM(pxs), 0) / 1e3 AS value FROM rewards WHERE type = 'dpf' AND account <> ${fund} AND ts >= ?1 AND ts < ?2
            UNION ALL SELECT account, SUM(pxs) / 1e3 FROM rewards WHERE type = 'dpf' AND ts >= ?1 AND ts < ?2 GROUP BY account`;
  }
  return def.sql ?? null;
}

async function runSqlMetrics(db: D1Database, cfg: TowerConfig, defs: MetricDef[], grain: Grain, bucket: number): Promise<MetricRow[]> {
  const end = bucketEnd(bucket, grain);
  const runnable = defs.map((d) => ({ d, sql: sqlFor(d, cfg) })).filter((x) => x.sql);
  if (runnable.length === 0) return [];
  const res = await db.batch(runnable.map((x) => db.prepare(x.sql!).bind(bucket, end)));
  const rows: MetricRow[] = [];
  res.forEach((r, i) => {
    const def = runnable[i].d;
    const seen = new Set<string>();
    for (const row of (r.results ?? []) as { dim: string | null; value: number | null; extra?: string | null }[]) {
      const dim = row.dim ?? "";
      if (seen.has(dim)) continue;
      seen.add(dim);
      if (row.value === null && def.kind === "counter") continue;
      rows.push({ metric: def.id, grain, dim, bucket, value: row.value, extra: row.extra ?? undefined });
    }
    // Counters with no events still record 0 for the total, so charts show a flat line, not a gap.
    if (def.kind === "counter" && !seen.has("") && !["transfers_volume", "conversions", "custom_json_ops", "portal_subscriptions"].includes(def.id)) {
      rows.push({ metric: def.id, grain, dim: "", bucket, value: 0 });
    }
  });
  return rows;
}

async function writeBuckets(db: D1Database, rows: MetricRow[], defs: MetricDef[], grain: Grain, bucket: number) {
  const stmts: Stmt[] = defs.map((d) => clearBucket(d.id, grain, bucket));
  stmts.push(...upsertRows(rows, nowSec()));
  await batch(db, stmts);
}

/** Counters at hour grain + range metrics at hour grain, for one hour. */
export async function computeHour(db: D1Database, cfg: TowerConfig, hour: number) {
  const defs = METRICS.filter((m) => (m.kind === "counter" || m.kind === "range") && m.grains.includes("hour"));
  const rows = await runSqlMetrics(db, cfg, defs, "hour", hour);
  await writeBuckets(db, rows, defs, "hour", hour);
}

/** Day, week or month bucket: counters summed from hours, range metrics run over the whole range. */
export async function computeAggregate(db: D1Database, cfg: TowerConfig, grain: Exclude<Grain, "hour">, bucket: number) {
  const end = bucketEnd(bucket, grain);
  const counters = METRICS.filter((m) => m.kind === "counter" && m.grains.includes(grain));
  const ranges = METRICS.filter((m) => m.kind === "range" && m.grains.includes(grain));
  const stmts: Stmt[] = counters.map((d) => clearBucket(d.id, grain, bucket));
  const ids = counters.map((c) => `'${c.id}'`).join(",");
  stmts.push({
    sql: `INSERT INTO metric_rollup (metric, grain, dim, bucket, value, extra, def_version, computed_at)
          SELECT metric, ?, dim, ?, SUM(value), NULL, MAX(def_version), ? FROM metric_rollup
          WHERE grain = 'hour' AND bucket >= ? AND bucket < ? AND metric IN (${ids})
          GROUP BY metric, dim
          ON CONFLICT(metric, grain, dim, bucket) DO UPDATE SET value=excluded.value, def_version=excluded.def_version, computed_at=excluded.computed_at`,
    params: [grain, bucket, nowSec(), bucket, end],
  });
  await batch(db, stmts);
  const rows = await runSqlMetrics(db, cfg, ranges, grain, bucket);
  await writeBuckets(db, rows, ranges, grain, bucket);
}

// ------------------------------------------------------------------ state

export async function getState(db: D1Database, job: string): Promise<number | null> {
  const r = await first<{ last_bucket: number }>(db, `SELECT last_bucket FROM rollup_state WHERE job = ?`, job);
  return r ? r.last_bucket : null;
}

export async function setState(db: D1Database, job: string, bucket: number) {
  await db
    .prepare(`INSERT INTO rollup_state (job, last_bucket, updated_at) VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET last_bucket=excluded.last_bucket, updated_at=excluded.updated_at`)
    .bind(job, bucket, nowSec())
    .run();
}

/** Time of the last ingested block: rollups never go past it. */
export async function ingestedTime(db: D1Database): Promise<number | null> {
  const r = await first<{ block_ts: number }>(db, `SELECT block_ts FROM cursor WHERE name = 'scanner'`);
  return r?.block_ts ?? null;
}

async function genesisTime(db: D1Database): Promise<number | null> {
  const r = await first<{ ts: number }>(db, `SELECT MIN(ts) AS ts FROM blocks`);
  return r?.ts ?? null;
}

/**
 * Hourly rollup with catch-up. Completes every closed hour after the last one done, up to `maxHours`,
 * then refreshes the day, week and month buckets those hours belong to (including the open ones).
 */
export async function runHourly(db: D1Database, cfg: TowerConfig, opts: { maxHours?: number } = {}) {
  const ingested = await ingestedTime(db);
  if (!ingested) return { hours: 0 };
  let last = await getState(db, "hour");
  if (last === null) {
    const g = await genesisTime(db);
    if (!g) return { hours: 0 };
    last = bucketStart(g, "hour") - HOUR;
  }
  const maxHours = opts.maxHours ?? 48;
  const touched = new Map<string, { grain: Exclude<Grain, "hour">; bucket: number }>();
  let done = 0;
  for (let h = last + HOUR; h + HOUR <= ingested && done < maxHours; h += HOUR) {
    await computeHour(db, cfg, h);
    await setState(db, "hour", h);
    for (const g of ["day", "week", "month"] as const) touched.set(`${g}:${bucketStart(h, g)}`, { grain: g, bucket: bucketStart(h, g) });
    done++;
  }
  // The open hour, so the dashboard's current hour is never empty.
  const openHour = bucketStart(ingested, "hour");
  if (done < maxHours) {
    await computeHour(db, cfg, openHour);
    for (const g of ["day", "week", "month"] as const) touched.set(`${g}:${bucketStart(openHour, g)}`, { grain: g, bucket: bucketStart(openHour, g) });
  }
  for (const t of touched.values()) await computeAggregate(db, cfg, t.grain, t.bucket);
  return { hours: done, aggregates: touched.size };
}

// ------------------------------------------------------------------ daily metrics

interface Prices {
  vestsToPixa: number;
  pixaPerPxs: number;
}

/** Prices near `ts`: the chain's median feed from the nearest snapshot, else the median of each witness's latest feed. */
async function pricesAt(db: D1Database, ts: number): Promise<Prices> {
  type Snap = { vesting_fund_pixa: number; vesting_shares: number; feed_base: number | null; feed_quote: number | null };
  const cols = `SELECT vesting_fund_pixa, vesting_shares, feed_base, feed_quote FROM chain_snapshots`;
  const near = await first<Snap>(db, `${cols} WHERE ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 1`, ts, ts - 2 * DAY);
  const any = near ?? (await first<Snap>(db, `${cols} WHERE ts <= ? ORDER BY ts DESC LIMIT 1`, ts)) ?? (await first<Snap>(db, `${cols} ORDER BY ts ASC LIMIT 1`));
  const vestsToPixa = any && any.vesting_shares ? (any.vesting_fund_pixa / 1e3) / (any.vesting_shares / 1e6) : 1;
  if (near?.feed_base && near.feed_quote) return { vestsToPixa, pixaPerPxs: near.feed_quote / near.feed_base };
  const feeds = await all<{ p: number }>(
    db,
    `SELECT f.quote * 1.0 / f.base AS p FROM feeds f
     JOIN (SELECT witness, MAX(ts) AS t FROM feeds WHERE ts <= ?1 AND ts > ?1 - 604800 GROUP BY witness) l ON l.witness = f.witness AND l.t = f.ts
     WHERE f.base > 0`,
    ts,
  );
  const m = median(feeds.map((f) => f.p));
  if (m) return { vestsToPixa, pixaPerPxs: m };
  return { vestsToPixa, pixaPerPxs: any?.feed_base && any.feed_quote ? any.feed_quote / any.feed_base : 0 };
}

const pixaEq = (p: Prices, alias = "") =>
  `(${alias}pixa / 1e3 + ${alias}pxs / 1e3 * ${p.pixaPerPxs} + ${alias}vests / 1e6 * ${p.vestsToPixa})`;

type DailyFn = (ctx: DailyCtx) => Promise<{ dim?: string; value: number | null; extra?: unknown }[] | null>;

interface DailyCtx {
  db: D1Database;
  cfg: TowerConfig;
  day: number; // bucket start
  end: number; // bucket end
  ingested: number;
  isRecent: boolean; // the day closed within the last 36 hours: current-state tables describe it
}

const USERS = `is_system = 0 AND is_portal = 0`;

const DAILY: Record<string, { fn: DailyFn; lagDays?: number; current?: boolean; grain?: Grain }> = {
  stickiness: {
    fn: async ({ db, day, end }) => {
      const r = await first<{ dau: number; mau: number }>(
        db,
        `SELECT (SELECT COUNT(DISTINCT account) FROM op_log WHERE ts >= ?1 AND ts < ?2 AND type NOT IN ('feed_publish','witness_set_properties','witness_update')) AS dau,
                (SELECT COUNT(DISTINCT account) FROM op_log WHERE ts >= ?3 AND ts < ?2 AND type NOT IN ('feed_publish','witness_set_properties','witness_update')) AS mau`,
        day, end, end - 30 * DAY,
      );
      return [{ value: r && r.mau ? r.dau / r.mau : null, extra: r }];
    },
  },
  activation_rate_7d: {
    lagDays: 7,
    fn: async ({ db, day, end }) => {
      const r = await first<{ cohort: number; activated: number }>(
        db,
        `SELECT COUNT(*) AS cohort,
           SUM(CASE WHEN MIN(COALESCE(first_vote_ts, 1e12), COALESCE(first_post_ts, 1e12)) <= created_ts + 604800 THEN 1 ELSE 0 END) AS activated
         FROM accounts WHERE ${USERS} AND created_ts >= ? AND created_ts < ?`,
        day, end,
      );
      return [{ value: r && r.cohort ? r.activated / r.cohort : null, extra: r }];
    },
  },
  dormant_share: {
    fn: async ({ db, end }) => {
      const r = await first<{ users: number; active: number }>(
        db,
        `SELECT (SELECT COUNT(*) FROM accounts WHERE ${USERS} AND created_ts < ?1) AS users,
                (SELECT COUNT(DISTINCT o.account) FROM op_log o JOIN accounts a ON a.name = o.account
                   WHERE a.is_system = 0 AND a.is_portal = 0 AND a.created_ts < ?1 AND o.ts >= ?2 AND o.ts < ?1) AS active`,
        end, end - 30 * DAY,
      );
      return [{ value: r && r.users ? (r.users - r.active) / r.users : null, extra: r }];
    },
  },
  onboarding_funnel: {
    grain: "week",
    fn: async ({ db, day }) => {
      const week = bucketStart(day, "week");
      const r = await first<Record<string, number>>(
        db,
        `SELECT COUNT(*) AS created, COUNT(profile_set_ts) AS profile, COUNT(first_follow_ts) AS follow, COUNT(first_vote_ts) AS vote,
                COUNT(first_artwork_ts) AS artwork, COUNT(first_reward_ts) AS reward, COUNT(first_claim_ts) AS claim,
                COUNT(first_powerup_ts) AS power_up
         FROM accounts WHERE ${USERS} AND created_ts >= ? AND created_ts < ?`,
        week, week + 7 * DAY,
      );
      if (!r) return [];
      return ["created", "profile", "follow", "vote", "artwork", "reward", "claim", "power_up"].map((k) => ({ dim: k, value: r[k] ?? 0 }));
    },
  },
  cohort_retention: {
    grain: "week",
    fn: async ({ db, day, ingested }) => {
      const week = bucketStart(day, "week");
      const out: { dim: string; value: number | null; extra?: unknown }[] = [];
      for (const k of [1, 4, 12]) {
        const from = week + k * 7 * DAY;
        if (from + 7 * DAY > ingested) continue;
        const r = await first<{ cohort: number; active: number }>(
          db,
          `SELECT (SELECT COUNT(*) FROM accounts WHERE ${USERS} AND created_ts >= ?1 AND created_ts < ?2) AS cohort,
                  (SELECT COUNT(DISTINCT o.account) FROM op_log o JOIN accounts a ON a.name = o.account
                    WHERE a.is_system = 0 AND a.is_portal = 0 AND a.created_ts >= ?1 AND a.created_ts < ?2 AND o.ts >= ?3 AND o.ts < ?4) AS active`,
          week, week + 7 * DAY, from, from + 7 * DAY,
        );
        out.push({ dim: `w${k}`, value: r && r.cohort ? r.active / r.cohort : null, extra: r });
      }
      return out;
    },
  },
  artwork_pixels_median: {
    fn: async ({ db, day, end }) => {
      const rows = await all<{ width: number; height: number }>(
        db, `SELECT width, height FROM posts WHERE kind = 'artwork' AND width IS NOT NULL AND created_ts >= ? AND created_ts < ?`, day, end,
      );
      if (rows.length === 0) return [{ value: null }];
      return [{
        value: median(rows.map((r) => r.width * r.height)),
        extra: { width: median(rows.map((r) => r.width)), height: median(rows.map((r) => r.height)), artworks: rows.length },
      }];
    },
  },
  cold_start_rate: {
    lagDays: 1,
    fn: async ({ db, day, end }) => {
      const r = await first<{ posts: number; cold: number }>(
        db,
        `SELECT COUNT(*) AS posts, SUM(CASE WHEN first_vote_ts IS NULL OR first_vote_ts > created_ts + 86400 THEN 1 ELSE 0 END) AS cold
         FROM posts WHERE kind IN ('artwork','blog') AND created_ts >= ? AND created_ts < ?`,
        day, end,
      );
      return [{ value: r && r.posts ? r.cold / r.posts : null, extra: r }];
    },
  },
  time_to_first_vote_median: {
    lagDays: 1,
    fn: async ({ db, day, end }) => {
      const rows = await all<{ m: number }>(
        db,
        `SELECT (first_vote_ts - created_ts) / 60.0 AS m FROM posts WHERE kind IN ('artwork','blog') AND first_vote_ts IS NOT NULL
           AND created_ts >= ? AND created_ts < ?`,
        day, end,
      );
      return [{ value: median(rows.map((r) => r.m)), extra: { posts: rows.length } }];
    },
  },
  downvote_concentration: {
    fn: async ({ db, end }) => {
      const rows = await all<{ voter: string; r: number }>(
        db, `SELECT voter, -SUM(rshares) AS r FROM votes WHERE rshares < 0 AND ts >= ? AND ts < ? GROUP BY voter`, end - 30 * DAY, end,
      );
      return [{ value: rows.length ? nakamoto(rows.map((x) => x.r), 0.8) : null, extra: { downvoters: rows.length } }];
    },
  },
  vote_rings: {
    fn: async ({ db, end }) => {
      const rows = await all<{ a: string; b: string; ab: number; ba: number }>(
        db,
        `WITH pairs AS (SELECT voter AS a, author AS b, COUNT(*) AS n FROM votes
           WHERE rshares > 0 AND voter <> author AND ts >= ? AND ts < ? GROUP BY voter, author HAVING COUNT(*) >= 5)
         SELECT p.a, p.b, p.n AS ab, q.n AS ba FROM pairs p JOIN pairs q ON q.a = p.b AND q.b = p.a WHERE p.a < p.b
         ORDER BY p.n + q.n DESC LIMIT 50`,
        end - 30 * DAY, end,
      );
      return [{ value: rows.length, extra: rows.slice(0, 10) }];
    },
  },
  repeat_downvote_pairs: {
    fn: async ({ db, end }) => {
      const rows = await all<{ voter: string; author: string; n: number }>(
        db,
        `SELECT voter, author, COUNT(*) AS n FROM votes WHERE rshares < 0 AND ts >= ? AND ts < ? GROUP BY voter, author HAVING COUNT(*) >= 3
         ORDER BY n DESC LIMIT 50`,
        end - 30 * DAY, end,
      );
      return [{ value: rows.length, extra: rows.slice(0, 10) }];
    },
  },
  attention_gini: {
    fn: async ({ db, end }) => {
      const rows = await all<{ r: number }>(
        db, `SELECT up_rshares AS r FROM posts WHERE paid = 1 AND kind IN ('artwork','blog') AND payout_ts >= ? AND payout_ts < ?`, end - 7 * DAY, end,
      );
      const xs = rows.map((x) => x.r);
      const top = Math.max(1, Math.ceil(xs.length * 0.1));
      const share = topShare(xs, top);
      return [{ value: gini(xs), extra: { posts: xs.length, long_tail_share: share === null ? null : 1 - share } }];
    },
  },
  reward_concentration: {
    fn: async ({ db, day, end }) => {
      const p = await pricesAt(db, end);
      const authors = await all<{ v: number }>(db, `SELECT SUM(${pixaEq(p)}) AS v FROM rewards WHERE type = 'author' AND ts >= ? AND ts < ? GROUP BY account`, day, end);
      const curators = await all<{ v: number }>(db, `SELECT SUM(${pixaEq(p)}) AS v FROM rewards WHERE type = 'curation' AND ts >= ? AND ts < ? GROUP BY account`, day, end);
      return [
        { dim: "authors", value: topShare(authors.map((x) => x.v), 10), extra: { accounts: authors.length } },
        { dim: "curators", value: topShare(curators.map((x) => x.v), 10), extra: { accounts: curators.length } },
      ];
    },
  },
  curation_share_observed: {
    fn: async ({ db, day, end }) => {
      const p = await pricesAt(db, end);
      const r = await first<{ cur: number; tot: number }>(
        db,
        `SELECT SUM(CASE WHEN type = 'curation' THEN ${pixaEq(p)} ELSE 0 END) AS cur, SUM(${pixaEq(p)}) AS tot
         FROM rewards WHERE type IN ('author','curation','beneficiary') AND ts >= ? AND ts < ?`,
        day, end,
      );
      return [{ value: r && r.tot ? r.cur / r.tot : null }];
    },
  },
  creator_earnings_median_30d: {
    fn: async ({ db, end }) => {
      const p = await pricesAt(db, end);
      const from = end - 30 * DAY;
      const rows = await all<{ v: number }>(
        db,
        `SELECT COALESCE((SELECT SUM(${pixaEq(p)}) FROM rewards r WHERE r.type = 'author' AND r.account = c.author AND r.ts >= ?1 AND r.ts < ?2), 0) AS v
         FROM (SELECT DISTINCT author FROM posts WHERE kind = 'artwork' AND created_ts >= ?1 AND created_ts < ?2) c`,
        from, end,
      );
      const target = 5 * p.pixaPerPxs;
      return [{
        value: median(rows.map((r) => r.v)),
        extra: { creators: rows.length, share_above_5_pxs: rows.length && target ? rows.filter((r) => r.v >= target).length / rows.length : null },
      }];
    },
  },
  new_creator_reward_share: {
    fn: async ({ db, end }) => {
      const p = await pricesAt(db, end);
      const r = await first<{ young: number; tot: number }>(
        db,
        `SELECT SUM(CASE WHEN a.created_ts > r.ts - 2592000 THEN ${pixaEq(p, "r.")} ELSE 0 END) AS young,
                SUM(${pixaEq(p, "r.")}) AS tot
         FROM rewards r LEFT JOIN accounts a ON a.name = r.account WHERE r.type = 'author' AND r.ts >= ? AND r.ts < ?`,
        end - 30 * DAY, end,
      );
      return [{ value: r && r.tot ? r.young / r.tot : null }];
    },
  },
  time_to_first_reward_median: {
    grain: "week",
    fn: async ({ db, day }) => {
      const week = bucketStart(day, "week");
      const rows = await all<{ d: number }>(
        db,
        `SELECT (first_reward_ts - first_post_ts) / 86400.0 AS d FROM accounts WHERE ${USERS} AND created_ts >= ? AND created_ts < ?
           AND first_post_ts IS NOT NULL AND first_reward_ts IS NOT NULL AND first_reward_ts >= first_post_ts`,
        week, week + 7 * DAY,
      );
      return [{ value: median(rows.map((r) => r.d)), extra: { accounts: rows.length } }];
    },
  },
  days_to_stop_print: {
    fn: async ({ db, day, end }) => {
      const rows = await all<{ bucket: number; value: number }>(
        db, `SELECT bucket, value FROM metric_rollup WHERE metric = 'pxs_debt_ratio' AND grain = 'day' AND dim = '' AND bucket > ? AND bucket <= ? AND value IS NOT NULL ORDER BY bucket`,
        day - 30 * DAY, day,
      );
      const snap = await first<{ pxs_stop_percent: number }>(db, `SELECT pxs_stop_percent FROM chain_snapshots WHERE ts <= ? ORDER BY ts DESC LIMIT 1`, end);
      const stop = (snap?.pxs_stop_percent ?? 2000) / 10000;
      if (rows.length < 3) return [{ value: null, extra: { points: rows.length, stop } }];
      const xs = rows.map((r) => r.bucket / DAY);
      const ys = rows.map((r) => r.value);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      const slope = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) / xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
      const current = ys[ys.length - 1];
      if (!(slope > 0) || current >= stop) return [{ value: current >= stop ? 0 : null, extra: { slope_per_day: slope, current, stop } }];
      return [{ value: (stop - current) / slope, extra: { slope_per_day: slope, current, stop } }];
    },
  },
  pxp_distribution: {
    current: true,
    fn: async ({ db }) => {
      const ratio = await vestsRatio(db);
      const rows = await all<{ own: number; eff: number }>(
        db,
        `SELECT b.vests / 1e6 * ?1 AS own, (b.vests - COALESCE(b.delegated_out,0) + COALESCE(b.received,0)) / 1e6 * ?1 AS eff
         FROM balances b JOIN accounts a ON a.name = b.account WHERE a.is_system = 0 AND a.is_portal = 0`,
        ratio,
      );
      const own = new Map<string, number>(PXP_BUCKETS.map((b) => [b.label, 0]));
      const eff = new Map<string, number>(PXP_BUCKETS.map((b) => [b.label, 0]));
      for (const r of rows) {
        own.set(pxpBucket(r.own), (own.get(pxpBucket(r.own)) ?? 0) + 1);
        eff.set(pxpBucket(r.eff), (eff.get(pxpBucket(r.eff)) ?? 0) + 1);
      }
      return PXP_BUCKETS.map((b) => ({ dim: b.label, value: own.get(b.label) ?? 0, extra: { effective: eff.get(b.label) ?? 0 } }));
    },
  },
  pxp_gini: {
    current: true,
    fn: async ({ db }) => {
      const rows = await all<{ v: number }>(db, `SELECT b.vests AS v FROM balances b JOIN accounts a ON a.name = b.account WHERE a.is_system = 0 AND a.is_portal = 0`);
      return [{ value: gini(rows.map((r) => r.v)), extra: { accounts: rows.length } }];
    },
  },
  pxp_nakamoto: {
    current: true,
    fn: async ({ db }) => {
      const rows = await all<{ v: number }>(db, `SELECT b.vests AS v FROM balances b JOIN accounts a ON a.name = b.account WHERE a.is_system = 0 AND a.is_portal = 0`);
      return [{ value: nakamoto(rows.map((r) => r.v), 0.5) }];
    },
  },
  velocity: {
    fn: async ({ db, day, end }) => {
      const p = await pricesAt(db, end);
      const snap = await first<{ liquid_pixa: number; liquid_pxs: number; ts: number }>(
        db, `SELECT liquid_pixa, liquid_pxs, ts FROM chain_snapshots WHERE ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 1`, end, end - 2 * DAY,
      );
      if (!snap || !snap.liquid_pixa) return [{ value: null }];
      const r = await first<{ v: number }>(
        db,
        `SELECT SUM(CASE WHEN asset = 'PIXA' THEN amount / 1e3 WHEN asset = 'PXS' THEN amount / 1e3 * ? ELSE 0 END) AS v
         FROM transfers WHERE op IN ('transfer','recurrent_transfer','fill_recurrent_transfer') AND ts >= ? AND ts < ?`,
        p.pixaPerPxs, day, end,
      );
      const liquid = snap.liquid_pixa / 1e3 + (snap.liquid_pxs / 1e3) * p.pixaPerPxs;
      return [{ value: liquid ? (r?.v ?? 0) / liquid : null }];
    },
  },
  treasury_distribution: {
    fn: async ({ db, cfg, end }) => {
      // '' = everything the company treasury transferred out; to_operating = to the operating account (an internal
      // step before sale); to_others = to any other account, i.e. stake that left the company's accounts.
      const r = await first<{ total: number; operating: number }>(
        db,
        `SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN receiver = ? THEN amount ELSE 0 END), 0) AS operating
         FROM transfers WHERE sender = ? AND asset = 'VESTS' AND ts < ?`,
        cfg.operatingAccount, cfg.treasuryScheduleAccount, end,
      );
      const total = (r?.total ?? 0) / cfg.treasuryInitialVests;
      const operating = (r?.operating ?? 0) / cfg.treasuryInitialVests;
      const years = Math.max(0, (end - cfg.tgeTime) / (365.25 * DAY));
      const lower = Math.min(1, years / 11);
      const upper = Math.min(1, years / 9);
      const mid = Math.min(1, years / 10);
      const gap = (x: number) => (x - mid) * 10 * 365.25;
      return [
        { value: total, extra: { lower, upper, mid, gap_days: gap(total), vests: (r?.total ?? 0) / 1e6, account: cfg.treasuryScheduleAccount } },
        { dim: "to_operating", value: operating, extra: { vests: (r?.operating ?? 0) / 1e6, account: cfg.operatingAccount } },
        { dim: "to_others", value: total - operating, extra: { gap_days: gap(total - operating), vests: ((r?.total ?? 0) - (r?.operating ?? 0)) / 1e6 } },
      ];
    },
  },
  witness_vote_swing: {
    fn: async ({ db, day, end }) => {
      const firstTs = await first<{ ts: number }>(db, `SELECT MIN(ts) AS ts FROM witness_snapshots WHERE ts >= ? AND ts < ?`, day, end);
      const lastTs = await first<{ ts: number }>(db, `SELECT MAX(ts) AS ts FROM witness_snapshots WHERE ts >= ? AND ts < ?`, day, end);
      if (!firstTs?.ts || !lastTs?.ts || firstTs.ts === lastTs.ts) return null;
      const rows = await all<{ witness: string; a: string; b: string }>(
        db,
        `SELECT s.witness, s.votes AS a, e.votes AS b FROM witness_snapshots s JOIN witness_snapshots e ON e.witness = s.witness AND e.ts = ?2
         WHERE s.ts = ?1`,
        firstTs.ts, lastTs.ts,
      );
      const out = rows.map((r) => {
        const a = Number(r.a);
        const b = Number(r.b);
        return { dim: r.witness, value: a > 0 ? (b - a) / a : b > 0 ? 1 : 0, extra: { from: a / 1e6, to: b / 1e6 } };
      });
      const maxAbs = out.reduce((m, r) => Math.max(m, Math.abs(r.value ?? 0)), 0);
      return [{ dim: "", value: maxAbs }, ...out];
    },
  },
  elected_set_churn: {
    fn: async ({ db, day, end }) => {
      const firstTs = await first<{ ts: number }>(db, `SELECT MIN(ts) AS ts FROM witness_snapshots WHERE ts >= ? AND ts < ?`, day, end);
      const lastTs = await first<{ ts: number }>(db, `SELECT MAX(ts) AS ts FROM witness_snapshots WHERE ts >= ? AND ts < ?`, day, end);
      if (!firstTs?.ts || !lastTs?.ts) return null;
      const a = new Set((await all<{ witness: string }>(db, `SELECT witness FROM witness_snapshots WHERE ts = ? AND rank IS NOT NULL`, firstTs.ts)).map((r) => r.witness));
      const b = new Set((await all<{ witness: string }>(db, `SELECT witness FROM witness_snapshots WHERE ts = ? AND rank IS NOT NULL`, lastTs.ts)).map((r) => r.witness));
      const entered = [...b].filter((w) => !a.has(w));
      const left = [...a].filter((w) => !b.has(w));
      return [{ value: entered.length + left.length, extra: { entered, left } }];
    },
  },
  mute_reversal_rate: {
    fn: async ({ db, end }) => {
      const r = await first<{ muted: number; reversed: number }>(
        db,
        `SELECT COUNT(*) AS muted, SUM(CASE WHEN EXISTS (SELECT 1 FROM community_ops u WHERE u.action = 'unmutePost' AND u.community = m.community
             AND u.target = m.target AND u.ts > m.ts) THEN 1 ELSE 0 END) AS reversed
         FROM community_ops m WHERE m.action = 'mutePost' AND m.ts >= ? AND m.ts < ?`,
        end - 30 * DAY, end,
      );
      return [{ value: r && r.muted ? r.reversed / r.muted : null, extra: r }];
    },
  },
  follow_reciprocity: {
    current: true,
    fn: async ({ db }) => {
      const r = await first<{ total: number; mutual: number }>(
        db,
        `SELECT COUNT(*) AS total, SUM(CASE WHEN EXISTS (SELECT 1 FROM follows g WHERE g.follower = f.following AND g.following = f.follower AND g.what = 'blog') THEN 1 ELSE 0 END) AS mutual
         FROM follows f WHERE f.what = 'blog'`,
      );
      return [{ value: r && r.total ? r.mutual / r.total : null, extra: r }];
    },
  },
  isolated_active_accounts: {
    fn: async ({ db, end }) => {
      const r = await first<{ n: number; active: number }>(
        db,
        `SELECT COUNT(*) AS active, SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM follows f WHERE f.following = x.account AND f.what = 'blog') THEN 1 ELSE 0 END) AS n
         FROM (SELECT DISTINCT o.account FROM op_log o JOIN accounts a ON a.name = o.account
               WHERE a.is_system = 0 AND a.is_portal = 0 AND o.ts >= ? AND o.ts < ?) x`,
        end - 30 * DAY, end,
      );
      return [{ value: r?.n ?? 0, extra: r }];
    },
  },
  recovery_concentration: {
    current: true,
    fn: async ({ db }) => {
      const rows = await all<{ recovery_account: string; n: number }>(
        db,
        `SELECT b.recovery_account, COUNT(*) AS n FROM balances b JOIN accounts a ON a.name = b.account
         WHERE a.is_system = 0 AND a.is_portal = 0 AND b.recovery_account IS NOT NULL GROUP BY b.recovery_account ORDER BY n DESC`,
      );
      const total = rows.reduce((s, r) => s + r.n, 0);
      return [{ value: total ? rows[0].n / total : null, extra: { top: rows.slice(0, 5), accounts: total } }];
    },
  },
  posting_grants_max: {
    current: true,
    fn: async ({ db }) => {
      const rows = await all<{ grantee: string; n: number }>(
        db, `SELECT grantee, COUNT(*) AS n FROM posting_grants GROUP BY grantee ORDER BY n DESC LIMIT 10`,
      );
      return [{ value: rows[0]?.n ?? 0, extra: rows }];
    },
  },
  large_outflows_after_key_change: {
    fn: async ({ db, day, end }) => {
      const rows = await all<{ account: string; n: number }>(
        db,
        `SELECT e.account, (SELECT COUNT(*) FROM transfers t WHERE t.sender = e.account AND t.ts >= e.ts AND t.ts < e.ts + 3600)
              + (SELECT COUNT(*) FROM stake_events s WHERE s.account = e.account AND s.op = 'power_down_set' AND s.ts >= e.ts AND s.ts < e.ts + 3600) AS n
         FROM authority_events e WHERE e.kind IN ('owner','active') AND e.ts >= ? AND e.ts < ?`,
        day, end,
      );
      const hits = rows.filter((r) => r.n > 0);
      return [{ value: hits.reduce((s, r) => s + r.n, 0), extra: hits.slice(0, 20) }];
    },
  },
};

async function vestsRatio(db: D1Database): Promise<number> {
  const r = await first<{ vesting_fund_pixa: number; vesting_shares: number }>(
    db, `SELECT vesting_fund_pixa, vesting_shares FROM chain_snapshots ORDER BY ts DESC LIMIT 1`,
  );
  return r && r.vesting_shares ? (r.vesting_fund_pixa / 1e3) / (r.vesting_shares / 1e6) : 1;
}

/** Compute every daily metric for one closed day (and lagged ones for earlier days). */
export async function computeDay(db: D1Database, cfg: TowerConfig, day: number, ingested: number, wallNow = nowSec(), only?: string) {
  const done: string[] = [];
  for (const [id, spec] of Object.entries(DAILY)) {
    if (only && id !== only) continue;
    const target = day - (spec.lagDays ?? 0) * DAY;
    const end = target + DAY;
    const isRecent = wallNow - end < 36 * HOUR;
    if (spec.current && !isRecent) continue;
    if (spec.grain === "week" && !only) continue; // cohort metrics: refreshCohorts
    const grain = spec.grain ?? "day";
    const rows = await spec.fn({ db, cfg, day: target, end, ingested, isRecent });
    if (rows === null) continue;
    const bucket = bucketStart(target, grain);
    await replaceBucket(db, id, grain, bucket, rows.map((r) => ({ dim: r.dim ?? "", value: r.value, extra: r.extra })));
    done.push(id);
  }
  return done;
}

/** Weekly cohort metrics are recomputed for the last N weeks, since their accounts keep reaching milestones. */
async function refreshCohorts(db: D1Database, cfg: TowerConfig, ingested: number, weeks = 13) {
  const thisWeek = bucketStart(ingested, "week");
  for (let i = 0; i < weeks; i++) {
    const week = thisWeek - i * 7 * DAY;
    for (const id of ["onboarding_funnel", "cohort_retention", "time_to_first_reward_median"]) {
      const rows = await DAILY[id].fn({ db, cfg, day: week, end: week + 7 * DAY, ingested, isRecent: true });
      if (rows) await replaceBucket(db, id, "week", week, rows.map((r) => ({ dim: r.dim ?? "", value: r.value, extra: r.extra })));
    }
  }
}

/** Daily rollup with catch-up, up to `maxDays` closed days per run. */
export async function runDaily(db: D1Database, cfg: TowerConfig, opts: { maxDays?: number; now?: number } = {}) {
  const ingested = await ingestedTime(db);
  if (!ingested) return { days: 0 };
  let last = await getState(db, "day");
  if (last === null) {
    const g = await genesisTime(db);
    if (!g) return { days: 0 };
    last = bucketStart(g, "day") - DAY;
  }
  let days = 0;
  for (let d = last + DAY; d + DAY <= ingested && days < (opts.maxDays ?? 7); d += DAY) {
    await computeDay(db, cfg, d, ingested, opts.now);
    await setState(db, "day", d);
    days++;
  }
  if (days > 0) await refreshCohorts(db, cfg, ingested);
  return { days };
}

/** Recompute one metric (or all SQL metrics) over a time range, e.g. after a definition change. */
export async function recompute(db: D1Database, cfg: TowerConfig, from: number, to: number, metric?: string) {
  const def = metric ? METRIC_BY_ID.get(metric) : undefined;
  if (metric && !def) throw new Error(`unknown metric ${metric}`);
  let n = 0;
  if (!def || def.kind === "counter" || def.kind === "range") {
    const defs = def ? [def] : METRICS.filter((m) => m.kind === "counter" || m.kind === "range");
    for (let h = bucketStart(from, "hour"); h < to; h += HOUR) {
      const hourDefs = defs.filter((d) => d.grains.includes("hour"));
      if (hourDefs.length) {
        const rows = await runSqlMetrics(db, cfg, hourDefs, "hour", h);
        await writeBuckets(db, rows, hourDefs, "hour", h);
      }
      n++;
    }
    for (const g of ["day", "week", "month"] as const) {
      for (let b = bucketStart(from, g); b < to; b = bucketEnd(b, g)) await computeAggregate(db, cfg, g, b);
    }
  }
  if (!def || def.kind === "daily") {
    const ingested = (await ingestedTime(db)) ?? to;
    for (let d = bucketStart(from, "day"); d < to && d + DAY <= ingested; d += DAY) {
      await computeDay(db, cfg, d, ingested, undefined, def?.id);
      n++;
    }
  }
  return { buckets: n };
}

/** Compact series for the API. */
export async function series(db: D1Database, metric: string, grain: Grain | "snap", from: number, to: number, dim?: string, limit = 2000) {
  const params: unknown[] = [metric, grain, from, to];
  let where = `metric = ? AND grain = ? AND bucket >= ? AND bucket < ?`;
  if (dim !== undefined) {
    where += ` AND dim = ?`;
    params.push(dim);
  }
  return all<{ bucket: number; dim: string; value: number | null; extra: string | null }>(
    db, `SELECT bucket, dim, value, extra FROM metric_rollup WHERE ${where} ORDER BY bucket ASC, dim ASC LIMIT ${Math.min(limit, 10000)}`, ...params,
  );
}

