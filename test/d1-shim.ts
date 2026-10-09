// A small D1Database implementation over node:sqlite, close enough to run the Tower's SQL in tests.
// D1 and node:sqlite both run SQLite, so schema, upserts and queries behave the same.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Value = string | number | null | bigint | Uint8Array;

class Stmt {
  constructor(
    private db: DatabaseSync,
    public sql: string,
    public params: Value[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map(toValue));
  }
  private prepared() {
    const p = this.db.prepare(this.sql);
    p.setReadBigInts(false);
    return p;
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.prepared().get(...(this.params as any[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T>() {
    const rows = this.prepared().all(...(this.params as any[])) as T[];
    return { results: rows, success: true, meta: { changes: 0, duration: 0 } };
  }
  async raw<T>() {
    const rows = this.prepared().all(...(this.params as any[])) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r)) as T[];
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const r = this.prepared().run(...(this.params as any[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
  }
}

function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error(`D1_TYPE_ERROR: unsupported bind type ${typeof v}`);
}

export class D1Shim {
  readonly sqlite: DatabaseSync;
  queries = 0;
  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
  }
  prepare(sql: string) {
    this.queries++;
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts: Stmt[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        if (/^\s*(SELECT|WITH)/i.test(s.sql)) {
          const rows = this.sqlite.prepare(s.sql).all(...(s.params as any[]));
          return { results: rows, success: true, meta: { changes: 0, duration: 0 } };
        }
        return s.runSync();
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
  migrate(dir: string) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(dir, f), "utf8"));
    }
    return this;
  }
}

export function asD1(shim: D1Shim): D1Database {
  return shim as unknown as D1Database;
}
