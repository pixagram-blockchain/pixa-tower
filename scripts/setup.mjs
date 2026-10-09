#!/usr/bin/env node
// Create the Cloudflare resources for one environment and write their ids into both wrangler configs.
// Safe to run again: existing resources are reused.
//
//   node scripts/setup.mjs --env staging
//   node scripts/setup.mjs --env production --access-team pixagram.cloudflareaccess.com --access-aud <AUD tag>

import {
  API_CONFIG, checkLogin, CORE_CONFIG, ENVS, fail, ok, parseArgs, parseJsonOutput, readText, requireEnv, saveState, step, warn, wrangler,
  writeText,
} from "./lib.mjs";

const args = parseArgs();
const env = requireEnv(args);
const names = ENVS[env];
const ENV_UPPER = env.toUpperCase();

step(`Setting up Pixa Tower (${env})`);
checkLogin();

// ---- D1
step(`D1 database ${names.db}`);
let dbs = parseJsonOutput(wrangler(["d1", "list", "--json"], { quiet: true }));
let db = dbs.find((d) => d.name === names.db);
if (!db) {
  wrangler(["d1", "create", names.db]);
  dbs = parseJsonOutput(wrangler(["d1", "list", "--json"], { quiet: true }));
  db = dbs.find((d) => d.name === names.db);
  if (!db) fail("database not found after creation");
  ok(`created ${names.db}`);
} else ok(`exists ${names.db}`);
const dbId = db.uuid ?? db.id;

// ---- KV
step(`KV namespace ${names.kv}`);
const listKv = () => parseJsonOutput(wrangler(["kv", "namespace", "list"], { quiet: true }));
let kv = listKv().find((n) => n.title === names.kv || n.title.endsWith(`-${names.kv}`));
if (!kv) {
  wrangler(["kv", "namespace", "create", names.kv]);
  kv = listKv().find((n) => n.title === names.kv || n.title.endsWith(`-${names.kv}`));
  if (!kv) fail("KV namespace not found after creation");
  ok(`created ${kv.title}`);
} else ok(`exists ${kv.title}`);

// ---- R2 (optional: raw block archive)
step(`R2 bucket ${names.r2}`);
if (wrangler(["r2", "bucket", "create", names.r2], { allowFail: true, quiet: true }) !== null) ok(`created ${names.r2}`);
else warn(`${names.r2} exists or R2 is not enabled on the account (archive is optional: set ARCHIVE_RAW=false and remove the binding)`);

// ---- Queue
step(`Queue ${names.queue}`);
if (wrangler(["queues", "create", names.queue], { allowFail: true, quiet: true }) !== null) ok(`created ${names.queue}`);
else warn(`${names.queue} exists (or Queues needs the Workers Paid plan)`);

// ---- write ids into the configs
step("Writing resource ids into wrangler.jsonc");
for (const path of [CORE_CONFIG, API_CONFIG]) {
  let text = readText(path);
  const before = text;
  text = text.replaceAll(`__D1_ID_${ENV_UPPER}__`, dbId).replaceAll(`__KV_ID_${ENV_UPPER}__`, kv.id);
  if (env === "production") {
    if (args["access-team"]) text = text.replaceAll("__ACCESS_TEAM_DOMAIN__", String(args["access-team"]));
    if (args["access-aud"]) text = text.replaceAll("__ACCESS_AUD__", String(args["access-aud"]));
  }
  if (text !== before) {
    writeText(path, text);
    ok(`updated ${path.replace(/.*apps\//, "apps/")}`);
  } else ok(`${path.replace(/.*apps\//, "apps/")} already configured`);
}
if (env === "production" && readText(API_CONFIG).includes("__ACCESS_")) {
  warn("Cloudflare Access is not configured yet: admin routes will refuse every call.");
  warn("Re-run with --access-team <team>.cloudflareaccess.com --access-aud <application AUD tag> (see README › Admin access).");
}

const state = saveState(env, { d1: { name: names.db, id: dbId }, kv: { title: kv.title, id: kv.id }, r2: names.r2, queue: names.queue });
ok(`resources recorded in ${state.replace(/.*\.tower/, ".tower")}`);

step("Next");
console.log(`  node scripts/secrets.mjs --env ${env}     # alert webhooks (optional)`);
console.log(`  node scripts/deploy.mjs --env ${env}      # migrate D1, deploy tower-core then tower-api`);
