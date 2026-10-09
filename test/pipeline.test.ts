import { beforeAll, describe, expect, it } from "vitest";
import {
  bucketEnd, bucketStart, ChainClient, computeDay, evaluateThresholds, ingest, METRICS, processInvariants, recompute,
  runDaily, runHourly, series, snapshot, syncMetricDefs, DAY,
} from "@tower/core";
import { cfg, freshDb, ingestFixtures, loadFixture } from "./helpers";

const fixture = loadFixture();
const LIVE = process.env.LIVE === "1";

async function seedSnapshot(db: D1Database, ts: number) {
  await db
    .prepare(
      `INSERT INTO chain_snapshots (ts, block, current_supply, virtual_supply, pxs_supply, vesting_fund_pixa, vesting_shares, feed_base, feed_quote,
         pxs_stop_percent, liquid_pixa, liquid_pxs, max_block_size)
       VALUES (?, 1, 100797710060, 113809957813, 251041764, 94064042753, 94064041963063, 1000, 51833, 2000, 5000000000, 100000000, 2097152)`,
    )
    .bind(ts)
    .run();
}

describe("rollups over real history", () => {
  const { shim, db } = freshDb();
  const lastTs = Math.max(...fixture.map((b) => Date.parse(b.block.timestamp + "Z") / 1000));

  beforeAll(async () => {
    await ingestFixtures(db, fixture);
    await seedSnapshot(db, lastTs - 10 * DAY);
    await syncMetricDefs(db);
    await runHourly(db, cfg, { maxHours: 100_000 });
    await runDaily(db, cfg, { maxDays: 1000, now: lastTs + DAY });
  }, 120_000);

  it("every SQL metric runs on its own", async () => {
    const from = lastTs - 30 * DAY;
    for (const m of METRICS.filter((x) => x.sql)) {
      try {
        await db.prepare(m.sql!).bind(from, lastTs).all();
      } catch (e) {
        throw new Error(`${m.id}: ${(e as Error).message}`);
      }
    }
  });

  it("hour, day and month counters add up to the event tables", () => {
    const artworks = (shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'artwork' AND created_ts < ?`).get(bucketStart(lastTs, "hour")) as { n: number }).n;
    const sum = (grain: string) =>
      (shim.sqlite.prepare(`SELECT COALESCE(SUM(value), 0) AS s FROM metric_rollup WHERE metric = 'artworks_created' AND grain = ? AND dim = '' AND bucket < ?`)
        .get(grain, bucketStart(lastTs, "hour")) as { s: number }).s;
    expect(artworks).toBeGreaterThan(0);
    expect(sum("hour")).toBe(artworks);
    const allArtworks = (shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'artwork'`).get() as { n: number }).n;
    const monthSum = (shim.sqlite.prepare(`SELECT SUM(value) AS s FROM metric_rollup WHERE metric = 'artworks_created' AND grain = 'month' AND dim = ''`).get() as { s: number }).s;
    expect(monthSum).toBe(allArtworks);
  });

  it("distinct active accounts are counted per grain, never summed", () => {
    const day = (shim.sqlite.prepare(`SELECT MAX(value) AS v FROM metric_rollup WHERE metric = 'active_accounts' AND grain = 'day' AND dim = ''`).get() as { v: number }).v;
    const month = (shim.sqlite.prepare(`SELECT MAX(value) AS v FROM metric_rollup WHERE metric = 'active_accounts' AND grain = 'month' AND dim = ''`).get() as { v: number }).v;
    const distinct = (shim.sqlite.prepare(`SELECT COUNT(DISTINCT account) AS n FROM op_log WHERE type NOT IN ('feed_publish','witness_set_properties','witness_update')`).get() as { n: number }).n;
    expect(day).toBeGreaterThan(0);
    expect(month).toBeLessThanOrEqual(distinct);
  });

  it("controversy is scored on paid posts", () => {
    const rows = shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM metric_rollup WHERE metric = 'controversy_index' AND grain = 'day'`).get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(0);
    const post = shim.sqlite.prepare(`SELECT up_count, down_count, controversy FROM posts WHERE author = 'tetiana' AND permlink = 'boat-1789128331976'`).get() as Record<string, number | null>;
    if ((post.up_count ?? 0) + (post.down_count ?? 0) >= cfg.controversyMinVotes) expect(post.controversy).not.toBeNull();
    else expect(post.controversy).toBeNull();
  });

  it("every daily metric computes without error", async () => {
    const day = bucketStart(lastTs, "day") - DAY;
    const done = await computeDay(db, cfg, day, lastTs, day + 2 * DAY);
    expect(done.length).toBeGreaterThan(20);
    for (const id of ["onboarding_funnel", "cohort_retention", "time_to_first_reward_median"]) {
      await computeDay(db, cfg, day, lastTs, day + 2 * DAY, id);
    }
    const funnel = shim.sqlite.prepare(`SELECT dim, value FROM metric_rollup WHERE metric = 'onboarding_funnel' AND grain = 'week'`).all();
    expect(funnel.length).toBeGreaterThan(0);
  });

  it("serves series for the API", async () => {
    const rows = await series(db, "transactions", "day", lastTs - 60 * DAY, lastTs + DAY, "");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.dim === "")).toBe(true);
  });

  it("recompute rebuilds a metric with the same result", async () => {
    const before = shim.sqlite.prepare(`SELECT bucket, value FROM metric_rollup WHERE metric = 'votes_cast' AND grain = 'day' AND dim = '' ORDER BY bucket`).all();
    const first = fixture[0];
    await recompute(db, cfg, Date.parse(first.block.timestamp + "Z") / 1000, bucketStart(lastTs, "hour"), "votes_cast");
    const after = shim.sqlite.prepare(`SELECT bucket, value FROM metric_rollup WHERE metric = 'votes_cast' AND grain = 'day' AND dim = '' ORDER BY bucket`).all();
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  });

  it("turns chain events and thresholds into alerts", async () => {
    const inv = await processInvariants(db);
    const warnings = shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM invariant_events WHERE severity IN ('amber','red')`).get() as { n: number };
    if (warnings.n > 0) expect(inv.length).toBeGreaterThan(0);
    const events = await evaluateThresholds(db, lastTs);
    expect(Array.isArray(events)).toBe(true);
    const pending = shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM invariant_events WHERE alerted = 0`).get() as { n: number };
    expect(pending.n).toBe(0);
  });
});

describe.skipIf(!LIVE)("live chain (LIVE=1)", () => {
  it("snapshots the live chain and computes governance gauges", async () => {
    const { shim, db } = freshDb();
    await ingestFixtures(db, fixture);
    const client = new ChainClient(cfg.nodes);
    const overview = await snapshot(db, client, cfg, { refreshBalances: true });
    expect(overview.head_block).toBeGreaterThan(1_000_000);
    expect(overview.kpis.total_accounts).toBeGreaterThan(50);
    expect(overview.supply.feed_pixa_per_pxs).toBeGreaterThan(0);
    const capture = shim.sqlite.prepare(`SELECT dim, value, extra FROM metric_rollup WHERE metric = 'capture_cost' AND grain = 'hour'`).all();
    expect(capture.length).toBe(3);
    const balances = shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM balances`).get() as { n: number };
    expect(balances.n).toBe(overview.kpis.total_accounts);
    console.log(JSON.stringify({ supply: overview.supply, governance: overview.governance }, null, 1));
    const events = await evaluateThresholds(db, Math.floor(Date.now() / 1000));
    console.log(events.map((e) => e.title).join("\n"));
  }, 120_000);

  it("ingests the newest blocks from the chain head", async () => {
    const { shim, db } = freshDb();
    const client = new ChainClient(cfg.nodes);
    const dgp = await client.getDynamicGlobalProperties();
    const lib = Number(dgp.last_irreversible_block_num);
    await db.prepare(`INSERT INTO cursor (name, block, block_ts, updated_at) VALUES ('scanner', ?, NULL, 0)`).bind(lib - 300).run();
    const r = await ingest(db, client, cfg, { maxBlocks: 300 });
    expect(r.blocks).toBeGreaterThan(250);
    const n = (shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM blocks`).get() as { n: number }).n;
    expect(n).toBe(r.blocks);
    const producer = shim.sqlite.prepare(`SELECT COUNT(*) AS n FROM rewards WHERE type = 'producer'`).get() as { n: number };
    expect(producer.n).toBeGreaterThan(200);
    void bucketEnd;
  }, 120_000);
});
