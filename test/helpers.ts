import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compact, loadConfig, parseRange, type RawBlock, type RawVop } from "@tower/core";
import { asD1, D1Shim } from "./d1-shim";

export const root = fileURLToPath(new URL("..", import.meta.url));

export interface FixtureBlock {
  num: number;
  block: RawBlock;
  vops: RawVop[];
}

export function loadFixture(name = "sample.json"): FixtureBlock[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).blocks;
}

export function freshDb() {
  const shim = new D1Shim().migrate(`${root}/migrations`);
  return { shim, db: asD1(shim) };
}

export const cfg = loadConfig({ VERIFY_SECOND_NODE: "false" });

/** Ingest fixture blocks one by one, the way the scanner commits a range. */
export async function ingestFixtures(db: D1Database, blocks: FixtureBlock[]) {
  let statements = 0;
  for (const b of blocks) {
    const parsed = await parseRange([b.block], b.num, b.vops, cfg);
    const stmts = compact(parsed.stmts.items);
    stmts.push({
      sql: `INSERT INTO cursor (name, block, block_ts, updated_at) VALUES ('scanner', ?, ?, 0)
            ON CONFLICT(name) DO UPDATE SET block = excluded.block, block_ts = excluded.block_ts`,
      params: [b.num, parsed.stats.lastTs],
    });
    await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...(s.params as unknown[]))));
    statements += stmts.length;
  }
  return statements;
}

export function counts(shim: D1Shim, tables: string[]) {
  return Object.fromEntries(tables.map((t) => [t, (shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
}
