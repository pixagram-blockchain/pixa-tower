import type { TowerVars } from "@tower/core";

export interface Env extends TowerVars {
  DB: D1Database;
  CACHE: KVNamespace;
  ARCHIVE?: R2Bucket;
  JOBS?: Queue<Job>;
  SCANNER: DurableObjectNamespace;
  // secrets (wrangler secret put)
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL_RED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERT_WEBHOOK_URL?: string;
  MAX_STATEMENTS_PER_TICK?: string;
  ENVIRONMENT?: string;
}

export type Job =
  | { type: "recompute"; from: number; to: number; metric?: string }
  | { type: "replay"; from: number; to: number };

export function log(msg: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ msg, ...data }));
}
