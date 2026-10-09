#!/usr/bin/env node
// Admin CLI for a deployed Tower.
//
// Auth: a Cloudflare Access service token (CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET),
//       or ADMIN_TOKEN on staging / local dev.
// Base URL: --base or TOWER_URL (default http://localhost:8788).
//
//   node scripts/admin.mjs status
//   node scripts/admin.mjs scanner
//   node scripts/admin.mjs pause | resume
//   node scripts/admin.mjs rewind 950000
//   node scripts/admin.mjs replay 949000 951000
//   node scripts/admin.mjs recompute votes_cast 2026-09-04 [2026-10-09]
//   node scripts/admin.mjs run snapshot|hourly|daily
//   node scripts/admin.mjs alerts
//   node scripts/admin.mjs ack 12 "expected during backfill" [--close]
//   node scripts/admin.mjs action --alert 12 --lever witness_vote --description "Unvoted witness X" [--tx abc]
//   node scripts/admin.mjs threshold capture_cost '{"dim":"majority","grain":"hour","op":"lt","amber":5000000,"red":1}'

import { parseArgs } from "./lib.mjs";

const args = parseArgs();
const base = String(args.base ?? process.env.TOWER_URL ?? "http://localhost:8788").replace(/\/$/, "");
const headers = { "content-type": "application/json" };
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
}
if (process.env.ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.ADMIN_TOKEN}`;

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = text;
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, typeof out === "string" ? out.slice(0, 500) : JSON.stringify(out, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(out?.data ?? out, null, 2));
}

const [cmd, a, b, c] = args._;
switch (cmd) {
  case "status":
    await call("GET", "/v1/status");
    break;
  case "scanner":
    await call("GET", "/v1/admin/scanner");
    break;
  case "pause":
  case "resume":
    await call("POST", `/v1/admin/scanner/${cmd}`);
    break;
  case "rewind":
    await call("POST", "/v1/admin/scanner/rewind", { block: Number(a) });
    break;
  case "run":
    await call("POST", `/v1/admin/scanner/${a}`);
    break;
  case "replay":
    await call("POST", "/v1/admin/replay", { from: Number(a), to: Number(b) });
    break;
  case "recompute":
    await call("POST", "/v1/admin/recompute", { metric: a === "all" ? undefined : a, from: b, to: c });
    break;
  case "alerts":
    await call("GET", "/v1/alerts?state=open");
    break;
  case "ack":
    await call("POST", `/v1/admin/alerts/${a}/ack`, { note: b ?? "", close: !!args.close });
    break;
  case "action":
    await call("POST", "/v1/admin/actions", {
      alert_id: args.alert ? Number(args.alert) : undefined, lever: args.lever, description: args.description, tx_id: args.tx,
      metric: args.metric, dim: args.dim,
    });
    break;
  case "threshold":
    await call("PUT", `/v1/admin/thresholds/${a}`, JSON.parse(b ?? "{}"));
    break;
  default:
    console.log("commands: status scanner pause resume rewind replay recompute run alerts ack action threshold (see the header of this file)");
    process.exit(cmd ? 1 : 0);
}
