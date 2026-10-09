#!/usr/bin/env node
// Check, migrate and deploy one environment.
//   node scripts/deploy.mjs --env staging
//   node scripts/deploy.mjs --env production [--skip-tests] [--skip-migrate] [--dry-run]
//
// Order matters: tower-core first (it owns the scanner and the queue consumer),
// then tower-api (it binds tower-core as a service).

import { API_CONFIG, CORE_CONFIG, ENVS, fail, loadState, ok, parseArgs, readText, requireEnv, run, step, warn, wrangler } from "./lib.mjs";

const args = parseArgs();
const env = requireEnv(args);
const names = ENVS[env];

step(`Deploying Pixa Tower (${env})`);
for (const [path, label] of [[CORE_CONFIG, "core"], [API_CONFIG, "api"]]) {
  const text = readText(path);
  if (text.includes(`__D1_ID_${env.toUpperCase()}__`) || text.includes(`__KV_ID_${env.toUpperCase()}__`)) {
    fail(`apps/${label}/wrangler.jsonc has no resource ids for ${env}: run node scripts/setup.mjs --env ${env}`);
  }
}
if (env === "production" && readText(API_CONFIG).includes("__ACCESS_")) {
  warn("Cloudflare Access is not configured: admin routes will refuse every call until it is (see README).");
}
ok(`resources: ${JSON.stringify(loadState(env).d1 ?? names.db)}`);

if (!args["skip-tests"]) {
  step("Typecheck and tests");
  run("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
  ok("typecheck");
  run("npx", ["vitest", "run"]);
  ok("tests");
}

const dry = args["dry-run"] ? ["--dry-run", "--outdir", `.wrangler/dist-${env}`] : [];

if (!args["skip-migrate"] && !args["dry-run"]) {
  step(`D1 migrations on ${names.db}`);
  wrangler(["d1", "migrations", "apply", names.db, "-c", CORE_CONFIG, "--env", env, "--remote"], { input: "y\n" });
  ok("migrations applied");
}

step(`Deploy ${names.core}`);
console.log(wrangler(["deploy", "-c", CORE_CONFIG, "--env", env, ...dry]).split("\n").filter((l) => /Uploaded|Deployed|schedule|Current Version|dry-run/i.test(l)).join("\n"));
ok(`${names.core} ${dry.length ? "bundled (dry run)" : "deployed"}`);

step(`Deploy ${names.api}`);
const apiOut = wrangler(["deploy", "-c", API_CONFIG, "--env", env, ...dry]);
console.log(apiOut.split("\n").filter((l) => /Uploaded|Deployed|https:\/\/|Current Version|dry-run/i.test(l)).join("\n"));
ok(`${names.api} ${dry.length ? "bundled (dry run)" : "deployed"}`);

if (!args["dry-run"]) {
  const url = apiOut.match(/https:\/\/\S+/)?.[0] ?? (env === "production" ? "https://tower.pixa.org" : "(see workers.dev URL above)");
  step("Done");
  console.log(`  The scanner starts on the next 5-minute cron and backfills from START_BLOCK.`);
  console.log(`  Watch it:   curl ${url}/v1/status`);
  console.log(`  Logs:       npx wrangler tail ${names.core}`);
  console.log(`  Overview:   curl ${url}/v1/overview   (after the first snapshot, within 5 minutes)`);
}
