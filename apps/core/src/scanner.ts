// The scanner Durable Object: the single writer of chain events.
// One instance ("main") holds the alarm loop; the cursor itself lives in D1, committed with the events.

import { DurableObject } from "cloudflare:workers";
import { ChainClient, ingest, loadConfig, setCursor, type IngestResult, type RawBlock, type RawVop } from "@tower/core";
import { log, type Env } from "./env";

interface ScannerState {
  paused: boolean;
  nextBatch: number;
  lastResult: IngestResult | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveErrors: number;
  lastTickAt: number | null;
  blocksTotal: number;
}

const DEFAULT_STATE: ScannerState = {
  paused: false, nextBatch: 0, lastResult: null, lastError: null, lastErrorAt: null, consecutiveErrors: 0, lastTickAt: null, blocksTotal: 0,
};

export class Scanner extends DurableObject<Env> {
  private async state(): Promise<ScannerState> {
    return { ...DEFAULT_STATE, ...((await this.ctx.storage.get<ScannerState>("state")) ?? {}) };
  }
  private async save(s: ScannerState) {
    await this.ctx.storage.put("state", s);
  }

  private async archiver() {
    const cfg = loadConfig(this.env);
    const bucket = this.env.ARCHIVE;
    if (!cfg.archiveRaw || !bucket) return undefined;
    return async (from: number, to: number, blocks: RawBlock[], vops: RawVop[]) => {
      const body = new Blob([JSON.stringify({ from, to, blocks, vops })]).stream().pipeThrough(new CompressionStream("gzip"));
      const key = `blocks/${String(Math.floor(from / 100_000) * 100_000).padStart(9, "0")}/${String(from).padStart(9, "0")}-${String(to).padStart(9, "0")}.json.gz`;
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
    };
  }

  override async alarm() {
    const s = await this.state();
    if (s.paused) return;
    const cfg = loadConfig(this.env);
    const client = new ChainClient(cfg.nodes, { log });
    let delayMs = 3_000;
    try {
      const r = await ingest(this.env.DB, client, cfg, {
        batch: s.nextBatch || undefined,
        maxStatements: Number(this.env.MAX_STATEMENTS_PER_TICK ?? 5000),
        archive: await this.archiver(),
        log,
        deadlineMs: 20_000,
      });
      s.lastResult = r;
      s.nextBatch = r.nextBatch;
      s.blocksTotal += r.blocks;
      s.consecutiveErrors = 0;
      s.lastTickAt = Date.now();
      // Behind by more than one batch: come back at once. Caught up: next block in about 3 s.
      delayMs = r.lag > Math.max(cfg.liveBatch, 1) ? 500 : 3_000;
      if (r.blocks > 0) log("tick", { mode: r.mode, from: r.from, to: r.to, lag: r.lag, ms: r.ms, statements: r.statements, node: r.node });
    } catch (e) {
      s.consecutiveErrors++;
      s.lastError = String((e as Error).message ?? e).slice(0, 500);
      s.lastErrorAt = Date.now();
      // Halve the batch on failure: a range too large or too slow for one D1 batch shrinks to fit.
      s.nextBatch = Math.max(1, Math.floor((s.nextBatch || cfg.backfillBatch) / 2));
      delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(s.consecutiveErrors, 5));
      log("tick_error", { error: s.lastError, consecutive: s.consecutiveErrors, nextBatch: s.nextBatch });
    }
    await this.save(s);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Make sure the loop runs (called by the 5-minute cron). */
  async kick(): Promise<boolean> {
    const s = await this.state();
    if (s.paused) return false;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < Date.now() - 60_000) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return true;
    }
    return false;
  }

  async status() {
    const s = await this.state();
    return { ...s, alarm: await this.ctx.storage.getAlarm() };
  }

  async pause() {
    const s = await this.state();
    s.paused = true;
    await this.save(s);
    await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  async resume() {
    const s = await this.state();
    s.paused = false;
    s.consecutiveErrors = 0;
    await this.save(s);
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return this.status();
  }

  /**
   * Move the cursor back to `block`: the scanner re-ingests everything after it, in order.
   * Event tables are idempotent and state tables converge, because every operation is re-applied up to head.
   */
  async rewind(block: number) {
    const r = await this.env.DB.prepare(`SELECT ts FROM blocks WHERE num = ?`).bind(block).first<{ ts: number }>();
    await setCursor(this.env.DB, block, r?.ts ?? null);
    const s = await this.state();
    s.nextBatch = 0;
    await this.save(s);
    if (!s.paused) await this.ctx.storage.setAlarm(Date.now() + 100);
    log("rewind", { block });
    return this.status();
  }
}
