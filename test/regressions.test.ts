// Regression tests for defects found in review. Each builds a minimal synthetic block.
import { describe, expect, it } from "vitest";
import { compact, evaluateThresholds, parseRange, replaySafe, type RawBlock } from "@tower/core";
import { cfg, freshDb } from "./helpers";

const T0 = Date.parse("2026-10-01T00:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19);

function block(num: number, ops: { type: string; value: Record<string, unknown> }[]): RawBlock {
  return {
    previous: "", timestamp: iso(T0 + num * 3), witness: "w", block_id: `id${num}`,
    transactions: ops.map((o) => ({ operations: [{ type: `${o.type}_operation`, value: o.value }] })),
    transaction_ids: ops.map((_, i) => `tx${num}-${i}`),
  };
}

async function apply(db: D1Database, num: number, ops: { type: string; value: Record<string, unknown> }[], replay = false) {
  const parsed = await parseRange([block(num, ops)], num, [], cfg, { hashBody: async (b) => String(b.length) });
  const stmts = compact(replay ? replaySafe(parsed.stmts.items) : parsed.stmts.items);
  await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...(s.params as unknown[]))));
}

const n = (shim: { sqlite: { prepare(s: string): { get(...a: unknown[]): unknown } } }, sql: string, ...a: unknown[]) =>
  (shim.sqlite.prepare(sql).get(...a) as { n: number }).n;

describe("review regressions", () => {
  it("a replay of an old range does not resurrect a witness vote that was later removed", async () => {
    const { shim, db } = freshDb();
    await apply(db, 10, [{ type: "account_witness_vote", value: { account: "alice", witness: "bob", approve: true } }]);
    await apply(db, 11, [{ type: "account_witness_vote", value: { account: "alice", witness: "bob", approve: false } }]);
    expect(n(shim, `SELECT COUNT(*) AS n FROM witness_votes`)).toBe(0);
    await apply(db, 10, [{ type: "account_witness_vote", value: { account: "alice", witness: "bob", approve: true } }], true);
    expect(n(shim, `SELECT COUNT(*) AS n FROM witness_votes`)).toBe(0);
    expect(n(shim, `SELECT COUNT(*) AS n FROM witness_votes_log`)).toBe(2); // the event log is still complete
  });

  it("a reblog undone in the same range leaves no row", async () => {
    const { shim, db } = freshDb();
    const cj = (json: unknown) => ({ type: "custom_json", value: { id: "follow", required_auths: [], required_posting_auths: ["bob"], json: JSON.stringify(json) } });
    await apply(db, 20, [cj(["reblog", { account: "bob", author: "a", permlink: "p" }]), cj(["reblog", { account: "bob", author: "a", permlink: "p", delete: "delete" }])]);
    expect(n(shim, `SELECT COUNT(*) AS n FROM reblogs`)).toBe(0);
  });

  it("a permlink published again after delete_comment is a live post", async () => {
    const { shim, db } = freshDb();
    const post = (body: string) => ({
      type: "comment",
      value: { parent_author: "", parent_permlink: "art", author: "carol", permlink: "x", title: "X", body, json_metadata: '{"format":"image"}' },
    });
    await apply(db, 30, [post("data:image/webp;base64,AAAA")]);
    await apply(db, 31, [{ type: "delete_comment", value: { author: "carol", permlink: "x" } }]);
    expect(n(shim, `SELECT deleted AS n FROM posts WHERE permlink = 'x'`)).toBe(2);
    await apply(db, 40, [post("data:image/webp;base64,BBBB")]);
    const row = shim.sqlite.prepare(`SELECT deleted, created_block, edit_count FROM posts WHERE permlink = 'x'`).get() as Record<string, number>;
    expect(row).toEqual({ deleted: 0, created_block: 40, edit_count: 0 });
    // Replaying the old delete does not remove the new post.
    await apply(db, 31, [{ type: "delete_comment", value: { author: "carol", permlink: "x" } }], true);
    expect(n(shim, `SELECT deleted AS n FROM posts WHERE permlink = 'x'`)).toBe(0);
  });

  it("counts every missed slot, even several before one block", async () => {
    const { shim, db } = freshDb();
    const vop = (producer: string, i: number) => ({
      trx_id: "0", block: 50, trx_in_block: 4294967295, op_in_trx: i, virtual_op: true, timestamp: iso(T0 + 150),
      op: { type: "producer_missed_operation", value: { producer } },
    });
    const parsed = await parseRange([block(50, [])], 50, [vop("w1", 1), vop("w2", 2)], cfg);
    const stmts = compact(parsed.stmts.items);
    await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...(s.params as unknown[]))));
    expect(n(shim, `SELECT COUNT(*) AS n FROM witness_missed`)).toBe(2);
  });

  it("a per-dimension alert closes when the dimension goes quiet", async () => {
    const { shim, db } = freshDb();
    const day = (k: number) => T0 + k * 86400;
    const put = (bucket: number, value: number) =>
      shim.sqlite.prepare(`INSERT OR REPLACE INTO metric_rollup (metric, grain, dim, bucket, value) VALUES ('witness_missed_blocks','day','w1',?,?)`).run(bucket, value);
    put(day(0), 200);
    await evaluateThresholds(db, day(1) + 3600); // day 0 closed: 200 > 144 → red
    expect(n(shim, `SELECT COUNT(*) AS n FROM alerts WHERE state = 'open' AND dim = 'w1'`)).toBe(1);
    // No misses on days 1 and 2: no rows at all for w1, which means 0 for a counter.
    await evaluateThresholds(db, day(2) + 3600);
    await evaluateThresholds(db, day(3) + 3600);
    expect(n(shim, `SELECT COUNT(*) AS n FROM alerts WHERE state = 'open' AND dim = 'w1'`)).toBe(0);
  });
});
