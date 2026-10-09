import { describe, expect, it } from "vitest";
import {
  amountOf, classifyPost, compact, controversy, decodeWitnessProps, gini, imageInfo, memoRef, nakamoto, orderedOps,
  parseAmount, parsePrice, pixaPerPxs, captureCost, bucketStart, chainTime,
} from "@tower/core";
import { cfg, counts, freshDb, ingestFixtures, loadFixture } from "./helpers";

const fixture = loadFixture();

describe("assets", () => {
  it("parses legacy strings and NAI objects to integer units", () => {
    expect(parseAmount("1.000 PIXA")).toEqual({ amount: 1000, asset: "PIXA" });
    expect(parseAmount("0.020 PXS")).toEqual({ amount: 20, asset: "PXS" });
    expect(parseAmount("1000.000000 VESTS")).toEqual({ amount: 1_000_000_000, asset: "VESTS" });
    expect(parseAmount({ amount: "6772", precision: 3, nai: "@@000000013" })).toEqual({ amount: 6772, asset: "PXS" });
    expect(parseAmount("5.000 HBD")).toEqual({ amount: 5000, asset: "PXS" });
    expect(amountOf("1.000 PIXA", "PXS")).toBe(0);
    expect(parseAmount("garbage")).toBeNull();
  });
  it("reads the feed as PIXA per PXS", () => {
    const p = parsePrice({ base: "1.000 PXS", quote: "51.833 PIXA" })!;
    expect(pixaPerPxs(p)).toBeCloseTo(51.833, 3);
  });
});

describe("formulas", () => {
  it("controversy is 0 when unanimous and 1 at a perfect split", () => {
    expect(controversy(100, 0)).toBe(0);
    expect(controversy(50, 50)).toBe(1);
    expect(controversy(75, 25)).toBeCloseTo(0.5);
    expect(controversy(0, 0)).toBeNull();
  });
  it("gini and nakamoto", () => {
    expect(gini([1, 1, 1, 1])).toBeCloseTo(0);
    expect(gini([0, 0, 0, 100])).toBeCloseTo(0); // zeros are excluded: one holder among holders
    expect(gini([1, 1, 1, 97])!).toBeGreaterThan(0.7);
    expect(nakamoto([60, 20, 20])).toBe(1);
    expect(nakamoto([30, 30, 20, 20])).toBe(2);
  });
});

describe("capture cost", () => {
  const w = (owner: string, votes: number, key = "PIX5abc" + owner) => ({ owner, votes, signing_key: key });
  it("free seats cost nothing", () => {
    const r = captureCost({ witnesses: [w("a", 10e12), w("b", 9e12), w("c", 8e12)], maxVoted: 20, maxRunner: 1, hfRequired: 17, vestsToPixa: 1 });
    expect(r.freeSeats).toBe(17);
    expect(r.targets.find((t) => t.goal === "majority")!.costPxp).toBe(0);
  });
  it("a full schedule must be outvoted", () => {
    const ws = Array.from({ length: 21 }, (_, i) => w(`w${i}`, (21 - i) * 1e12));
    const r = captureCost({ witnesses: ws, maxVoted: 20, maxRunner: 1, hfRequired: 17, vestsToPixa: 1 });
    expect(r.freeSeats).toBe(0);
    expect(r.bench).toBe(1);
    const maj = r.targets.find((t) => t.goal === "majority")!;
    expect(maj.seats).toBe(11);
    // must beat the 11th weakest of 20 elected: w9 with 12e12 VESTS units → 12M PXP
    expect(maj.weakestDisplaced).toBe("w9");
    expect(Math.round(maj.costPxp)).toBe(12_000_000);
  });
  it("ignores witnesses with the null key", () => {
    const r = captureCost({ witnesses: [w("a", 1e12), w("off", 5e12, "PIX1111111111111111111111111111111114T1Anm")], maxVoted: 20, maxRunner: 1, hfRequired: 7, vestsToPixa: 1 });
    expect(r.eligible).toBe(1);
  });
});

describe("helpers", () => {
  it("memoRef finds a post in a memo", () => {
    expect(memoRef("great piece @tetiana/boat-1789128331976 !")).toBe("tetiana/boat-1789128331976");
    expect(memoRef("#encrypted @a/b")).toBeNull();
    expect(memoRef("thanks")).toBeNull();
  });
  it("classifies content the way the spec defines", () => {
    expect(classifyPost({ parent_author: "x", parent_permlink: "y", body: "hi" }, null)).toBe("reply");
    expect(classifyPost({ parent_author: "", parent_permlink: "portal-156480", body: "text" }, { format: "markdown" })).toBe("blog");
    expect(classifyPost({ parent_author: "", parent_permlink: "art", body: "data:image/webp;base64,AAAA" }, {})).toBe("artwork");
    expect(classifyPost({ parent_author: "", parent_permlink: "art", body: "data:image/webp;base64,AA<script>" }, {})).toBe("other");
  });
  it("decodes witness_set_properties values", () => {
    // maximum_block_size 2097152 = 0x00200000 little endian; url "ab" = varint 2 + 0x61 0x62
    const p = decodeWitnessProps([["maximum_block_size", "00002000"], ["url", "026162"]]);
    expect(p.maximum_block_size).toBe(2097152);
    expect(p.url).toBe("ab");
  });
  it("buckets weeks on Monday", () => {
    const t = chainTime("2026-10-08T15:00:00"); // a Thursday
    expect(new Date(bucketStart(t, "week") * 1000).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(new Date(bucketStart(t, "month") * 1000).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("compact", () => {
  it("merges append-only inserts within the parameter limit and keeps other statements in order", () => {
    const stmts = [
      { sql: "UPDATE posts SET x = 1 WHERE a = ?", params: [1] },
      ...Array.from({ length: 40 }, (_, i) => ({ sql: "INSERT OR IGNORE INTO op_log (block, pos, account, ts, type, sub) VALUES (?,?,?,?,?,?)", params: [1, i, "a", 0, "vote", null] })),
      { sql: "DELETE FROM follows WHERE follower = ?", params: ["a"] },
    ];
    const out = compact(stmts);
    expect(out[0].sql).toContain("UPDATE posts");
    expect(out[1].sql).toContain("DELETE FROM follows");
    const merged = out.slice(2);
    expect(merged.length).toBe(3); // 16 rows of 6 params per statement
    expect(merged.every((s) => s.params.length <= 99)).toBe(true);
    expect(merged.reduce((n, s) => n + s.params.length, 0)).toBe(240);
  });
});

describe("real Pixa blocks", () => {
  it("orders signed operations before the virtual ones they cause", () => {
    const withVote = fixture.find((b) => b.vops.some((v) => v.op.type === "effective_comment_vote_operation"))!;
    const [{ ops }] = orderedOps([withVote.block], withVote.num, withVote.vops);
    const vote = ops.findIndex((o) => o.type === "vote");
    const eff = ops.findIndex((o) => o.type === "effective_comment_vote");
    expect(vote).toBeGreaterThanOrEqual(0);
    expect(eff).toBeGreaterThan(vote);
  });

  it("reads artwork dimensions from the body", () => {
    const art = fixture
      .flatMap((b) => b.block.transactions.flatMap((t) => t.operations))
      .find((o) => o.type === "comment_operation" && String(o.value.body).startsWith("data:image/"));
    expect(art).toBeTruthy();
    const info = imageInfo(String(art!.value.body));
    expect(info!.width).toBeGreaterThan(0);
    expect(info!.height).toBeGreaterThan(0);
  });

  it("ingests every fixture block without parse errors or unknown operations", async () => {
    const { shim, db } = freshDb();
    await ingestFixtures(db, fixture);
    const bad = shim.sqlite.prepare(`SELECT kind, subject, detail FROM invariant_events WHERE kind IN ('parse_error','unknown_op')`).all();
    expect(bad).toEqual([]);
    const c = counts(shim, ["blocks", "op_log", "accounts", "posts", "votes", "rewards", "feeds", "witness_events", "community_ops", "follows", "transfers", "stake_events", "market_events"]);
    expect(c.blocks).toBe(fixture.length);
    for (const t of ["op_log", "accounts", "posts", "votes", "rewards", "feeds", "community_ops", "stake_events"]) expect(c[t], t).toBeGreaterThan(0);
  });

  it("follows one artwork from publication to payout", async () => {
    const { shim, db } = freshDb();
    await ingestFixtures(db, fixture);
    const post = shim.sqlite.prepare(`SELECT * FROM posts WHERE author = 'tetiana' AND permlink = 'boat-1789128331976'`).get() as Record<string, any>;
    expect(post.kind).toBe("artwork");
    expect(post.image_format).toMatch(/^webp/);
    expect(post.width).toBeGreaterThan(0);
    expect(post.paid).toBe(1);
    expect(post.total_payout_pxs).toBeGreaterThan(0);
    expect(post.up_count).toBeGreaterThan(0);
    const author = shim.sqlite.prepare(`SELECT * FROM rewards WHERE type = 'author' AND author = 'tetiana' AND permlink = 'boat-1789128331976'`).get() as Record<string, any>;
    expect(author.pxs).toBe(6772);
    expect(author.vests).toBe(351062999);
  });

  it("is idempotent: ingesting everything twice changes nothing", async () => {
    const { shim, db } = freshDb();
    await ingestFixtures(db, fixture);
    const tables = ["blocks", "op_log", "accounts", "posts", "votes", "rewards", "feeds", "witness_events", "community_ops", "follows", "transfers", "stake_events", "invariant_events"];
    const before = counts(shim, tables);
    const snap = (sql: string) => JSON.stringify(shim.sqlite.prepare(sql).all());
    const postsBefore = snap(`SELECT * FROM posts ORDER BY author, permlink`);
    const accountsBefore = snap(`SELECT * FROM accounts ORDER BY name`);
    await ingestFixtures(db, fixture);
    expect(counts(shim, tables)).toEqual(before);
    expect(snap(`SELECT * FROM posts ORDER BY author, permlink`)).toBe(postsBefore);
    expect(snap(`SELECT * FROM accounts ORDER BY name`)).toBe(accountsBefore);
  });

  it("flags a vote by a restricted treasury account", async () => {
    const { shim, db } = freshDb();
    const b = structuredClone(fixture.find((x) => x.block.transactions.some((t) => t.operations.some((o) => o.type === "vote_operation")))!);
    const op = b.block.transactions.flatMap((t) => t.operations).find((o) => o.type === "vote_operation")!;
    op.value.voter = "pixa.rex";
    await ingestFixtures(db, [b]);
    const ev = shim.sqlite.prepare(`SELECT * FROM invariant_events WHERE kind = 'restricted_account_voted'`).all() as Record<string, any>[];
    expect(ev.length).toBe(1);
    expect(ev[0].subject).toBe("pixa.rex");
    expect(cfg.restrictedAccounts.has("pixa.rex")).toBe(true);
  });
});
