// The scanner's work loop, independent of the Durable Object so it can be tested and replayed.
// Only irreversible blocks are ingested, in order. Events and the cursor are committed in one batch,
// so a crash can repeat a range but never skip or double-count one.

import type { TowerConfig } from "./config";
import { parseRange } from "./parser";
import type { ChainClient, RawBlock, RawVop } from "./rpc";
import { compact, first, replaySafe, type Stmt } from "./sql";
import { chainTime } from "./time";

export interface IngestOptions {
  maxBlocks?: number;
  maxStatements?: number;
  batch?: number; // starting batch size (adaptive in backfill)
  archive?: (from: number, to: number, blocks: RawBlock[], vops: RawVop[]) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Re-ingest [from, to] without touching the cursor (admin replay). */
  replay?: { from: number; to: number };
  deadlineMs?: number;
}

export interface IngestResult {
  mode: "idle" | "live" | "backfill" | "replay";
  from: number | null;
  to: number | null;
  blocks: number;
  ops: number;
  vops: number;
  statements: number;
  lib: number;
  head: number;
  cursor: number;
  lag: number;
  nextBatch: number;
  ms: number;
  node: string;
  unknown: Record<string, number>;
}

const TARGET_BYTES = 8 * 1024 * 1024;

export async function getCursor(db: D1Database, cfg: TowerConfig): Promise<{ block: number; block_ts: number | null }> {
  const r = await first<{ block: number; block_ts: number | null }>(db, `SELECT block, block_ts FROM cursor WHERE name = 'scanner'`);
  return r ?? { block: cfg.startBlock - 1, block_ts: null };
}

export async function setCursor(db: D1Database, block: number, blockTs: number | null) {
  await db
    .prepare(
      `INSERT INTO cursor (name, block, block_ts, updated_at) VALUES ('scanner', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET block = excluded.block, block_ts = excluded.block_ts, updated_at = excluded.updated_at`,
    )
    .bind(block, blockTs, Math.floor(Date.now() / 1000))
    .run();
}

function cursorStmt(block: number, blockTs: number): Stmt {
  return {
    sql: `INSERT INTO cursor (name, block, block_ts, updated_at) VALUES ('scanner', ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET block = excluded.block, block_ts = excluded.block_ts, updated_at = excluded.updated_at`,
    params: [block, blockTs, Math.floor(Date.now() / 1000)],
  };
}

export async function ingest(db: D1Database, client: ChainClient, cfg: TowerConfig, opts: IngestOptions = {}): Promise<IngestResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const deadline = started + (opts.deadlineMs ?? 20_000);
  const dgp = await client.getDynamicGlobalProperties();
  const lib = Number(dgp.last_irreversible_block_num);
  const head = Number(dgp.head_block_number);

  let cursor: number;
  let stopAt: number;
  let mode: IngestResult["mode"];
  if (opts.replay) {
    cursor = opts.replay.from - 1;
    stopAt = Math.min(opts.replay.to, lib);
    mode = "replay";
  } else {
    cursor = (await getCursor(db, cfg)).block;
    stopAt = lib;
    mode = lib - cursor > 100 ? "backfill" : "live";
  }

  const result: IngestResult = {
    mode: cursor >= stopAt ? "idle" : mode, from: null, to: null, blocks: 0, ops: 0, vops: 0, statements: 0,
    lib, head, cursor, lag: Math.max(0, lib - cursor), nextBatch: opts.batch ?? (mode === "backfill" ? cfg.backfillBatch : cfg.liveBatch),
    ms: 0, node: "", unknown: {},
  };
  if (cursor >= stopAt) {
    result.ms = Date.now() - started;
    return result;
  }

  let batch = Math.max(1, result.nextBatch);
  const maxBatch = mode === "backfill" || mode === "replay" ? Math.max(cfg.backfillBatch, batch) : Math.max(cfg.liveBatch, batch);
  const maxBlocks = opts.maxBlocks ?? cfg.maxBlocksPerTick;
  const maxStatements = opts.maxStatements ?? 5000;

  while (cursor < stopAt && result.blocks < maxBlocks && result.statements < maxStatements && Date.now() < deadline) {
    const from = cursor + 1;
    const count = Math.min(batch, stopAt - cursor, maxBlocks - result.blocks);
    const { blocks, bytes, node } = await client.getBlockRange(from, count);
    if (blocks.length === 0) break;
    const to = from + blocks.length - 1;
    result.node = node;

    // Adapt the batch to keep responses near the target size (artworks can be large).
    const perBlock = bytes / blocks.length;
    if (bytes > TARGET_BYTES && batch > 1) batch = Math.max(1, Math.floor(batch / 2));
    else if (bytes < TARGET_BYTES / 4 && batch < maxBatch) batch = Math.min(maxBatch, Math.max(batch + 1, Math.floor(TARGET_BYTES / Math.max(perBlock, 1) / 2)));

    // Two nodes must agree on the last block of the range.
    if (cfg.verifySecondNode && client.nodeCount > 1) {
      const other = await client.getBlockHeaderId(to, node).catch(() => null);
      const mine = blocks[blocks.length - 1].block_id;
      if (other && mine && other !== mine) {
        client.demote(node, `block ${to} id mismatch`);
        throw new Error(`block ${to}: ${node} says ${mine}, another node says ${other}`);
      }
    }

    const vops = await client.getVirtualOps(from, to + 1);
    const parsed = await parseRange(blocks, from, vops, cfg);
    const stmts = compact(mode === "replay" ? replaySafe(parsed.stmts.items) : parsed.stmts.items);
    const lastTs = chainTime(blocks[blocks.length - 1].timestamp);
    if (mode !== "replay") stmts.push(cursorStmt(to, lastTs));
    await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));

    if (opts.archive) {
      await opts.archive(from, to, blocks, vops).catch((e) => log("archive_failed", { from, to, error: String(e) }));
    }

    cursor = to;
    result.from ??= from;
    result.to = to;
    result.blocks += blocks.length;
    result.ops += parsed.stats.ops;
    result.vops += parsed.stats.vops;
    result.statements += stmts.length;
    for (const [k, v] of Object.entries(parsed.stats.unknown)) result.unknown[k] = (result.unknown[k] ?? 0) + v;
    log("ingested", { from, to, blocks: blocks.length, ops: parsed.stats.ops, vops: parsed.stats.vops, statements: stmts.length, bytes, node, batch });
  }

  result.cursor = cursor;
  result.lag = Math.max(0, lib - cursor);
  result.nextBatch = batch;
  result.ms = Date.now() - started;
  return result;
}
