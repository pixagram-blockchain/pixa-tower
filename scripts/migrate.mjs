#!/usr/bin/env node
// Apply D1 migrations.
//   node scripts/migrate.mjs --env staging            # remote
//   node scripts/migrate.mjs --env staging --local    # local dev database (.wrangler/state)
//   node scripts/migrate.mjs --env production --list  # show pending migrations only

import { CORE_CONFIG, ENVS, ok, parseArgs, requireEnv, step, wrangler } from "./lib.mjs";

const args = parseArgs();
const env = requireEnv(args);
const db = ENVS[env].db;
const where = args.local ? ["--local", "--persist-to", ".wrangler/state"] : ["--remote"];

if (args.list) {
  step(`Pending migrations for ${db} (${args.local ? "local" : "remote"})`);
  console.log(wrangler(["d1", "migrations", "list", db, "-c", CORE_CONFIG, "--env", env, ...where]));
  process.exit(0);
}

step(`Applying migrations to ${db} (${args.local ? "local" : "remote"})`);
const out = wrangler(["d1", "migrations", "apply", db, "-c", CORE_CONFIG, "--env", env, ...where], { input: "y\n" });
console.log(out.split("\n").filter((l) => /│|migrat|✅|No migrations/i.test(l)).join("\n"));
ok("migrations applied");
