// Every 5 minutes: read chain state that is not in blocks (supply, feed, witnesses, balances, proposals),
// store snapshot rows and write gauge metrics. Returns the overview the API serves from KV.

import { amountOf, parseAmount, parsePrice, pick, pixaPerPxs } from "./assets";
import { PORTAL_RE, type TowerConfig } from "./config";
import { captureCost, isNullKey, sharedKeys, type WitnessInfo } from "./governance";
import { median } from "./formulas";
import { gaugeStmts } from "./rollup";
import type { ChainClient } from "./rpc";
import { all, compact, first, type Stmt } from "./sql";
import { chainTime, DAY, HOUR } from "./time";

type Obj = Record<string, any>;

export interface SnapshotOptions {
  refreshBalances: boolean; // full account refresh this run
  now?: number;
}

export interface Overview {
  as_of_block: number;
  as_of_time: string;
  generated_at: string;
  head_block: number;
  lib: number;
  ingest_lag_blocks: number;
  kpis: Record<string, number | null>;
  supply: Record<string, number | null>;
  governance: Record<string, unknown>;
  open_alerts: number;
}

const toPixa = (raw: unknown) => amountOf(raw, "PIXA");
const toPxs = (raw: unknown) => amountOf(raw, "PXS");
const toVests = (raw: unknown) => amountOf(raw, "VESTS");

// Snapshot writes touch distinct rows, so their single-row upserts can be merged (fewer D1 statements).
const SNAPSHOT_TABLES = ["accounts", "balances", "posting_grants", "witness_snapshots", "metric_rollup", "proposals", "communities", "chain_snapshots"];

async function batch(db: D1Database, all: Stmt[], size = 400) {
  const stmts = compact(all, 99, SNAPSHOT_TABLES);
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size).map((s) => db.prepare(s.sql).bind(...s.params)));
  }
}

/** Page through every account (1,000 per call) and refresh balances, recovery and posting grants. */
export async function refreshAccounts(db: D1Database, client: ChainClient, cfg: TowerConfig, now: number): Promise<number> {
  let start = "";
  let total = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const r = await client.call<{ accounts: Obj[] }>("database_api.list_accounts", { start, limit: 1000, order: "by_name" });
    const page = (r.accounts ?? []).filter((a) => a.name !== start || start === "");
    if (page.length === 0) break;
    const stmts: Stmt[] = [];
    for (const a of page) {
      const name: string = a.name;
      const created = a.created ? chainTime(a.created) : null;
      stmts.push({
        sql: `INSERT INTO accounts (name, created_ts, recovery_account, is_system, is_portal) VALUES (?,?,?,?,?)
              ON CONFLICT(name) DO UPDATE SET created_ts = COALESCE(accounts.created_ts, excluded.created_ts),
                recovery_account = excluded.recovery_account, is_system = excluded.is_system, is_portal = excluded.is_portal`,
        params: [name, created && created > 0 ? created : null, a.recovery_account ?? null, cfg.systemAccounts.has(name) ? 1 : 0, PORTAL_RE.test(name) ? 1 : 0],
      });
      const next = a.next_vesting_withdrawal ? chainTime(a.next_vesting_withdrawal) : null;
      stmts.push({
        sql: `INSERT INTO balances (account, pixa, pxs, savings_pixa, savings_pxs, vests, delegated_out, received, withdraw_rate,
                next_withdrawal_ts, to_withdraw, withdrawn, reward_pixa, reward_pxs, reward_vests, proxy, witnesses_voted_for,
                recovery_account, last_post_ts, last_vote_ts, updated_ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(account) DO UPDATE SET pixa=excluded.pixa, pxs=excluded.pxs, savings_pixa=excluded.savings_pixa,
                savings_pxs=excluded.savings_pxs, vests=excluded.vests, delegated_out=excluded.delegated_out, received=excluded.received,
                withdraw_rate=excluded.withdraw_rate, next_withdrawal_ts=excluded.next_withdrawal_ts, to_withdraw=excluded.to_withdraw,
                withdrawn=excluded.withdrawn, reward_pixa=excluded.reward_pixa, reward_pxs=excluded.reward_pxs,
                reward_vests=excluded.reward_vests, proxy=excluded.proxy, witnesses_voted_for=excluded.witnesses_voted_for,
                recovery_account=excluded.recovery_account, last_post_ts=excluded.last_post_ts, last_vote_ts=excluded.last_vote_ts,
                updated_ts=excluded.updated_ts`,
        params: [
          name, toPixa(a.balance), toPxs(pick(a, ["pxs_balance", "hbd_balance"])), toPixa(a.savings_balance),
          toPxs(pick(a, ["savings_pxs_balance", "savings_hbd_balance"])), toVests(a.vesting_shares), toVests(a.delegated_vesting_shares),
          toVests(a.received_vesting_shares), toVests(a.vesting_withdraw_rate), next && next > 0 ? next : null,
          Number(a.to_withdraw ?? 0), Number(a.withdrawn ?? 0),
          toPixa(pick(a, ["reward_pixa_balance", "reward_hive_balance"])), toPxs(pick(a, ["reward_pxs_balance", "reward_hbd_balance"])),
          toVests(a.reward_vesting_balance), a.proxy || null, Number(a.witnesses_voted_for ?? 0), a.recovery_account ?? null,
          a.last_post ? chainTime(a.last_post) : null, a.last_vote_time ? chainTime(a.last_vote_time) : null, now,
        ],
      });
      stmts.push({ sql: `DELETE FROM posting_grants WHERE account = ?`, params: [name] });
      for (const [grantee] of (a.posting?.account_auths ?? []) as [string, number][]) {
        stmts.push({ sql: `INSERT OR IGNORE INTO posting_grants (account, grantee, updated_ts) VALUES (?,?,?)`, params: [name, grantee, now] });
      }
    }
    await batch(db, stmts);
    total += page.length;
    if ((r.accounts ?? []).length < 1000) break;
    start = r.accounts[r.accounts.length - 1].name;
  }
  return total;
}

async function listWitnesses(client: ChainClient): Promise<Obj[]> {
  const out: Obj[] = [];
  let start = "";
  for (let guard = 0; guard < 100; guard++) {
    const r = await client.call<{ witnesses: Obj[] }>("database_api.list_witnesses", { start, limit: 1000, order: "by_name" });
    const page = (r.witnesses ?? []).filter((w) => w.owner !== start || start === "");
    out.push(...page);
    if ((r.witnesses ?? []).length < 1000) break;
    start = r.witnesses[r.witnesses.length - 1].owner;
  }
  return out;
}

async function listProposals(client: ChainClient): Promise<Obj[]> {
  const r = await client.call<{ proposals: Obj[] }>("database_api.list_proposals", {
    start: [], limit: 1000, order: "by_creator", order_direction: "ascending", status: "all",
  });
  return r.proposals ?? [];
}

export async function snapshot(db: D1Database, client: ChainClient, cfg: TowerConfig, opts: SnapshotOptions): Promise<Overview> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const [dgp, median_price, fund, schedule, witnesses, proposals, accountCount, dpf] = await Promise.all([
    client.getDynamicGlobalProperties() as Promise<Obj>,
    client.call<Obj>("condenser_api.get_current_median_history_price", []),
    client.call<Obj>("condenser_api.get_reward_fund", ["post"]),
    client.call<Obj>("database_api.get_witness_schedule", {}),
    listWitnesses(client),
    listProposals(client).catch(() => [] as Obj[]),
    client.call<number>("condenser_api.get_account_count", []),
    client.call<{ accounts: Obj[] }>("database_api.find_accounts", { accounts: [cfg.dpfAccount] }).then((r) => r.accounts?.[0] ?? null),
  ]);

  if (opts.refreshBalances) await refreshAccounts(db, client, cfg, now);

  const cursor = await first<{ block: number; block_ts: number }>(db, `SELECT block, block_ts FROM cursor WHERE name = 'scanner'`);
  const lib = Number(dgp.last_irreversible_block_num);
  const head = Number(dgp.head_block_number);
  const ingested = cursor?.block ?? 0;
  const ingestedTs = cursor?.block_ts ?? now;

  // ---- supply
  const currentSupply = toPixa(dgp.current_supply);
  const virtualSupply = toPixa(dgp.virtual_supply);
  const pxsSupply = toPxs(pick(dgp, ["current_pxs_supply", "current_hbd_supply"]));
  const vestingFund = toPixa(pick(dgp, ["total_vesting_fund_pixa", "total_vesting_fund_hive"]));
  const vestingShares = toVests(dgp.total_vesting_shares);
  const pendingVestingPixa = toPixa(pick(dgp, ["pending_rewarded_vesting_pixa", "pending_rewarded_vesting_hive"]));
  const rewardPool = toPixa(fund.reward_balance);
  const price = parsePrice(median_price);
  const feed = price ? pixaPerPxs(price) : NaN;
  const vestsRatio = vestingShares ? (vestingFund / 1e3) / (vestingShares / 1e6) : 1;
  const debtRatio = virtualSupply ? ((pxsSupply / 1e3) * feed) / (virtualSupply / 1e3) : null;
  const dpfPxs = dpf ? toPxs(pick(dpf, ["pxs_balance", "hbd_balance"])) + toPxs(pick(dpf, ["savings_pxs_balance", "savings_hbd_balance"])) : 0;
  const dpfPixa = dpf ? toPixa(dpf.balance) + toPixa(dpf.savings_balance) : 0;

  const liquid = await first<{ pixa: number; pxs: number; n: number; rp: number; rx: number; rv: number; unclaimed: number }>(
    db,
    `SELECT COALESCE(SUM(pixa + savings_pixa), 0) AS pixa, COALESCE(SUM(pxs + savings_pxs), 0) AS pxs, COUNT(*) AS n,
            COALESCE(SUM(reward_pixa), 0) AS rp, COALESCE(SUM(reward_pxs), 0) AS rx, COALESCE(SUM(reward_vests), 0) AS rv,
            SUM(CASE WHEN reward_pixa > 0 OR reward_pxs > 0 OR reward_vests > 0 THEN 1 ELSE 0 END) AS unclaimed
     FROM balances WHERE account <> ?`,
    cfg.dpfAccount,
  );
  const liquidPixa = liquid && liquid.n ? liquid.pixa : null;
  const liquidPxs = liquid && liquid.n ? liquid.pxs : null;
  const supplyMethod = currentSupply - vestingFund - rewardPool - pendingVestingPixa;

  // ---- witnesses
  const maxVoted = Number(schedule.max_voted_witnesses ?? 20);
  const maxRunner = Number(schedule.max_runner_witnesses ?? 1);
  const hfRequired = Number(schedule.hardfork_required_witnesses ?? 17);
  const majorityVersion = String(schedule.majority_version ?? "");
  const infos: WitnessInfo[] = witnesses.map((w) => ({
    owner: w.owner, votes: Number(w.votes), signing_key: w.signing_key, running_version: w.running_version,
    hardfork_version_vote: w.hardfork_version_vote, last_confirmed_block_num: Number(w.last_confirmed_block_num ?? 0),
    last_pxs_exchange_update: chainTime(pick<string>(w, ["last_pxs_exchange_update", "last_hbd_exchange_update"]) ?? "1970-01-01T00:00:00"),
  }));
  const capture = captureCost({ witnesses: infos, maxVoted, maxRunner, hfRequired, vestsToPixa: vestsRatio });
  const electedSet = new Set(capture.elected);
  const ranked = infos.filter((w) => !isNullKey(w.signing_key)).sort((a, b) => b.votes - a.votes);
  const rankOf = new Map(ranked.map((w, i) => [w.owner, i + 1]));
  const feeds = witnesses
    .filter((w) => electedSet.has(w.owner))
    .map((w) => ({ owner: w.owner, price: parsePrice(pick(w, ["pxs_exchange_rate", "hbd_exchange_rate"])) }))
    .filter((x) => x.price)
    .map((x) => ({ owner: x.owner, value: pixaPerPxs(x.price!) }))
    .filter((x) => Number.isFinite(x.value) && x.value > 0);
  const feedMedian = median(feeds.map((f) => f.value));
  const feedSpread = feedMedian && feeds.length > 1 ? (Math.max(...feeds.map((f) => f.value)) - Math.min(...feeds.map((f) => f.value))) / feedMedian : feeds.length ? 0 : null;

  // Non-system user stake, for the "share of stake" view of capture cost and participation.
  const userStake = await first<{ vests: number; voting: number }>(
    db,
    `SELECT COALESCE(SUM(b.vests), 0) AS vests,
            COALESCE(SUM(CASE WHEN b.witnesses_voted_for > 0 OR b.proxy IS NOT NULL THEN b.vests ELSE 0 END), 0) AS voting
     FROM balances b JOIN accounts a ON a.name = b.account WHERE a.is_system = 0 AND a.is_portal = 0`,
  );
  const proxyTop = await first<{ proxy: string; vests: number }>(
    db,
    `SELECT b.proxy, SUM(b.vests) AS vests FROM balances b JOIN accounts a ON a.name = b.account
     WHERE a.is_system = 0 AND a.is_portal = 0 AND b.proxy IS NOT NULL GROUP BY b.proxy ORDER BY vests DESC LIMIT 1`,
  );

  // ---- DPF
  // Payments to the fund itself (the return proposal) flow back in: only payments to others draw it down.
  const dpfPaid24h = await first<{ v: number }>(
    db, `SELECT COALESCE(SUM(pxs), 0) AS v FROM rewards WHERE type = 'dpf' AND account <> ? AND ts >= ?`, cfg.dpfAccount, ingestedTs - DAY,
  );
  const active = proposals.filter((p) => p.status === "active");
  const returnProposal = proposals.find((p) => Number(p.id ?? p.proposal_id) === 2);
  const returnVotes = returnProposal ? Number(returnProposal.total_votes) : 0;

  // ---- content totals and live
  const totals = await first<Record<string, number>>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE kind = 'artwork' AND deleted = 0) AS artworks,
       (SELECT COUNT(*) FROM posts WHERE kind = 'artwork' AND deleted <> 0) AS artworks_deleted,
       (SELECT COUNT(*) FROM posts WHERE kind = 'blog' AND deleted = 0) AS blogs,
       (SELECT COUNT(*) FROM posts WHERE kind = 'reply' AND deleted <> 2) AS replies,
       (SELECT COUNT(*) FROM accounts WHERE is_portal = 1) AS portals,
       (SELECT COUNT(*) FROM accounts WHERE is_system = 0 AND is_portal = 0 AND created_ts IS NOT NULL) AS users,
       (SELECT COUNT(*) FROM accounts WHERE is_system = 1) AS system,
       (SELECT COALESCE(SUM(pending_payout_pxs), 0) FROM posts WHERE paid = 0) AS pending,
       (SELECT COUNT(DISTINCT account) FROM op_log WHERE ts > ?1 - 900 AND type NOT IN ('feed_publish','witness_set_properties','witness_update')) AS live,
       (SELECT COALESCE(SUM(CASE WHEN next_withdrawal_ts <= ?2 + 604800 THEN withdraw_rate ELSE 0 END), 0) FROM balances WHERE withdraw_rate > 0) AS pd7,
       (SELECT COALESCE(SUM(MIN(withdraw_rate * (1 + MAX(0, (?2 + 2592000 - next_withdrawal_ts) / 604800)), MAX(0, to_withdraw - withdrawn))), 0)
          FROM balances WHERE withdraw_rate > 0 AND next_withdrawal_ts <= ?2 + 2592000) AS pd30`,
    ingestedTs, now,
  );
  const t = totals ?? {};

  // ---- write snapshot rows
  const stmts: Stmt[] = [];
  stmts.push({
    sql: `INSERT OR REPLACE INTO chain_snapshots (ts, block, head_block, lib, current_supply, virtual_supply, pxs_supply, dpf_pxs, dpf_pixa,
            vesting_fund_pixa, vesting_shares, reward_fund_pixa, recent_claims, pending_rewarded_vesting_pixa, feed_base, feed_quote,
            pxs_print_rate, pxs_stop_percent, creation_fee, max_block_size, liquid_pixa, liquid_pxs, liquid_pixa_supply_method,
            account_count, witness_count, scheduled_witnesses, max_voted_witnesses, hf_required_witnesses, majority_version)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      now, ingested, head, lib, currentSupply, virtualSupply, pxsSupply, dpfPxs, dpfPixa, vestingFund, vestingShares, rewardPool,
      String(fund.recent_claims ?? ""), pendingVestingPixa, price?.base.amount ?? null, price?.quote.amount ?? null,
      Number(pick(dgp, ["pxs_print_rate", "hbd_print_rate"]) ?? 0), Number(pick(dgp, ["pxs_stop_percent", "hbd_stop_percent"]) ?? 2000),
      toPixa(schedule.median_props?.account_creation_fee), Number(dgp.maximum_block_size ?? 0), liquidPixa, liquidPxs, supplyMethod,
      accountCount, ranked.length, Number(schedule.num_scheduled_witnesses ?? 0), maxVoted, hfRequired, majorityVersion,
    ],
  });
  for (const w of witnesses) {
    const p = parsePrice(pick(w, ["pxs_exchange_rate", "hbd_exchange_rate"]));
    const elected = electedSet.has(w.owner);
    stmts.push({
      sql: `INSERT OR REPLACE INTO witness_snapshots (ts, witness, rank, votes, total_missed, last_confirmed_block, last_feed_ts, feed_base,
              feed_quote, running_version, hf_version_vote, signing_key, url, creation_fee, max_block_size)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        now, w.owner, elected ? rankOf.get(w.owner) ?? null : null, String(w.votes), Number(w.total_missed ?? 0),
        Number(w.last_confirmed_block_num ?? 0),
        chainTime(pick<string>(w, ["last_pxs_exchange_update", "last_hbd_exchange_update"]) ?? "1970-01-01T00:00:00"),
        p?.base.amount ?? null, p?.quote.amount ?? null, w.running_version ?? null, w.hardfork_version_vote ?? null,
        w.signing_key ?? null, String(w.url ?? "").slice(0, 256), toPixa(w.props?.account_creation_fee), Number(w.props?.maximum_block_size ?? 0),
      ],
    });
  }
  for (const p of proposals) {
    stmts.push({
      sql: `INSERT INTO proposals (id, creator, receiver, daily_pay, start_ts, end_ts, subject, permlink, total_votes, status, updated_ts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET receiver=excluded.receiver, daily_pay=excluded.daily_pay, start_ts=excluded.start_ts,
              end_ts=excluded.end_ts, subject=excluded.subject, total_votes=excluded.total_votes, status=excluded.status, updated_ts=excluded.updated_ts`,
      params: [
        Number(p.id ?? p.proposal_id), p.creator, p.receiver, toPxs(p.daily_pay), chainTime(p.start_date), chainTime(p.end_date),
        String(p.subject ?? "").slice(0, 300), p.permlink, String(p.total_votes ?? "0"), p.status ?? null, now,
      ],
    });
  }

  // ---- gauges
  const g = (metric: string, rows: { dim?: string; value: number | null; extra?: unknown }[]) => stmts.push(...gaugeStmts(metric, now, rows));
  const units = (x: number | null, d = 1e3) => (x === null ? null : x / d);
  g("live_now", [{ value: t.live ?? 0 }]);
  g("total_accounts", [
    { value: accountCount },
    { dim: "users", value: t.users ?? null },
    { dim: "portals", value: t.portals ?? null },
    { dim: "system", value: t.system ?? null },
  ]);
  g("total_artworks", [{ value: t.artworks ?? 0 }, { dim: "deleted", value: t.artworks_deleted ?? 0 }]);
  g("total_blog_posts", [{ value: t.blogs ?? 0 }]);
  g("total_replies", [{ value: t.replies ?? 0 }]);
  g("total_communities", [{ value: t.portals ?? 0 }]);
  g("deletion_rate", [{ value: (t.artworks ?? 0) + (t.artworks_deleted ?? 0) ? (t.artworks_deleted ?? 0) / ((t.artworks ?? 0) + (t.artworks_deleted ?? 0)) : null }]);
  g("current_supply", [{ value: units(currentSupply) }]);
  g("virtual_supply", [{ value: units(virtualSupply) }]);
  g("pxs_supply", [{ value: units(pxsSupply) }]);
  g("dpf_balance", [{ value: units(dpfPxs), extra: { pixa: units(dpfPixa) } }]);
  g("liquid_pixa", [{ value: units(liquidPixa) }]);
  g("liquid_pxs", [{ value: units(liquidPxs) }]);
  const liquidTotal = liquidPixa !== null && liquidPxs !== null && Number.isFinite(feed) ? liquidPixa / 1e3 + (liquidPxs / 1e3) * feed : null;
  g("liquid_total", [{ value: liquidTotal, extra: { pixa: units(liquidPixa), pxs: units(liquidPxs), pixa_per_pxs: feed } }]);
  g("liquid_supply_gap", [{
    value: liquidPixa !== null && currentSupply ? (supplyMethod - liquidPixa - (liquid?.rp ?? 0) - dpfPixa) / currentSupply : null,
    extra: { supply_method: units(supplyMethod), balances_method: units(liquidPixa), reward_balances: units(liquid?.rp ?? 0), dpf_pixa: units(dpfPixa) },
  }]);
  g("staked_pixa", [{ value: units(vestingFund) }]);
  g("vests_ratio", [{ value: vestsRatio }]);
  g("reward_pool", [{ value: units(rewardPool) }]);
  g("feed_price", [{ value: Number.isFinite(feed) ? feed : null }]);
  g("feed_spread", [{ value: feedSpread, extra: { witnesses: feeds.length } }]);
  g("pxs_debt_ratio", [{ value: debtRatio, extra: { stop: Number(pick(dgp, ["pxs_stop_percent", "hbd_stop_percent"]) ?? 2000) / 10000, haircut: 0.3 } }]);
  g("account_creation_fee", [{ value: units(toPixa(schedule.median_props?.account_creation_fee)) }]);
  g("pending_payout", [{ value: units(t.pending ?? 0) }]);
  g("unclaimed_rewards", [{ value: liquid?.unclaimed ?? 0, extra: { pixa: units(liquid?.rp ?? 0), pxs: units(liquid?.rx ?? 0), vests: units(liquid?.rv ?? 0, 1e6) } }]);
  g("powerdown_queue", [
    { dim: "7d", value: ((t.pd7 ?? 0) / 1e6) * vestsRatio },
    { dim: "30d", value: ((t.pd30 ?? 0) / 1e6) * vestsRatio },
  ]);
  g("ingest_lag", [{ value: Math.max(0, lib - ingested) }]);
  g("head_block", [{ value: head }]);

  const userVests = userStake?.vests ?? 0;
  g("witness_count", [{ value: ranked.length, extra: { elected: capture.elected.length, scheduled: Number(schedule.num_scheduled_witnesses ?? 0), max_voted: maxVoted } }]);
  g("free_witness_seats", [{ value: capture.freeSeats }]);
  g("witness_bench", [{ value: capture.bench }]);
  g("capture_cost", capture.targets.map((x) => ({
    dim: x.goal,
    value: Number.isFinite(x.costPxp) ? x.costPxp : null,
    extra: { seats: x.seats, free_seats: x.freeSeats, displace: x.displace, weakest_displaced: x.weakestDisplaced,
      share_of_user_stake: userVests && Number.isFinite(x.costVests) ? x.costVests / userVests : null },
  })));
  g("vote_margin", [{ value: capture.marginVests === null ? null : (capture.marginVests / 1e6) * vestsRatio }]);
  const electedInfos = infos.filter((w) => electedSet.has(w.owner));
  g("hf_readiness", [{
    value: electedInfos.length ? electedInfos.filter((w) => w.running_version === majorityVersion).length / electedInfos.length : null,
    extra: { majority_version: majorityVersion, required: hfRequired, elected: electedInfos.length },
  }]);
  const shared = sharedKeys(infos);
  g("shared_signing_keys", [{ value: shared.length, extra: shared }]);
  g("witness_feed_age", electedInfos.map((w) => ({ dim: w.owner, value: w.last_pxs_exchange_update ? (now - w.last_pxs_exchange_update) / HOUR : null })));
  g("witness_feed_deviation", feeds.map((f) => ({ dim: f.owner, value: feedMedian ? f.value / feedMedian - 1 : null })));
  g("witness_vote_participation", [{ value: userVests ? (userStake?.voting ?? 0) / userVests : null }]);
  g("proxy_top_share", [{ value: proxyTop && userStake?.voting ? proxyTop.vests / userStake.voting : 0, extra: { proxy: proxyTop?.proxy ?? null } }]);
  g("dpf_runway", [{ value: dpfPaid24h && dpfPaid24h.v > 0 ? dpfPxs / dpfPaid24h.v : null, extra: { paid_24h: units(dpfPaid24h?.v ?? 0) } }]);
  g("dpf_return_margin", active
    .filter((p) => Number(p.id ?? p.proposal_id) !== 2)
    .map((p) => ({ dim: String(p.id ?? p.proposal_id), value: returnVotes ? Number(p.total_votes) / returnVotes - 1 : null, extra: { subject: String(p.subject ?? "").slice(0, 120), receiver: p.receiver } })));

  // Community titles and subscriber counts come from Hivemind (best effort: not consensus data).
  try {
    let last: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, unknown> = { limit: 100 };
      if (last) params.last = last;
      const list = await client.call<Obj[]>("bridge.list_communities", params);
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) {
        stmts.push({
          sql: `INSERT INTO communities (name, title, about, lang, type_id, subscribers, created_at, updated_ts) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(name) DO UPDATE SET title=excluded.title, about=excluded.about, lang=excluded.lang, type_id=excluded.type_id,
                  subscribers=excluded.subscribers, updated_ts=excluded.updated_ts`,
          params: [c.name, String(c.title ?? "").slice(0, 64), String(c.about ?? "").slice(0, 200), c.lang ?? null, c.type_id ?? null,
            Number(c.subscribers ?? 0), c.created_at ?? null, now],
        });
      }
      if (list.length < 100) break;
      last = list[list.length - 1].name;
    }
  } catch {
    // Hivemind unavailable: keep the previous rows.
  }

  await batch(db, stmts);

  const openAlerts = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM alerts WHERE state <> 'closed'`);
  const recent = await all<{ type: string; v: number }>(
    db,
    `SELECT type, SUM(pixa / 1e3 + pxs / 1e3 * ?2 + vests / 1e6 * ?3) AS v FROM rewards WHERE ts >= ?1 AND type IN ('author','curation','beneficiary') GROUP BY type`,
    ingestedTs - DAY, Number.isFinite(feed) ? feed : 0, vestsRatio,
  );
  const tps = await first<{ tx: number }>(db, `SELECT COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE ts > ?`, ingestedTs - HOUR);
  const dau = await first<{ n: number }>(
    db, `SELECT COUNT(DISTINCT account) AS n FROM op_log WHERE ts > ? AND type NOT IN ('feed_publish','witness_set_properties','witness_update')`, ingestedTs - DAY,
  );

  return {
    as_of_block: ingested,
    as_of_time: new Date(ingestedTs * 1000).toISOString(),
    generated_at: new Date(now * 1000).toISOString(),
    head_block: head,
    lib,
    ingest_lag_blocks: Math.max(0, lib - ingested),
    kpis: {
      total_accounts: accountCount,
      user_accounts: t.users ?? null,
      live_now: t.live ?? 0,
      active_24h: dau?.n ?? 0,
      tps_1h: (tps?.tx ?? 0) / HOUR,
      total_artworks: t.artworks ?? 0,
      total_blog_posts: t.blogs ?? 0,
      total_replies: t.replies ?? 0,
      total_communities: t.portals ?? 0,
      pending_payout_pxs: units(t.pending ?? 0),
      rewards_24h_author_pixa_eq: recent.find((r) => r.type === "author")?.v ?? 0,
      rewards_24h_curation_pixa_eq: recent.find((r) => r.type === "curation")?.v ?? 0,
      rewards_24h_beneficiary_pixa_eq: recent.find((r) => r.type === "beneficiary")?.v ?? 0,
    },
    supply: {
      current_supply_pixa: units(currentSupply),
      virtual_supply_pixa: units(virtualSupply),
      pxs_supply: units(pxsSupply),
      dpf_pxs: units(dpfPxs),
      liquid_pixa: units(liquidPixa),
      liquid_pxs: units(liquidPxs),
      liquid_total_pixa_eq: liquidTotal,
      staked_pixa: units(vestingFund),
      vests_ratio: vestsRatio,
      reward_pool_pixa: units(rewardPool),
      feed_pixa_per_pxs: Number.isFinite(feed) ? feed : null,
      pxs_debt_ratio: debtRatio,
    },
    governance: {
      witnesses: ranked.length,
      elected: capture.elected,
      free_seats: capture.freeSeats,
      bench: capture.bench,
      capture_cost: capture.targets,
      hf_required_witnesses: hfRequired,
      majority_version: majorityVersion,
      shared_signing_keys: shared,
    },
    open_alerts: openAlerts?.n ?? 0,
  };
}


