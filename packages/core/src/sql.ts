// Statement collection and D1 execution helpers.

export interface Stmt {
  sql: string;
  params: unknown[];
}

export class StmtList {
  readonly items: Stmt[] = [];
  add(sql: string, ...params: unknown[]) {
    this.items.push({ sql, params: params.map(normalizeParam) });
  }
  get length() {
    return this.items.length;
  }
}

function normalizeParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

/** Execute statements in D1 batches (each batch is one implicit transaction). */
export async function execBatched(db: D1Database, stmts: Stmt[], size = 400): Promise<number> {
  let rows = 0;
  for (let i = 0; i < stmts.length; i += size) {
    const chunk = stmts.slice(i, i + size).map((s) => db.prepare(s.sql).bind(...s.params));
    const res = await db.batch(chunk);
    for (const r of res) rows += r.meta?.changes ?? 0;
  }
  return rows;
}

/** Execute everything in ONE batch: all or nothing. Used to commit events with the cursor. */
export async function execAtomic(db: D1Database, stmts: Stmt[]): Promise<number> {
  if (stmts.length === 0) return 0;
  const res = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
  return res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params.map(normalizeParam)).all<T>();
  return r.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params.map(normalizeParam)).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const r = await db.prepare(sql).bind(...params.map(normalizeParam)).run();
  return r.meta?.changes ?? 0;
}

// Append-only tables that nothing reads within the same batch: their single-row inserts can be
// merged into multi-row statements and moved to the end of the batch without changing the result.
const MERGEABLE = /^INSERT (?:OR IGNORE )?INTO (op_log|rewards|transfers|stake_events|market_events|authority_events|feeds|witness_missed|community_ops|invariant_events|blocks) \(([^)]*)\) VALUES \((\?(?:,\s*\?)*)\)(\s+ON CONFLICT[\s\S]*)?$/;

/**
 * Merge single-row inserts into append-only tables into multi-row statements (D1 allows 100 bound
 * parameters per statement). Other statements keep their order; merged ones run after them.
 */
export function compact(stmts: Stmt[], maxParams = 99, extraTables: string[] = []): Stmt[] {
  const re = extraTables.length
    ? new RegExp(MERGEABLE.source.replace("(op_log|", `(${extraTables.join("|")}|op_log|`))
    : MERGEABLE;
  const kept: Stmt[] = [];
  const groups = new Map<string, { head: string; tail: string; width: number; rows: unknown[][] }>();
  for (const st of stmts) {
    const sql = st.sql.replace(/\s+/g, " ").trim();
    const m = sql.match(re);
    if (!m) {
      kept.push(st);
      continue;
    }
    const width = m[3].split(",").length;
    if (width !== st.params.length) {
      kept.push(st);
      continue;
    }
    const head = sql.slice(0, sql.indexOf(" VALUES ("));
    const tail = m[4] ?? "";
    const key = head + "|" + tail;
    const g = groups.get(key) ?? { head, tail, width, rows: [] };
    g.rows.push(st.params);
    groups.set(key, g);
  }
  const merged: Stmt[] = [];
  for (const g of groups.values()) {
    const perStmt = Math.max(1, Math.floor(maxParams / g.width));
    const tuple = "(" + Array(g.width).fill("?").join(",") + ")";
    for (let i = 0; i < g.rows.length; i += perStmt) {
      const chunk = g.rows.slice(i, i + perStmt);
      merged.push({ sql: `${g.head} VALUES ${chunk.map(() => tuple).join(",")}${g.tail}`, params: chunk.flat() });
    }
  }
  return [...kept, ...merged];
}

/** Position of an operation inside its block. Signed ops: trx*65536+op. Virtual ops: 2^31 + index. */
export function signedPos(trxInBlock: number, opInTrx: number): number {
  return trxInBlock * 65536 + opInTrx;
}
export function virtualPos(index: number): number {
  return 2 ** 31 + index;
}
/** Global order key, as a decimal string so it never loses precision in JS. */
export function seq(block: number, pos: number): string {
  return (BigInt(block) * 4294967296n + BigInt(pos)).toString();
}

// Current-state tables: replaying an old range must not touch them, because the later operations
// that changed them again are not replayed (a rewind replays up to head and is safe).
const STATE_WRITE = /^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(votes|witness_votes|proxies|delegations|proposal_votes|follows|reblogs|witness_state)\b/i;
const STATE_UPDATE = /^\s*UPDATE (?:posts SET pending_payout_pxs|posts SET up_rshares|posts SET controversy|accounts SET recovery_account)\b/i;

/** Keep only the statements that are safe to re-run out of order (events, seq-guarded posts, MIN/MAX milestones). */
export function replaySafe(stmts: Stmt[]): Stmt[] {
  return stmts.filter((s) => !STATE_WRITE.test(s.sql) && !STATE_UPDATE.test(s.sql));
}
