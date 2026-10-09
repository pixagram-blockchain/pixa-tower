// tower-core: the scanner Durable Object, the scheduled jobs and the job queue.
// It has no public route: the API Worker reaches it through a service binding for admin calls.

import {
  ChainClient, evaluateThresholds, ingest, loadConfig, processInvariants, recompute, reviewActions, runDaily, runHourly,
  snapshot, syncMetricDefs, webhookNotifier, type AlertEvent,
} from "@tower/core";
import { WorkerEntrypoint } from "cloudflare:workers";
import { log, type Env, type Job } from "./env";

/** Queues accept at most 100 messages per sendBatch. */
async function sendAll(queue: Queue<Job>, parts: { body: Job }[]) {
  for (let i = 0; i < parts.length; i += 100) await queue.sendBatch(parts.slice(i, i + 100));
}
import { Scanner } from "./scanner";

export { Scanner };

const scanner = (env: Env) => env.SCANNER.get(env.SCANNER.idFromName("main")) as unknown as DurableObjectStub<Scanner>;

async function fiveMinutes(env: Env, controller: ScheduledController) {
  const cfg = loadConfig(env);
  const client = new ChainClient(cfg.nodes, { log });
  const now = Math.floor(controller.scheduledTime / 1000);

  await scanner(env).kick();

  // Full account refresh every run on a small chain; once a day above BALANCE_FULL_REFRESH_MAX accounts.
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM balances`).first<{ n: number }>();
  const minuteOfDay = Math.floor((now % 86400) / 60);
  const refreshBalances = (count?.n ?? 0) <= cfg.balanceFullRefreshMax || (minuteOfDay >= 10 && minuteOfDay < 15);

  try {
    const overview = await snapshot(env.DB, client, cfg, { refreshBalances, now });
    await env.CACHE.put("overview", JSON.stringify(overview), { expirationTtl: 3600 });
  } catch (e) {
    log("snapshot_error", { error: String((e as Error).message ?? e) });
  }

  try {
    const r = await runHourly(env.DB, cfg, { maxHours: 72 });
    if (r.hours) log("rollup_hourly", r);
  } catch (e) {
    log("rollup_error", { error: String((e as Error).message ?? e) });
  }

  try {
    const ingested = await env.DB.prepare(`SELECT block_ts FROM cursor WHERE name = 'scanner'`).first<{ block_ts: number }>();
    const events: AlertEvent[] = [...(await processInvariants(env.DB)), ...(await evaluateThresholds(env.DB, ingested?.block_ts ?? now))];
    if (events.length) {
      log("alerts", { events: events.map((e) => ({ kind: e.kind, key: e.key, severity: e.severity })) });
      await webhookNotifier(env).send(events);
    }
  } catch (e) {
    log("alerts_error", { error: String((e as Error).message ?? e) });
  }
}

async function hourly(env: Env) {
  const cfg = loadConfig(env);
  await syncMetricDefs(env.DB);
  // Daily metrics catch up hourly during a backfill; once caught up this does nothing until midnight.
  const r = await runDaily(env.DB, cfg, { maxDays: 10 });
  if (r.days) log("rollup_daily", r);
}

async function daily(env: Env, now: number) {
  const cfg = loadConfig(env);
  await runDaily(env.DB, cfg, { maxDays: 10 });
  const ingested = await env.DB.prepare(`SELECT block_ts FROM cursor WHERE name = 'scanner'`).first<{ block_ts: number }>();
  await reviewActions(env.DB, ingested?.block_ts ?? now);
  // Retention.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM op_log WHERE ts < ?`).bind(now - 400 * 86400),
    env.DB.prepare(`DELETE FROM chain_snapshots WHERE ts < ? AND ts % 3600 >= 300`).bind(now - 30 * 86400),
    env.DB.prepare(`DELETE FROM witness_snapshots WHERE ts < ? AND ts % 3600 >= 300`).bind(now - 30 * 86400),
    env.DB.prepare(`DELETE FROM metric_rollup WHERE grain = 'hour' AND bucket < ?`).bind(now - 400 * 86400),
  ]);
  log("daily_done", {});
}

export default class TowerCore extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("tower-core has no public routes; use the API worker", { status: 404 });
  }

  override async scheduled(controller: ScheduledController): Promise<void> {
    const now = Math.floor(controller.scheduledTime / 1000);
    switch (controller.cron) {
      case "15 0 * * *":
        await daily(this.env, now);
        break;
      case "7 * * * *":
        await hourly(this.env);
        break;
      default:
        await fiveMinutes(this.env, controller);
    }
  }

  override async queue(batch: MessageBatch<Job>): Promise<void> {
    const cfg = loadConfig(this.env);
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        if (job.type === "recompute") {
          // Large ranges are split so each message stays within one invocation's limits.
          const span = 3 * 86400;
          if (job.to - job.from > span && this.env.JOBS) {
            const parts: { body: Job }[] = [];
            for (let f = job.from; f < job.to; f += span) parts.push({ body: { type: "recompute", from: f, to: Math.min(job.to, f + span), metric: job.metric } });
            await sendAll(this.env.JOBS, parts);
          } else {
            const r = await recompute(this.env.DB, cfg, job.from, job.to, job.metric);
            log("recompute_done", { ...job, ...r });
          }
        } else if (job.type === "replay") {
          const span = 2000;
          if (job.to - job.from >= span && this.env.JOBS) {
            const parts: { body: Job }[] = [];
            for (let f = job.from; f <= job.to; f += span) parts.push({ body: { type: "replay", from: f, to: Math.min(job.to, f + span - 1) } });
            await sendAll(this.env.JOBS, parts);
          } else {
            const client = new ChainClient(cfg.nodes, { log });
            let from = job.from;
            while (from <= job.to) {
              const r = await ingest(this.env.DB, client, cfg, { replay: { from, to: job.to }, log, deadlineMs: 25_000 });
              if (!r.to || r.to < from) break;
              from = r.to + 1;
            }
            log("replay_done", job);
          }
        }
        msg.ack();
      } catch (e) {
        log("job_error", { job, error: String((e as Error).message ?? e) });
        msg.retry({ delaySeconds: 60 });
      }
    }
  }

  // ---- RPC for the API worker (service binding) ----
  async scannerStatus() {
    return scanner(this.env).status();
  }
  async scannerPause() {
    return scanner(this.env).pause();
  }
  async scannerResume() {
    return scanner(this.env).resume();
  }
  async scannerRewind(block: number) {
    return scanner(this.env).rewind(block);
  }
  async runNow(job: "snapshot" | "hourly" | "daily") {
    const now = Math.floor(Date.now() / 1000);
    if (job === "snapshot") await fiveMinutes(this.env, { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController);
    if (job === "hourly") await hourly(this.env);
    if (job === "daily") await daily(this.env, now);
    return { ok: true, job };
  }
}
