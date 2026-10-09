// Public /v1 routes and admin routes. Every public route reads rollups, snapshots, KV or an indexed
// lookup with a LIMIT: D1 runs one query at a time, so the API must never stall ingestion.

import {
  all, bucketStart, DAY, first, gini, METRICS, METRIC_BY_ID, nakamoto, parseTimeArg, PXP_BUCKETS, pxpBucket, run, series, type Grain,
} from "@tower/core";
import { verifyAdmin } from "./access";
import { bad, enumArg, HttpError, intArg, json, notFound, readJson, Router, type Meta, type RouteCtx } from "./http";

export interface ApiEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  CORE?: Fetcher & {
    scannerStatus(): Promise<unknown>;
    scannerPause(): Promise<unknown>;
    scannerResume(): Promise<unknown>;
    scannerRewind(block: number): Promise<unknown>;
    runNow(job: "snapshot" | "hourly" | "daily"): Promise<unknown>;
  };
  JOBS?: Queue<unknown>;
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  STALE_RED_BLOCKS?: string;
}

type Ctx = RouteCtx<ApiEnv>;
const GRAINS = ["hour", "day", "week", "month"] as const;
const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ meta

export async function meta(env: ApiEnv, extra: Record<string, unknown> = {}): Promise<Meta> {
  const r = await first<{ block: number; block_ts: number; lib: number | null }>(
    env.DB,
    `SELECT c.block, c.block_ts, (SELECT lib FROM chain_snapshots ORDER BY ts DESC LIMIT 1) AS lib FROM cursor c WHERE c.name = 'scanner'`,
  );
  return {
    as_of_block: r?.block ?? null,
    as_of_time: r?.block_ts ? new Date(r.block_ts * 1000).toISOString() : null,
    generated_at: new Date().toISOString(),
    ingest_lag_blocks: r && r.lib ? Math.max(0, r.lib - r.block) : null,
    ...extra,
  };
}

function timeRange(url: URL, grain: Grain | "snap", defaultSpan: number): { from: number; to: number } {
  const to = parseTimeArg(url.searchParams.get("to")) ?? now() + 3600;
  const from = parseTimeArg(url.searchParams.get("from")) ?? to - defaultSpan;
  if (from >= to) throw bad("bad_range", "from must be before to");
  void grain;
  return { from, to };
}

const DEFAULT_SPAN: Record<Grain, number> = { hour: 7 * DAY, day: 90 * DAY, week: 365 * DAY, month: 5 * 365 * DAY };

function parseExtra(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function windowArg(url: URL): Promise<number> {
  const w = enumArg(url, "window", ["24h", "7d", "30d", "90d"] as const, "7d");
  return { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY }[w];
}

async function ingestedTs(env: ApiEnv): Promise<number> {
  const r = await first<{ block_ts: number }>(env.DB, `SELECT block_ts FROM cursor WHERE name = 'scanner'`);
  return r?.block_ts ?? now();
}

async function prices(env: ApiEnv): Promise<{ vestsToPixa: number; pixaPerPxs: number }> {
  const r = await first<{ vesting_fund_pixa: number; vesting_shares: number; feed_base: number; feed_quote: number }>(
    env.DB, `SELECT vesting_fund_pixa, vesting_shares, feed_base, feed_quote FROM chain_snapshots ORDER BY ts DESC LIMIT 1`,
  );
  return {
    vestsToPixa: r && r.vesting_shares ? (r.vesting_fund_pixa / 1e3) / (r.vesting_shares / 1e6) : 1,
    pixaPerPxs: r && r.feed_base ? r.feed_quote / r.feed_base : 0,
  };
}

/** Latest value of each gauge, read at the metric's own finest grain (hourly gauges at hour, daily ones at day). */
async function latestGauges(env: ApiEnv, metrics: string[]): Promise<Record<string, { dim: string; value: number | null; extra: unknown; bucket: number }[]>> {
  const out: Record<string, { dim: string; value: number | null; extra: unknown; bucket: number }[]> = {};
  const byGrain = new Map<string, string[]>();
  for (const m of metrics) {
    const g = METRIC_BY_ID.get(m)?.grains[0] ?? "hour";
    byGrain.set(g, [...(byGrain.get(g) ?? []), m]);
  }
  for (const [grain, list] of byGrain) {
    const placeholders = list.map(() => "?").join(",");
    const rows = await all<{ metric: string; dim: string; value: number | null; extra: string | null; bucket: number }>(
      env.DB,
      `SELECT m.metric, m.dim, m.value, m.extra, m.bucket FROM metric_rollup m
       JOIN (SELECT metric, MAX(bucket) AS b FROM metric_rollup WHERE grain = ? AND metric IN (${placeholders}) GROUP BY metric) l
         ON l.metric = m.metric AND l.b = m.bucket
       WHERE m.grain = ?`,
      grain, ...list, grain,
    );
    for (const r of rows) (out[r.metric] ??= []).push({ dim: r.dim, value: r.value, extra: parseExtra(r.extra), bucket: r.bucket });
  }
  return out;
}

// ------------------------------------------------------------------ public routes

export function buildRouter(): Router<ApiEnv> {
  const r = new Router<ApiEnv>();

  r.add("GET", "/v1/status", 5, { summary: "Ingestion state: cursor, last irreversible block, lag, last snapshot, scanner state" }, async ({ request, env }) => {
    const snap = await first<{ ts: number; head_block: number; lib: number }>(env.DB, `SELECT ts, head_block, lib FROM chain_snapshots ORDER BY ts DESC LIMIT 1`);
    const rollups = await all<{ job: string; last_bucket: number; updated_at: number }>(env.DB, `SELECT job, last_bucket, updated_at FROM rollup_state`);
    let scanner: unknown = null;
    try {
      scanner = env.CORE ? await env.CORE.scannerStatus() : null;
    } catch {
      scanner = { error: "core worker unreachable" };
    }
    const m = await meta(env);
    return json(request, {
      data: {
        cursor: m.as_of_block, cursor_time: m.as_of_time, lib: snap?.lib ?? null, head_block: snap?.head_block ?? null,
        ingest_lag_blocks: m.ingest_lag_blocks, last_snapshot: snap ? new Date(snap.ts * 1000).toISOString() : null,
        rollups: Object.fromEntries(rollups.map((x) => [x.job, { last_bucket: new Date(x.last_bucket * 1000).toISOString(), updated_at: x.updated_at }])),
        scanner: redactScanner(scanner),
      },
      meta: m,
    }, 5);
  });

  r.add("GET", "/v1/overview", 30, { summary: "Current KPIs: totals, live now, activity, TPS, supply, debt ratio, feed, pending payout, 24 h rewards, governance, open alerts" }, async ({ request, env }) => {
    const cached = await env.CACHE.get("overview", "json");
    if (!cached) throw new HttpError(503, "warming_up", "no snapshot yet: the first one is written within 5 minutes of deployment");
    return json(request, { data: cached, meta: await meta(env) }, 30);
  });

  r.add("GET", "/v1/metrics", 3600, { summary: "Catalogue of every metric: id, title, unit, section, kind, grains, definition and thresholds" }, async ({ request, env }) => {
    const thresholds = await all<Record<string, unknown>>(env.DB, `SELECT metric, dim, grain, op, amber, red, window_buckets, owner, action_hint FROM thresholds WHERE enabled = 1`);
    const byMetric = new Map<string, unknown[]>();
    for (const t of thresholds) byMetric.set(String(t.metric), [...(byMetric.get(String(t.metric)) ?? []), t]);
    return json(request, {
      data: METRICS.map((m) => ({
        id: m.id, title: m.title, unit: m.unit, section: m.section, kind: m.kind, grains: m.grains, description: m.description,
        def_version: m.version, thresholds: byMetric.get(m.id) ?? [],
      })),
      meta: await meta(env),
    }, 3600);
  });

  r.add("GET", "/v1/metrics/{id}", 60, {
    summary: "A metric's series",
    query: { grain: "hour | day | week | month (default: the metric's first grain)", from: "ISO date or Unix seconds", to: "ISO date or Unix seconds", dim: "a dimension, '' for the total, '*' for all" },
  }, async ({ request, env, url, params }) => {
    const def = METRIC_BY_ID.get(params.id);
    if (!def) throw notFound(`unknown metric ${params.id}; see /v1/metrics`);
    const grain = enumArg(url, "grain", GRAINS, def.grains[0]);
    if (!def.grains.includes(grain)) throw bad("bad_grain", `${def.id} is available at: ${def.grains.join(", ")}`);
    const { from, to } = timeRange(url, grain, DEFAULT_SPAN[grain]);
    const dimArg = url.searchParams.get("dim");
    const rows = await series(env.DB, def.id, grain, from, to, dimArg === "*" ? undefined : (dimArg ?? ""), 2000);
    return json(request, {
      data: {
        metric: def.id, title: def.title, unit: def.unit, grain, from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString(),
        points: rows.map((x) => ({ t: new Date(x.bucket * 1000).toISOString(), bucket: x.bucket, dim: x.dim, value: x.value, extra: parseExtra(x.extra) })),
        truncated: rows.length >= 2000,
      },
      meta: await meta(env, { def_versions: { [def.id]: def.version } }),
    }, 60);
  });

  r.add("GET", "/v1/metrics/{id}/latest", 60, { summary: "Last value per dimension", query: { grain: "hour | day | week | month" } }, async ({ request, env, url, params }) => {
    const def = METRIC_BY_ID.get(params.id);
    if (!def) throw notFound(`unknown metric ${params.id}`);
    const grain = enumArg(url, "grain", GRAINS, def.grains[0]);
    const rows = await all<{ dim: string; bucket: number; value: number | null; extra: string | null }>(
      env.DB,
      `SELECT m.dim, m.bucket, m.value, m.extra FROM metric_rollup m
       JOIN (SELECT dim, MAX(bucket) AS b FROM metric_rollup WHERE metric = ?1 AND grain = ?2 GROUP BY dim) l ON l.dim = m.dim AND l.b = m.bucket
       WHERE m.metric = ?1 AND m.grain = ?2 ORDER BY m.dim LIMIT 500`,
      def.id, grain,
    );
    return json(request, {
      data: { metric: def.id, unit: def.unit, grain, values: rows.map((x) => ({ dim: x.dim, t: new Date(x.bucket * 1000).toISOString(), value: x.value, extra: parseExtra(x.extra) })) },
      meta: await meta(env),
    }, 60);
  });

  r.add("GET", "/v1/portals", 300, { summary: "Every portal: title, subscribers, posts, authors, controversy and downvote share over 7 and 30 days, moderation actions" }, async ({ request, env }) => {
    const t = await ingestedTs(env);
    const rows = await all<Record<string, number | string | null>>(
      env.DB,
      `SELECT a.name AS portal, c.title, c.subscribers, c.lang,
         (SELECT COUNT(*) FROM posts p WHERE p.portal = a.name AND p.kind = 'blog') AS posts,
         (SELECT COUNT(*) FROM posts p WHERE p.portal = a.name AND p.kind = 'reply') AS replies,
         (SELECT COUNT(DISTINCT author) FROM posts p WHERE p.portal = a.name AND p.kind = 'blog') AS authors,
         (SELECT SUM(controversy * (up_rshares + down_rshares)) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0) FROM posts p
            WHERE p.portal = a.name AND p.kind = 'blog' AND p.controversy IS NOT NULL AND p.created_ts >= ?1) AS controversy_7d,
         (SELECT SUM(controversy * (up_rshares + down_rshares)) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0) FROM posts p
            WHERE p.portal = a.name AND p.kind = 'blog' AND p.controversy IS NOT NULL AND p.created_ts >= ?2) AS controversy_30d,
         (SELECT SUM(down_rshares) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0) FROM posts p
            WHERE p.portal = a.name AND p.kind = 'blog' AND p.created_ts >= ?2) AS downvote_share_30d,
         (SELECT COUNT(*) FROM community_ops o WHERE o.community = a.name AND o.action IN ('mutePost','unmutePost','pinPost','unpinPost','flagPost') AND o.ts >= ?2) AS moderation_30d,
         (SELECT MAX(created_ts) FROM posts p WHERE p.portal = a.name) AS last_post_ts
       FROM accounts a LEFT JOIN communities c ON c.name = a.name WHERE a.is_portal = 1 ORDER BY posts DESC LIMIT 500`,
      t - 7 * DAY, t - 30 * DAY,
    );
    return json(request, {
      data: rows.map((x) => ({ ...x, last_post: x.last_post_ts ? new Date(Number(x.last_post_ts) * 1000).toISOString() : null })),
      meta: await meta(env, { controversy_min_votes: 5 }),
    }, 300);
  });

  r.add("GET", "/v1/posts/controversial", 300, {
    summary: "Most controversial posts: those with both upvotes and downvotes, by controversy",
    query: { portal: "portal-NNNN", kind: "blog | artwork | any (default any)", window: "24h | 7d | 30d | 90d (default 7d)", min_votes: "default 5", limit: "1-100, default 20" },
  }, async ({ request, env, url }) => {
    const span = await windowArg(url);
    const t = await ingestedTs(env);
    const kind = enumArg(url, "kind", ["blog", "artwork", "any"] as const, "any");
    const minVotes = intArg(url, "min_votes", 5, 2, 1000);
    const limit = intArg(url, "limit", 20, 1, 100);
    const portal = url.searchParams.get("portal");
    const where = [`created_ts >= ?`, `up_count + down_count >= ?`, `up_count > 0`, `down_count > 0`, kind === "any" ? `kind IN ('blog','artwork')` : `kind = ?`];
    const params: unknown[] = [t - span, minVotes];
    if (kind !== "any") params.push(kind);
    if (portal) {
      where.push(`portal = ?`);
      params.push(portal);
    }
    const rows = await all<Record<string, unknown>>(
      env.DB,
      `SELECT author, permlink, kind, portal, category, title, created_ts, up_count, down_count, up_rshares, down_rshares,
         2.0 * MIN(up_rshares, down_rshares) / NULLIF(up_rshares + down_rshares, 0) AS controversy,
         2.0 * MIN(up_count, down_count) / NULLIF(up_count + down_count, 0) AS controversy_count, paid, total_payout_pxs, pending_payout_pxs
       FROM posts WHERE ${where.join(" AND ")} ORDER BY controversy DESC, up_rshares + down_rshares DESC LIMIT ${limit}`,
      ...params,
    );
    const app = "https://pixagram.com";
    return json(request, {
      data: rows.map((p) => ({
        ...p, created: new Date(Number(p.created_ts) * 1000).toISOString(),
        url: `${app}/${p.category ?? p.portal ?? "post"}/@${p.author}/${p.permlink}`,
        up_rshares: String(p.up_rshares), down_rshares: String(p.down_rshares),
      })),
      meta: await meta(env, { window_seconds: span, min_votes: minVotes }),
    }, 300);
  });

  r.add("GET", "/v1/distribution/pxp", 3600, { summary: "User accounts per Pixa Power bucket, Gini and Nakamoto coefficient", query: { include_system: "true to add system and portal accounts" } }, async ({ request, env, url }) => {
    const include = url.searchParams.get("include_system") === "true";
    const p = await prices(env);
    const rows = await all<{ account: string; vests: number; eff: number; is_system: number; is_portal: number }>(
      env.DB,
      `SELECT b.account, b.vests, b.vests - COALESCE(b.delegated_out, 0) + COALESCE(b.received, 0) AS eff, COALESCE(a.is_system, 0) AS is_system, COALESCE(a.is_portal, 0) AS is_portal
       FROM balances b LEFT JOIN accounts a ON a.name = b.account ${include ? "" : "WHERE COALESCE(a.is_system,0) = 0 AND COALESCE(a.is_portal,0) = 0"}`,
    );
    const own = new Map(PXP_BUCKETS.map((b) => [b.label, { accounts: 0, pxp: 0 }]));
    const eff = new Map(PXP_BUCKETS.map((b) => [b.label, { accounts: 0, pxp: 0 }]));
    for (const x of rows) {
      const o = (x.vests / 1e6) * p.vestsToPixa;
      const e = (x.eff / 1e6) * p.vestsToPixa;
      const bo = own.get(pxpBucket(o))!;
      bo.accounts++;
      bo.pxp += o;
      const be = eff.get(pxpBucket(e))!;
      be.accounts++;
      be.pxp += e;
    }
    return json(request, {
      data: {
        buckets: PXP_BUCKETS.map((b) => ({ bucket: b.label, own: own.get(b.label), effective: eff.get(b.label) })),
        gini: gini(rows.map((x) => x.vests)), nakamoto_50: nakamoto(rows.map((x) => x.vests), 0.5), accounts: rows.length,
        include_system: include, vests_to_pixa: p.vestsToPixa,
      },
      meta: await meta(env),
    }, 3600);
  });

  r.add("GET", "/v1/feed", 300, { summary: "Median price feed history and each witness's published feed", query: { grain: "hour | day | week | month (default day)", from: "", to: "" } }, async ({ request, env, url }) => {
    const grain = enumArg(url, "grain", GRAINS, "day");
    const { from, to } = timeRange(url, grain, DEFAULT_SPAN[grain]);
    const size = { hour: 3600, day: 86400, week: 604800, month: 2592000 }[grain];
    const published = await all<{ bucket: number; witness: string; price: number; n: number }>(
      env.DB,
      `SELECT (ts / ?1) * ?1 AS bucket, witness, AVG(quote * 1.0 / base) AS price, COUNT(*) AS n FROM feeds
       WHERE ts >= ?2 AND ts < ?3 GROUP BY bucket, witness ORDER BY bucket LIMIT 5000`,
      size, from, to,
    );
    const median = await series(env.DB, "feed_price", grain, from, to, "");
    return json(request, {
      data: {
        unit: "PIXA per PXS", grain,
        median: median.map((x) => ({ t: new Date(x.bucket * 1000).toISOString(), value: x.value })),
        published: published.map((x) => ({ t: new Date(x.bucket * 1000).toISOString(), witness: x.witness, price: x.price, publishes: x.n })),
        note: "median: the chain's median history price as snapshotted every 5 minutes since the Tower started; published: every feed_publish since genesis",
      },
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/rewards", 300, { summary: "Rewards paid by type over a window, in each asset and PIXA equivalent, plus pending payout", query: { window: "24h | 7d | 30d | 90d (default 24h)" } }, async ({ request, env, url }) => {
    if (!url.searchParams.get("window")) url.searchParams.set("window", "24h");
    const span = await windowArg(url);
    const t = await ingestedTs(env);
    const p = await prices(env);
    const rows = await all<{ type: string; pixa: number; pxs: number; vests: number; n: number }>(
      env.DB,
      `SELECT type, SUM(pixa) AS pixa, SUM(pxs) AS pxs, SUM(vests) AS vests, COUNT(*) AS n FROM rewards WHERE ts >= ? AND ts < ? GROUP BY type`,
      t - span, t + 1,
    );
    const pending = await first<{ v: number; n: number }>(env.DB, `SELECT COALESCE(SUM(pending_payout_pxs), 0) AS v, COUNT(*) AS n FROM posts WHERE paid = 0 AND pending_payout_pxs > 0`);
    const posts = await first<{ n: number; pxs: number }>(env.DB, `SELECT COUNT(*) AS n, COALESCE(SUM(total_payout_pxs), 0) AS pxs FROM posts WHERE paid = 1 AND payout_ts >= ?`, t - span);
    return json(request, {
      data: {
        window_seconds: span,
        by_type: rows.map((x) => ({
          type: x.type, payments: x.n, pixa: x.pixa / 1e3, pxs: x.pxs / 1e3, vests: x.vests / 1e6,
          pixa_equivalent: x.pixa / 1e3 + (x.pxs / 1e3) * p.pixaPerPxs + (x.vests / 1e6) * p.vestsToPixa,
        })),
        posts_paid: posts?.n ?? 0, posts_paid_value_pxs: (posts?.pxs ?? 0) / 1e3,
        pending_payout_pxs: (pending?.v ?? 0) / 1e3, pending_posts: pending?.n ?? 0,
        prices: p,
      },
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/witnesses", 60, { summary: "Witnesses ranked by votes with scorecard: missed blocks, feed age and deviation, version, key" }, async ({ request, env }) => {
    const latest = await first<{ ts: number }>(env.DB, `SELECT MAX(ts) AS ts FROM witness_snapshots`);
    if (!latest?.ts) return json(request, { data: [], meta: await meta(env) }, 60);
    const p = await prices(env);
    const t = await ingestedTs(env);
    const rows = await all<Record<string, any>>(
      env.DB,
      `SELECT s.*, (SELECT COUNT(*) FROM witness_missed m WHERE m.witness = s.witness AND m.ts >= ?2) AS missed_24h,
              (SELECT COUNT(*) FROM blocks b WHERE b.witness = s.witness AND b.ts >= ?2) AS produced_24h,
              (SELECT COUNT(*) FROM witness_votes v WHERE v.witness = s.witness) AS voters
       FROM witness_snapshots s WHERE s.ts = ?1 ORDER BY CAST(s.votes AS REAL) DESC`,
      latest.ts, t - DAY,
    );
    const feeds = rows.filter((w) => w.feed_base).map((w) => w.feed_quote / w.feed_base).sort((a, b) => a - b);
    const med = feeds.length ? feeds[Math.floor(feeds.length / 2)] : null;
    return json(request, {
      data: rows.map((w, i) => ({
        witness: w.witness, position: i + 1, elected: w.rank !== null, votes_pxp: (Number(w.votes) / 1e6) * p.vestsToPixa, voters: w.voters,
        produced_24h: w.produced_24h, missed_24h: w.missed_24h, total_missed: w.total_missed,
        miss_rate_24h: w.produced_24h + w.missed_24h ? w.missed_24h / (w.produced_24h + w.missed_24h) : null,
        feed_pixa_per_pxs: w.feed_base ? w.feed_quote / w.feed_base : null,
        feed_age_hours: w.last_feed_ts ? (latest.ts - w.last_feed_ts) / 3600 : null,
        feed_deviation: w.feed_base && med ? w.feed_quote / w.feed_base / med - 1 : null,
        running_version: w.running_version, hf_version_vote: w.hf_version_vote, signing_key: w.signing_key,
        disabled: /^PIX1111111111111111111111111111111114T1Anm$/.test(w.signing_key ?? ""), url: w.url,
        account_creation_fee_pixa: w.creation_fee / 1e3, maximum_block_size: w.max_block_size,
      })),
      meta: await meta(env, { snapshot: new Date(latest.ts * 1000).toISOString() }),
    }, 60);
  });

  r.add("GET", "/v1/witnesses/{name}/history", 300, { summary: "A witness's votes and rank over time, its vote log with voter stake and account age, parameter changes", query: { from: "", to: "" } }, async ({ request, env, url, params }) => {
    const { from, to } = timeRange(url, "day", 30 * DAY);
    const p = await prices(env);
    const snaps = await all<{ ts: number; rank: number | null; votes: string; total_missed: number }>(
      env.DB,
      `SELECT ts, rank, votes, total_missed FROM witness_snapshots WHERE witness = ?1 AND ts IN (
         SELECT MAX(ts) FROM witness_snapshots WHERE witness = ?1 AND ts >= ?2 AND ts < ?3 GROUP BY ts / 3600) ORDER BY ts LIMIT 2000`,
      params.name, from, to,
    );
    const votes = await all<Record<string, unknown>>(
      env.DB, `SELECT block, ts, voter, approve, voter_vests, voter_age_days FROM witness_votes_log WHERE witness = ? ORDER BY block DESC LIMIT 500`, params.name,
    );
    const changes = await all<Record<string, unknown>>(
      env.DB, `SELECT block, ts, op, field, old_value, new_value FROM witness_events WHERE witness = ? ORDER BY block DESC LIMIT 200`, params.name,
    );
    if (!snaps.length && !votes.length && !changes.length) throw notFound(`no data for witness ${params.name}`);
    return json(request, {
      data: {
        witness: params.name,
        series: snaps.map((s) => ({ t: new Date(s.ts * 1000).toISOString(), rank: s.rank, votes_pxp: (Number(s.votes) / 1e6) * p.vestsToPixa, total_missed: s.total_missed })),
        vote_log: votes.map((v) => ({ ...v, t: new Date(Number(v.ts) * 1000).toISOString(), voter_pxp: v.voter_vests ? (Number(v.voter_vests) / 1e6) * p.vestsToPixa : null })),
        parameter_changes: changes,
      },
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/governance", 300, { summary: "Governance health: cost of capture, free seats, bench, participation, proxies, version readiness, shared keys, treasury invariant, recent fresh-stake votes" }, async ({ request, env }) => {
    const g = await latestGauges(env, [
      "capture_cost", "free_witness_seats", "witness_bench", "witness_count", "vote_margin", "hf_readiness", "shared_signing_keys",
      "witness_vote_participation", "proxy_top_share",
    ]);
    const t = await ingestedTs(env);
    const fresh = await all<Record<string, unknown>>(
      env.DB,
      `SELECT block, ts, voter, witness, voter_vests, voter_age_days FROM witness_votes_log WHERE approve = 1 AND voter_age_days < 7 AND ts >= ? ORDER BY block DESC LIMIT 50`,
      t - 30 * DAY,
    );
    const invariant = await all<Record<string, unknown>>(
      env.DB, `SELECT block, ts, subject, detail FROM invariant_events WHERE kind = 'restricted_account_voted' ORDER BY block DESC LIMIT 20`,
    );
    const pick = (k: string) => (g[k] ?? []).map((x) => ({ dim: x.dim, value: x.value, extra: x.extra }));
    return json(request, {
      data: {
        capture_cost_pxp: pick("capture_cost"),
        free_witness_seats: pick("free_witness_seats")[0]?.value ?? null,
        bench: pick("witness_bench")[0]?.value ?? null,
        witnesses: pick("witness_count")[0] ?? null,
        vote_margin_pxp: pick("vote_margin")[0]?.value ?? null,
        hf_readiness: pick("hf_readiness")[0] ?? null,
        shared_signing_keys: pick("shared_signing_keys")[0] ?? null,
        witness_vote_participation: pick("witness_vote_participation")[0]?.value ?? null,
        proxy_top_share: pick("proxy_top_share")[0] ?? null,
        fresh_stake_votes_30d: fresh,
        treasury_invariant: { violations: invariant.length, events: invariant },
      },
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/dpf", 300, { summary: "Decentralized Pixa Fund: proposals with approval against the return proposal, runway, payouts by receiver" }, async ({ request, env }) => {
    const proposals = await all<Record<string, any>>(env.DB, `SELECT * FROM proposals ORDER BY id`);
    const ret = proposals.find((p) => p.id === 2);
    const g = await latestGauges(env, ["dpf_balance", "dpf_runway"]);
    const paid = await all<{ account: string; pxs: number; n: number }>(
      env.DB, `SELECT account, SUM(pxs) AS pxs, COUNT(*) AS n FROM rewards WHERE type = 'dpf' GROUP BY account ORDER BY pxs DESC LIMIT 100`,
    );
    const fundAccount = ret?.receiver ?? "pixa.omnibus";
    // Payments to the fund itself come from the return proposal: they go back into the fund, not out.
    const total = paid.filter((x) => x.account !== fundAccount).reduce((s, x) => s + x.pxs, 0);
    return json(request, {
      data: {
        balance_pxs: g.dpf_balance?.[0]?.value ?? null,
        runway_days: g.dpf_runway?.[0]?.value ?? null,
        return_proposal_id: 2,
        proposals: proposals.map((p) => ({
          id: p.id, creator: p.creator, receiver: p.receiver, subject: p.subject, status: p.status, daily_pay_pxs: p.daily_pay / 1e3,
          start: new Date(p.start_ts * 1000).toISOString(), end: new Date(p.end_ts * 1000).toISOString(),
          total_votes_vests: Number(p.total_votes) / 1e6,
          above_return: ret && p.id !== 2 ? Number(p.total_votes) > Number(ret.total_votes) : null,
          return_margin: ret && Number(ret.total_votes) && p.id !== 2 ? Number(p.total_votes) / Number(ret.total_votes) - 1 : null,
        })),
        paid_by_receiver: paid.map((x) => ({
          receiver: x.account, pxs: x.pxs / 1e3, payments: x.n,
          returned_to_fund: x.account === fundAccount, share: x.account !== fundAccount && total ? x.pxs / total : null,
        })),
      },
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/funnel", 3600, { summary: "Onboarding funnel and retention of a weekly creation cohort", query: { cohort: "a date inside the cohort week (ISO), default: 4 weeks ago" } }, async ({ request, env, url }) => {
    const t = await ingestedTs(env);
    const at = parseTimeArg(url.searchParams.get("cohort")) ?? t - 28 * DAY;
    const week = bucketStart(at, "week");
    const rows = await all<{ metric: string; dim: string; value: number | null; extra: string | null }>(
      env.DB,
      `SELECT metric, dim, value, extra FROM metric_rollup WHERE grain = 'week' AND bucket = ? AND metric IN ('onboarding_funnel','cohort_retention','time_to_first_reward_median')`,
      week,
    );
    const order = ["created", "profile", "follow", "vote", "artwork", "reward", "claim", "power_up"];
    const funnel = rows.filter((x) => x.metric === "onboarding_funnel").sort((a, b) => order.indexOf(a.dim) - order.indexOf(b.dim));
    const created = funnel.find((x) => x.dim === "created")?.value ?? 0;
    return json(request, {
      data: {
        cohort_week: new Date(week * 1000).toISOString().slice(0, 10),
        stages: funnel.map((x) => ({ stage: x.dim, accounts: x.value, share: created ? (x.value ?? 0) / created : null })),
        retention: rows.filter((x) => x.metric === "cohort_retention").map((x) => ({ week: x.dim, share: x.value, detail: parseExtra(x.extra) })),
        median_days_to_first_reward: rows.find((x) => x.metric === "time_to_first_reward_median")?.value ?? null,
      },
      meta: await meta(env),
    }, 3600);
  });

  r.add("GET", "/v1/alerts", 30, { summary: "Alerts", query: { state: "open | acknowledged | closed | all (default open)", severity: "amber | red", metric: "", limit: "1-500, default 100" } }, async ({ request, env, url }) => {
    const state = enumArg(url, "state", ["open", "acknowledged", "closed", "all"] as const, "open");
    const where: string[] = [];
    const params: unknown[] = [];
    if (state === "open") where.push(`state <> 'closed'`);
    else if (state !== "all") {
      where.push(`state = ?`);
      params.push(state);
    }
    const sev = url.searchParams.get("severity");
    if (sev) {
      where.push(`severity = ?`);
      params.push(enumArg(url, "severity", ["amber", "red"] as const, "amber"));
    }
    const metric = url.searchParams.get("metric");
    if (metric) {
      where.push(`metric = ?`);
      params.push(metric);
    }
    const limit = intArg(url, "limit", 100, 1, 500);
    const rows = await all<Record<string, any>>(
      env.DB,
      `SELECT id, key, metric, dim, severity, state, opened_ts, updated_ts, closed_ts, value, threshold, title, note FROM alerts
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE severity WHEN 'red' THEN 0 ELSE 1 END, opened_ts DESC LIMIT ${limit}`,
      ...params,
    );
    return json(request, { data: rows.map(alertOut), meta: await meta(env) }, 30);
  });

  r.add("GET", "/v1/alerts/{id}", 30, { summary: "One alert with its evidence and the actions logged against it" }, async ({ request, env, params }) => {
    const a = await first<Record<string, any>>(env.DB, `SELECT * FROM alerts WHERE id = ?`, Number(params.id));
    if (!a) throw notFound();
    const actions = await all<Record<string, unknown>>(env.DB, `SELECT * FROM actions WHERE alert_id = ? ORDER BY ts`, a.id);
    return json(request, { data: { ...alertOut(a), evidence: parseExtra(a.evidence), actions }, meta: await meta(env) }, 30);
  });

  r.add("GET", "/v1/actions", 300, { summary: "Action log with each metric's value 7 and 30 days after the action", query: { limit: "1-500" } }, async ({ request, env, url }) => {
    const limit = intArg(url, "limit", 100, 1, 500);
    const rows = await all<Record<string, any>>(env.DB, `SELECT * FROM actions ORDER BY ts DESC LIMIT ${limit}`);
    return json(request, {
      data: rows.map((a) => ({ ...a, t: new Date(a.ts * 1000).toISOString(), moved_7d: a.review_7d !== null && a.value_at_action !== null ? a.review_7d - a.value_at_action : null })),
      meta: await meta(env),
    }, 300);
  });

  r.add("GET", "/v1/accounts/{name}", 60, { summary: "Public facts the Tower holds about an account: creation, milestones, activity by day, balances" }, async ({ request, env, params }) => {
    const a = await first<Record<string, any>>(env.DB, `SELECT * FROM accounts WHERE name = ?`, params.name);
    if (!a) throw notFound(`unknown account ${params.name}`);
    const b = await first<Record<string, any>>(env.DB, `SELECT * FROM balances WHERE account = ?`, params.name);
    const t = await ingestedTs(env);
    const activity = await all<{ day: number; ops: number }>(
      env.DB, `SELECT (ts / 86400) * 86400 AS day, COUNT(*) AS ops FROM op_log WHERE account = ? AND ts >= ? GROUP BY day ORDER BY day`, params.name, t - 90 * DAY,
    );
    const posts = await first<Record<string, number>>(
      env.DB,
      `SELECT SUM(kind = 'artwork') AS artworks, SUM(kind = 'blog') AS blog_posts, SUM(kind = 'reply') AS replies FROM posts WHERE author = ?`, params.name,
    );
    const iso = (x: number | null) => (x ? new Date(x * 1000).toISOString() : null);
    const p = await prices(env);
    return json(request, {
      data: {
        name: a.name, created: iso(a.created_ts), created_block: a.created_block, creator: a.creator, create_op: a.create_op,
        system: !!a.is_system, portal: !!a.is_portal, recovery_account: b?.recovery_account ?? a.recovery_account,
        milestones: {
          profile: iso(a.profile_set_ts), follow: iso(a.first_follow_ts), vote: iso(a.first_vote_ts), post: iso(a.first_post_ts),
          artwork: iso(a.first_artwork_ts), reward: iso(a.first_reward_ts), claim: iso(a.first_claim_ts), power_up: iso(a.first_powerup_ts),
        },
        last_active: iso(a.last_active_ts),
        content: posts,
        balances: b ? {
          pixa: b.pixa / 1e3, pxs: b.pxs / 1e3, savings_pixa: b.savings_pixa / 1e3, savings_pxs: b.savings_pxs / 1e3,
          pxp: (b.vests / 1e6) * p.vestsToPixa, delegated_out_pxp: (b.delegated_out / 1e6) * p.vestsToPixa, received_pxp: (b.received / 1e6) * p.vestsToPixa,
          updated: iso(b.updated_ts),
        } : null,
        activity_90d: activity.map((x) => ({ day: new Date(x.day * 1000).toISOString().slice(0, 10), ops: x.ops })),
      },
      meta: await meta(env),
    }, 60);
  });

  // ------------------------------------------------------------------ admin

  const admin = async (ctx: Ctx) => {
    const id = await verifyAdmin(ctx.request, ctx.env);
    if (!id) throw new HttpError(401, "unauthorized", "admin routes need a Cloudflare Access identity");
    return id;
  };

  r.add("PUT", "/v1/admin/thresholds/{metric}", 0, {
    summary: "Create or change a threshold",
    body: { dim: "'' total, '*' each dimension, or one dimension", grain: "hour|day|week|month", op: "gt|lt|abs_gt|abs_change_pct", amber: "number|null", red: "number|null", window_buckets: "integer ≥ 1", owner: "", action_hint: "", enabled: "boolean" },
  }, async (ctx) => {
    await admin(ctx);
    const def = METRIC_BY_ID.get(ctx.params.metric);
    if (!def) throw notFound(`unknown metric ${ctx.params.metric}`);
    const b = await readJson<Record<string, unknown>>(ctx.request);
    const grain = String(b.grain ?? def.grains[0]);
    if (!def.grains.includes(grain as Grain)) throw bad("bad_grain", `grain must be one of ${def.grains.join(", ")}`);
    const op = String(b.op ?? "gt");
    if (!["gt", "lt", "abs_gt", "abs_change_pct"].includes(op)) throw bad("bad_op", "op must be gt, lt, abs_gt or abs_change_pct");
    const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : (() => { throw bad("bad_band", "amber and red must be numbers or null"); })());
    await run(
      ctx.env.DB,
      `INSERT INTO thresholds (metric, dim, grain, op, amber, red, window_buckets, owner, action_hint, enabled, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(metric, dim, grain) DO UPDATE SET op=excluded.op, amber=excluded.amber, red=excluded.red, window_buckets=excluded.window_buckets,
         owner=excluded.owner, action_hint=excluded.action_hint, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      def.id, String(b.dim ?? ""), grain, op, numOrNull(b.amber), numOrNull(b.red), Math.max(1, Math.floor(Number(b.window_buckets ?? 1))),
      b.owner ? String(b.owner).slice(0, 100) : null, b.action_hint ? String(b.action_hint).slice(0, 500) : null, b.enabled === false ? 0 : 1, now(),
    );
    const row = await first(ctx.env.DB, `SELECT * FROM thresholds WHERE metric = ? AND dim = ? AND grain = ?`, def.id, String(b.dim ?? ""), grain);
    return json(ctx.request, { data: row }, 0);
  }, true);

  r.add("DELETE", "/v1/admin/thresholds/{metric}", 0, { summary: "Remove a threshold", query: { dim: "", grain: "" } }, async (ctx) => {
    await admin(ctx);
    const n = await run(ctx.env.DB, `DELETE FROM thresholds WHERE metric = ? AND dim = ? AND grain = ?`,
      ctx.params.metric, ctx.url.searchParams.get("dim") ?? "", ctx.url.searchParams.get("grain") ?? "hour");
    return json(ctx.request, { data: { deleted: n } }, 0);
  }, true);

  r.add("POST", "/v1/admin/actions", 0, {
    summary: "Log an action, optionally linked to an alert",
    body: { alert_id: "integer", lever: "e.g. witness_vote, parameter, proposal, moderation, app_change", description: "", tx_id: "", metric: "metric to review 7 and 30 days later", dim: "" },
  }, async (ctx) => {
    const who = await admin(ctx);
    const b = await readJson<Record<string, unknown>>(ctx.request);
    if (!b.description) throw bad("missing", "description is required");
    let metric = b.metric ? String(b.metric) : null;
    let dim = b.dim !== undefined ? String(b.dim) : "";
    if (b.alert_id && !metric) {
      const a = await first<{ metric: string | null; dim: string | null }>(ctx.env.DB, `SELECT metric, dim FROM alerts WHERE id = ?`, Number(b.alert_id));
      metric = a?.metric ?? null;
      dim = a?.dim ?? "";
    }
    if (metric && !METRIC_BY_ID.has(metric)) throw bad("bad_metric", `unknown metric ${metric}`);
    const current = metric
      ? await first<{ value: number }>(ctx.env.DB, `SELECT value FROM metric_rollup WHERE metric = ? AND dim = ? ORDER BY bucket DESC LIMIT 1`, metric, dim)
      : null;
    const res = await ctx.env.DB
      .prepare(`INSERT INTO actions (alert_id, ts, actor, lever, description, tx_id, metric, dim, value_at_action) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
      .bind(b.alert_id ? Number(b.alert_id) : null, now(), who.subject, String(b.lever ?? "").slice(0, 64), String(b.description).slice(0, 2000),
        b.tx_id ? String(b.tx_id).slice(0, 64) : null, metric, dim, current?.value ?? null)
      .first<{ id: number }>();
    return json(ctx.request, { data: { id: res?.id, metric, dim, value_at_action: current?.value ?? null } }, 0, 201);
  }, true);

  r.add("POST", "/v1/admin/alerts/{id}/ack", 0, { summary: "Acknowledge or close an alert with a note", body: { note: "", close: "boolean" } }, async (ctx) => {
    const who = await admin(ctx);
    const b = await readJson<{ note?: string; close?: boolean }>(ctx.request);
    const state = b.close ? "closed" : "acknowledged";
    const n = await run(ctx.env.DB,
      `UPDATE alerts SET state = ?, note = ?, updated_ts = ?, closed_ts = CASE WHEN ? = 'closed' THEN ? ELSE closed_ts END WHERE id = ?`,
      state, `${who.subject}: ${String(b.note ?? "").slice(0, 1000)}`, now(), state, now(), Number(ctx.params.id));
    if (!n) throw notFound();
    return json(ctx.request, { data: { id: Number(ctx.params.id), state } }, 0);
  }, true);

  r.add("POST", "/v1/admin/recompute", 0, { summary: "Queue a recompute of one metric, or all, over a time range", body: { metric: "optional", from: "ISO or Unix", to: "ISO or Unix" } }, async (ctx) => {
    await admin(ctx);
    const b = await readJson<{ metric?: string; from?: string | number; to?: string | number }>(ctx.request);
    const from = parseTimeArg(b.from === undefined ? null : String(b.from));
    const to = parseTimeArg(b.to === undefined ? null : String(b.to)) ?? now();
    if (from === null || from >= to) throw bad("bad_range", "from (required) must be before to");
    if (b.metric && !METRIC_BY_ID.has(b.metric)) throw bad("bad_metric", `unknown metric ${b.metric}`);
    if (!ctx.env.JOBS) throw new HttpError(501, "no_queue", "the JOBS queue is not bound");
    await ctx.env.JOBS.send({ type: "recompute", from, to, metric: b.metric });
    return json(ctx.request, { data: { queued: true, from, to, metric: b.metric ?? null } }, 0, 202);
  }, true);

  r.add("POST", "/v1/admin/replay", 0, { summary: "Queue a block range for re-ingestion (the cursor does not move)", body: { from: "block", to: "block" } }, async (ctx) => {
    await admin(ctx);
    const b = await readJson<{ from?: number; to?: number }>(ctx.request);
    const from = Number(b.from);
    const to = Number(b.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw bad("bad_range", "from and to must be block numbers, from ≤ to");
    if (!ctx.env.JOBS) throw new HttpError(501, "no_queue", "the JOBS queue is not bound");
    await ctx.env.JOBS.send({ type: "replay", from, to });
    return json(ctx.request, { data: { queued: true, from, to } }, 0, 202);
  }, true);

  r.add("GET", "/v1/admin/scanner", 0, { summary: "Scanner state, including the last error" }, async (ctx) => {
    await admin(ctx);
    if (!ctx.env.CORE) throw new HttpError(501, "no_core", "CORE service binding missing");
    return json(ctx.request, { data: await ctx.env.CORE.scannerStatus() }, 0);
  }, true);

  r.add("POST", "/v1/admin/scanner/{action}", 0, { summary: "pause | resume | rewind (body {block}) | snapshot | hourly | daily" }, async (ctx) => {
    await admin(ctx);
    const core = ctx.env.CORE;
    if (!core) throw new HttpError(501, "no_core", "CORE service binding missing");
    switch (ctx.params.action) {
      case "pause":
        return json(ctx.request, { data: await core.scannerPause() }, 0);
      case "resume":
        return json(ctx.request, { data: await core.scannerResume() }, 0);
      case "rewind": {
        const b = await readJson<{ block?: number }>(ctx.request);
        if (!Number.isInteger(b.block) || (b.block ?? -1) < 0) throw bad("bad_block", "block must be a non-negative integer");
        return json(ctx.request, { data: await core.scannerRewind(b.block!) }, 0);
      }
      case "snapshot":
      case "hourly":
      case "daily":
        return json(ctx.request, { data: await core.runNow(ctx.params.action) }, 0);
      default:
        throw notFound(`unknown action ${ctx.params.action}`);
    }
  }, true);

  return r;
}

function alertOut(a: Record<string, any>) {
  const iso = (x: number | null) => (x ? new Date(x * 1000).toISOString() : null);
  return {
    id: a.id, key: a.key, metric: a.metric, dim: a.dim, severity: a.severity, state: a.state, title: a.title,
    value: a.value, threshold: a.threshold, opened: iso(a.opened_ts), updated: iso(a.updated_ts), closed: iso(a.closed_ts), note: a.note ?? null,
    metric_title: a.metric ? METRIC_BY_ID.get(a.metric)?.title ?? null : null,
  };
}

function redactScanner(s: unknown): unknown {
  if (!s || typeof s !== "object") return s;
  const o = s as Record<string, any>;
  return {
    paused: o.paused, last_tick: o.lastTickAt ? new Date(o.lastTickAt).toISOString() : null, consecutive_errors: o.consecutiveErrors,
    last_error_at: o.lastErrorAt ? new Date(o.lastErrorAt).toISOString() : null, mode: o.lastResult?.mode ?? null,
    blocks_last_tick: o.lastResult?.blocks ?? null, node: o.lastResult?.node ?? null, batch: o.nextBatch,
  };
}
