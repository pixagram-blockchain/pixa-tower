#!/usr/bin/env node
// Set the alert-delivery secrets on tower-core (and ADMIN_TOKEN on tower-api for staging).
// Values come from environment variables when set, otherwise you are asked (input hidden; empty = skip).
//
//   node scripts/secrets.mjs --env staging
//   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node scripts/secrets.mjs --env production

import { API_CONFIG, CORE_CONFIG, ok, parseArgs, prompt, requireEnv, step, warn, wrangler } from "./lib.mjs";

const args = parseArgs();
const env = requireEnv(args);

const core = [
  ["DISCORD_WEBHOOK_URL", "Discord webhook for all alerts"],
  ["DISCORD_WEBHOOK_URL_RED", "Discord webhook for red alerts only (optional second channel)"],
  ["TELEGRAM_BOT_TOKEN", "Telegram bot token"],
  ["TELEGRAM_CHAT_ID", "Telegram chat id"],
  ["ALERT_WEBHOOK_URL", "Generic webhook (receives JSON {events}) e.g. an email relay"],
];
const api = env === "staging" ? [["ADMIN_TOKEN", "Admin bearer token for staging (production uses Cloudflare Access)"]] : [];

async function put(config, name, label) {
  const value = process.env[name] ?? (await prompt(`${label} (${name})`, { hidden: true }));
  if (!value) return warn(`${name} skipped`);
  wrangler(["secret", "put", name, "-c", config, "--env", env], { input: value + "\n", quiet: true });
  ok(`${name} set`);
}

step(`Secrets for tower-core (${env})`);
for (const [n, l] of core) await put(CORE_CONFIG, n, l);
if (api.length) {
  step(`Secrets for tower-api (${env})`);
  for (const [n, l] of api) await put(API_CONFIG, n, l);
}
