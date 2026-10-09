// Alert evaluation: thresholds are rows, not code. Runs every 5 minutes.

import { METRIC_BY_ID } from "./metrics";
import { all, first, run, type Stmt } from "./sql";
import { bucketStart, DAY, type Grain } from "./time";

export interface Threshold {
  metric: string;
  dim: string; // '' total, '*' every dimension
  grain: Grain;
  op: "gt" | "lt" | "abs_gt" | "abs_change_pct";
  amber: number | null;
  red: number | null;
  window_buckets: number;
  owner: string | null;
  action_hint: string | null;
  enabled: number;
}

export interface AlertEvent {
  kind: "opened" | "escalated" | "deescalated" | "closed";
  id: number;
  key: string;
  title: string;
  severity: "amber" | "red";
  value: number | null;
  threshold: number | null;
  owner?: string | null;
  action_hint?: string | null;
  evidence?: unknown;
}

export interface Notifier {
  send(events: AlertEvent[]): Promise<void>;
}

const now = () => Math.floor(Date.now() / 1000);

function breaches(op: Threshold["op"], values: number[], band: number | null): boolean {
  if (band === null || band === undefined || values.length === 0) return false;
  switch (op) {
    case "gt":
      return values.every((v) => v > band);
    case "lt":
      return values.every((v) => v < band);
    case "abs_gt":
      return values.every((v) => Math.abs(v) > band);
    case "abs_change_pct": {
      // values are newest first; compare each to the one before it
      if (values.length < 2) return false;
      const changes = values.slice(0, -1).map((v, i) => (values[i + 1] === 0 ? (v === 0 ? 0 : Infinity) : Math.abs(v / values[i + 1] - 1)));
      return changes.every((c) => c > band);
    }
  }
}

function describe(t: Threshold, dim: string, severity: string, value: number | null, band: number | null): string {
  const def = METRIC_BY_ID.get(t.metric);
  const name = def?.title ?? t.metric;
  const where = dim ? ` (${dim})` : "";
  const opWord = t.op === "gt" ? "above" : t.op === "lt" ? "below" : t.op === "abs_gt" ? "beyond ±" : "changing more than";
  const fmt = (x: number | null) => (x === null ? "n/a" : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));
  return `${severity.toUpperCase()}: ${name}${where} is ${fmt(value)} ${def?.unit ?? ""}, ${opWord} ${fmt(band)} (${t.grain})`;
}

/** The last `n` bucket starts of a grain, newest first: closed buckets, plus the open one for gauges. */
function expectedBuckets(grain: Grain, ingestedTs: number, n: number, includeOpen: boolean): number[] {
  const out: number[] = [];
  let b = bucketStart(ingestedTs, grain);
  if (!includeOpen) b = bucketStart(b - 1, grain);
  for (let i = 0; i < n; i++) {
    out.push(b);
    b = bucketStart(b - 1, grain);
  }
  return out;
}

/** Evaluate every enabled threshold against the latest buckets. */
export async function evaluateThresholds(db: D1Database, ingestedTs: number): Promise<AlertEvent[]> {
  const thresholds = await all<Threshold>(db, `SELECT * FROM thresholds WHERE enabled = 1`);
  const events: AlertEvent[] = [];
  for (const t of thresholds) {
    const def = METRIC_BY_ID.get(t.metric);
    if (!def) continue;
    const isGauge = def.kind === "gauge";
    const need = Math.max(1, t.window_buckets) + (t.op === "abs_change_pct" ? 1 : 0);
    // Gauges: the open bucket already holds the latest value; may also fall back to the last closed one.
    const expected = expectedBuckets(t.grain, ingestedTs, need + (isGauge ? 1 : 0), isGauge);
    let dims = [t.dim];
    if (t.dim === "*") {
      const recent = await all<{ dim: string }>(
        db, `SELECT DISTINCT dim FROM metric_rollup WHERE metric = ? AND grain = ? AND bucket >= ?`, t.metric, t.grain, expected[expected.length - 1],
      );
      // Dimensions with an open alert are always re-evaluated, so the alert can close when the dimension goes quiet.
      const open = await all<{ dim: string }>(db, `SELECT DISTINCT dim FROM alerts WHERE key LIKE ? AND state <> 'closed'`, `${t.metric}|${t.grain}|%`);
      dims = [...new Set([...recent.map((r) => r.dim), ...open.map((r) => r.dim)])].filter((d) => d !== "");
    }
    for (const dim of dims) {
      const rows = await all<{ bucket: number; value: number | null; extra: string | null }>(
        db,
        `SELECT bucket, value, extra FROM metric_rollup WHERE metric = ? AND grain = ? AND dim = ? AND bucket >= ? ORDER BY bucket DESC`,
        t.metric, t.grain, dim, expected[expected.length - 1],
      );
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      let window = expected;
      if (isGauge) window = byBucket.has(expected[0]) ? expected.slice(0, need) : expected.slice(1, need + 1);
      // A counter with no row in a closed bucket had no events: 0. Other kinds need every bucket present.
      const usable = window.map((b) => byBucket.get(b) ?? (def.kind === "counter" ? { bucket: b, value: 0, extra: null } : null));
      const complete = usable.every((u) => u && u.value !== null);
      const values = complete ? usable.map((u) => u!.value as number) : [];
      const severity = complete ? (breaches(t.op, values, t.red) ? "red" : breaches(t.op, values, t.amber) ? "amber" : null) : null;
      const key = `${t.metric}|${t.grain}|${dim}`;
      const ev = await upsertAlert(db, key, t, dim, severity, values[0] ?? null, severity === "red" ? t.red : t.amber,
        usable.filter((u): u is { bucket: number; value: number | null; extra: string | null } => !!u));
      if (ev) events.push(ev);
    }
  }
  return events;
}

async function upsertAlert(
  db: D1Database, key: string, t: Threshold, dim: string, severity: "amber" | "red" | null, value: number | null, band: number | null,
  usable: { bucket: number; value: number | null; extra: string | null }[],
): Promise<AlertEvent | null> {
  const open = await first<{ id: number; severity: "amber" | "red"; clear_count: number; state: string }>(
    db, `SELECT id, severity, clear_count, state FROM alerts WHERE key = ? AND state <> 'closed' ORDER BY id DESC LIMIT 1`, key,
  );
  const ts = now();
  const evidence = JSON.stringify({ values: usable.map((u) => ({ bucket: u.bucket, value: u.value })), extra: safeParse(usable[0]?.extra) });
  if (severity) {
    const title = describe(t, dim, severity, value, band);
    if (!open) {
      const r = await db
        .prepare(
          `INSERT INTO alerts (key, metric, dim, severity, state, opened_ts, updated_ts, value, threshold, title, evidence)
           VALUES (?,?,?,?, 'open', ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(key, t.metric, dim, severity, ts, ts, value, band, title, evidence)
        .first<{ id: number }>();
      return { kind: "opened", id: r!.id, key, title, severity, value, threshold: band, owner: t.owner, action_hint: t.action_hint, evidence: JSON.parse(evidence) };
    }
    await run(db, `UPDATE alerts SET severity = ?, value = ?, threshold = ?, title = ?, evidence = ?, updated_ts = ?, clear_count = 0 WHERE id = ?`,
      severity, value, band, title, evidence, ts, open.id);
    if (open.severity !== severity) {
      return { kind: severity === "red" ? "escalated" : "deescalated", id: open.id, key, title, severity, value, threshold: band, owner: t.owner, action_hint: t.action_hint };
    }
    return null;
  }
  if (open) {
    // Two consecutive clear evaluations close the alert.
    if (open.clear_count + 1 >= 2) {
      await run(db, `UPDATE alerts SET state = 'closed', closed_ts = ?, updated_ts = ?, value = ?, clear_count = clear_count + 1 WHERE id = ?`, ts, ts, value, open.id);
      return { kind: "closed", id: open.id, key, title: `CLEARED: ${describe(t, dim, open.severity, value, band).replace(/^\w+: /, "")}`, severity: open.severity, value, threshold: band };
    }
    await run(db, `UPDATE alerts SET clear_count = clear_count + 1, updated_ts = ?, value = ? WHERE id = ?`, ts, value, open.id);
  }
  return null;
}

function safeParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const INVARIANT_TITLES: Record<string, string> = {
  restricted_account_voted: "A restricted treasury account voted",
  artwork_changed_after_payout: "An artwork's image was replaced after payout",
  unknown_op: "Unknown operation type on chain",
  parse_error: "The Tower could not parse an operation",
  hardfork: "Hardfork applied",
  system_warning: "Chain system warning",
  witness_shutdown: "A witness was shut down",
};

/** Turn new invariant events into alerts. They stay open until someone closes them. */
export async function processInvariants(db: D1Database): Promise<AlertEvent[]> {
  const rows = await all<{ block: number; pos: number; ts: number; kind: string; severity: string; subject: string | null; detail: string | null }>(
    db, `SELECT block, pos, ts, kind, severity, subject, detail FROM invariant_events WHERE alerted = 0 ORDER BY block, pos LIMIT 200`,
  );
  const events: AlertEvent[] = [];
  const stmts: Stmt[] = [];
  for (const r of rows) {
    stmts.push({ sql: `UPDATE invariant_events SET alerted = 1 WHERE block = ? AND pos = ? AND kind = ?`, params: [r.block, r.pos, r.kind] });
    if (r.severity !== "amber" && r.severity !== "red") continue;
    const key = `invariant|${r.kind}|${r.subject ?? ""}`;
    const title = `${r.severity.toUpperCase()}: ${INVARIANT_TITLES[r.kind] ?? r.kind}${r.subject ? ` (${r.subject})` : ""} at block ${r.block}`;
    const open = await first<{ id: number; evidence: string | null }>(db, `SELECT id, evidence FROM alerts WHERE key = ? AND state <> 'closed' LIMIT 1`, key);
    const ts = now();
    const item = { block: r.block, ts: r.ts, detail: safeParse(r.detail) };
    if (open) {
      const ev = (safeParse(open.evidence) as { events?: unknown[] } | null) ?? {};
      const list = [...(ev.events ?? []), item].slice(-20);
      await run(db, `UPDATE alerts SET evidence = ?, updated_ts = ?, value = COALESCE(value, 0) + 1 WHERE id = ?`, JSON.stringify({ events: list }), ts, open.id);
      continue;
    }
    const res = await db
      .prepare(
        `INSERT INTO alerts (key, metric, dim, severity, state, opened_ts, updated_ts, value, threshold, title, evidence)
         VALUES (?, NULL, ?, ?, 'open', ?, ?, 1, NULL, ?, ?) RETURNING id`,
      )
      .bind(key, r.subject ?? "", r.severity, ts, ts, title, JSON.stringify({ events: [item] }))
      .first<{ id: number }>();
    events.push({ kind: "opened", id: res!.id, key, title, severity: r.severity as "amber" | "red", value: 1, threshold: null, evidence: item });
  }
  if (stmts.length) await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
  return events;
}

/** Fill review_7d / review_30d of logged actions with the metric's value at those dates (loop closure). */
export async function reviewActions(db: D1Database, ingestedTs: number) {
  const rows = await all<{ id: number; ts: number; metric: string; dim: string | null; review_7d: number | null; review_30d: number | null }>(
    db, `SELECT id, ts, metric, dim, review_7d, review_30d FROM actions WHERE metric IS NOT NULL AND (review_7d IS NULL OR review_30d IS NULL)`,
  );
  for (const a of rows) {
    for (const [col, days] of [["review_7d", 7], ["review_30d", 30]] as const) {
      if (a[col] !== null || a.ts + days * DAY > ingestedTs) continue;
      const v = await first<{ value: number }>(
        db,
        `SELECT value FROM metric_rollup WHERE metric = ? AND dim = ? AND grain IN ('day','hour') AND bucket <= ? ORDER BY bucket DESC LIMIT 1`,
        a.metric, a.dim ?? "", a.ts + days * DAY,
      );
      if (v) await run(db, `UPDATE actions SET ${col} = ? WHERE id = ?`, v.value, a.id);
    }
  }
}

// ------------------------------------------------------------------ delivery

export interface NotifierEnv {
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL_RED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERT_WEBHOOK_URL?: string;
  PUBLIC_BASE_URL?: string;
}

export function webhookNotifier(env: NotifierEnv, fetcher: typeof fetch = fetch): Notifier {
  return {
    async send(events: AlertEvent[]) {
      if (events.length === 0) return;
      const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
      const line = (e: AlertEvent) => {
        const icon = e.kind === "closed" ? "✅" : e.severity === "red" ? "🔴" : "🟠";
        const link = base ? ` ${base}/v1/alerts/${e.id}` : "";
        const hint = e.action_hint && e.kind !== "closed" ? `\n   → ${e.action_hint}${e.owner ? ` (${e.owner})` : ""}` : "";
        return `${icon} ${e.title}${link}${hint}`;
      };
      const tasks: Promise<unknown>[] = [];
      const discord = (url: string, list: AlertEvent[]) => {
        if (!list.length) return;
        for (let i = 0; i < list.length; i += 10) {
          const content = list.slice(i, i + 10).map(line).join("\n").slice(0, 1900);
          tasks.push(fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }));
        }
      };
      if (env.DISCORD_WEBHOOK_URL) discord(env.DISCORD_WEBHOOK_URL, events);
      if (env.DISCORD_WEBHOOK_URL_RED) discord(env.DISCORD_WEBHOOK_URL_RED, events.filter((e) => e.severity === "red" && e.kind !== "closed"));
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const text = events.map(line).join("\n").slice(0, 4000);
        tasks.push(fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        }));
      }
      if (env.ALERT_WEBHOOK_URL) {
        tasks.push(fetcher(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) }));
      }
      await Promise.allSettled(tasks);
    },
  };
}
