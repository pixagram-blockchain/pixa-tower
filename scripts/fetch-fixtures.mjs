#!/usr/bin/env node
// Fetch real Pixa blocks and their virtual operations into test/fixtures, for parser and pipeline tests.
//
//   node scripts/fetch-fixtures.mjs --blocks 1,21,402315 --out test/fixtures/sample.json
//   node scripts/fetch-fixtures.mjs --post tetiana/boat-1789128331976 --out test/fixtures/payout.json
//   node scripts/fetch-fixtures.mjs --range 1000000-1000200 --out test/fixtures/range.json
//
// Options: --node https://api.pixagram.com   --append (merge with an existing file)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const NODE = args.node || "https://api.pixagram.com";
const OUT = args.out || "test/fixtures/sample.json";

async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(NODE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function vopsFor(num) {
  const out = [];
  let params = { block_range_begin: num, block_range_end: num + 1, include_reversible: false, limit: 1000 };
  for (;;) {
    const r = await rpc("account_history_api.enum_virtual_ops", params);
    out.push(...r.ops);
    if (r.next_operation_begin && r.next_operation_begin !== "0") {
      params = { ...params, block_range_begin: r.next_block_range_begin, operation_begin: r.next_operation_begin };
    } else break;
  }
  return out;
}

async function blocksOfPost(author, permlink) {
  const nums = new Set();
  let start = -1;
  for (let page = 0; page < 50; page++) {
    const r = await rpc("account_history_api.get_account_history", { account: author, start, limit: 1000, include_reversible: false });
    for (const [, h] of r.history) {
      const v = h.op.value ?? {};
      if (v.permlink === permlink || v.comment_permlink === permlink || v.parent_permlink === permlink) nums.add(h.block);
    }
    const first = r.history[0]?.[0];
    if (!first || first === 0 || r.history.length < 1000) break;
    start = first - 1;
  }
  return [...nums].sort((a, b) => a - b);
}

let nums = [];
if (args.blocks) {
  const raw = String(args.blocks);
  nums = existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")) : raw.split(",").map(Number);
}
if (args.range) {
  const [a, b] = String(args.range).split("-").map(Number);
  for (let n = a; n <= b; n++) nums.push(n);
}
if (args.post) {
  const [author, permlink] = String(args.post).split("/");
  const found = await blocksOfPost(author, permlink);
  console.log(`post ${author}/${permlink}: ${found.length} blocks`);
  nums.push(...found);
}
nums = [...new Set(nums.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
if (nums.length === 0) {
  console.error("nothing to fetch: pass --blocks, --range or --post");
  process.exit(1);
}

const existing = args.append && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { node: NODE, fetched_at: null, blocks: [] };
const have = new Set(existing.blocks.map((b) => b.num));
for (const num of nums) {
  if (have.has(num)) continue;
  const r = await rpc("block_api.get_block_range", { starting_block_num: num, count: 1 });
  const block = r.blocks[0];
  if (!block) continue;
  const vops = await vopsFor(num);
  existing.blocks.push({ num, block, vops });
  process.stdout.write(`.${block.transactions.length ? "t" : ""}`);
}
existing.blocks.sort((a, b) => a.num - b.num);
existing.fetched_at = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(existing));
console.log(`\n${existing.blocks.length} blocks → ${OUT}`);
