// The metric catalogue. Each metric has one definition, used by the rollup, the API catalogue and the tests.
//
// Kinds:
//   counter  hourly SQL over [from, to); day, week and month are sums of the hours.
//   range    SQL run directly over each grain's range (distinct counts, averages, peaks).
//   daily    computed once per closed day by a function (may use JS for Gini, medians...).
//   gauge    written by the snapshotter every 5 minutes; each grain keeps the last value of its bucket.
//
// SQL metrics return rows {dim, value[, extra]}; ?1 = from, ?2 = to (Unix seconds). dim '' is the total.

import type { Grain } from "./time";

export type MetricKind = "counter" | "range" | "daily" | "gauge";

export interface MetricDef {
  id: string;
  title: string;
  unit: string;
  section: "accounts" | "content" | "votes" | "rewards" | "economy" | "governance" | "portals" | "chain" | "social" | "security";
  kind: MetricKind;
  grains: Grain[];
  description: string;
  version: number;
  sql?: string;
}

const H: Grain[] = ["hour", "day", "week", "month"];
const D: Grain[] = ["day"];
const DW: Grain[] = ["day", "week", "month"];

// Root content kinds counted as "posts" for creators.
const ACTIVE_FILTER = `type NOT IN ('feed_publish','witness_set_properties','witness_update')`;

export const METRICS: MetricDef[] = [
  // ------------------------------------------------------------------ accounts
  {
    id: "accounts_created", title: "Accounts created", unit: "accounts", section: "accounts", kind: "counter", grains: H, version: 1,
    description: "New accounts by creation time. Dimensions: user accounts and portal (community) accounts.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM accounts WHERE created_ts >= ?1 AND created_ts < ?2
          UNION ALL SELECT CASE WHEN is_portal = 1 THEN 'portal' WHEN is_system = 1 THEN 'system' ELSE 'user' END, COUNT(*)
          FROM accounts WHERE created_ts >= ?1 AND created_ts < ?2 GROUP BY 1`,
  },
  {
    id: "active_accounts", title: "Active accounts", unit: "accounts", section: "accounts", kind: "range", grains: H, version: 1,
    description: "Distinct accounts that signed at least one operation, witness feed and property updates excluded. Dimensions: creators (published a post) and voters.",
    sql: `SELECT '' AS dim, COUNT(DISTINCT account) AS value FROM op_log WHERE ts >= ?1 AND ts < ?2 AND ${ACTIVE_FILTER}
          UNION ALL SELECT 'voters', COUNT(DISTINCT account) FROM op_log WHERE ts >= ?1 AND ts < ?2 AND type = 'vote'
          UNION ALL SELECT 'creators', COUNT(DISTINCT author) FROM posts WHERE created_ts >= ?1 AND created_ts < ?2 AND kind IN ('artwork','blog')`,
  },
  {
    id: "live_now", title: "Live now", unit: "accounts", section: "accounts", kind: "gauge", grains: ["hour", "day"], version: 1,
    description: "Distinct accounts that signed an operation in the 15 minutes before the last ingested block.",
  },
  {
    id: "total_accounts", title: "Total accounts", unit: "accounts", section: "accounts", kind: "gauge", grains: H, version: 1,
    description: "Accounts on chain. Dimensions: users (not system, not portal), portals, system.",
  },
  {
    id: "stickiness", title: "Stickiness (DAU / MAU)", unit: "ratio", section: "accounts", kind: "daily", grains: D, version: 1,
    description: "Daily active accounts divided by active accounts over the 30 days ending that day.",
  },
  {
    id: "activation_rate_7d", title: "Activation rate within 7 days", unit: "ratio", section: "accounts", kind: "daily", grains: D, version: 1,
    description: "Of the user accounts created on the day 7 days before, the share that voted or published within 7 days of creation.",
  },
  {
    id: "dormant_share", title: "Dormant accounts", unit: "ratio", section: "accounts", kind: "daily", grains: D, version: 1,
    description: "Share of user accounts with no signed operation in the last 30 days.",
  },
  {
    id: "onboarding_funnel", title: "Onboarding funnel by weekly cohort", unit: "accounts", section: "accounts", kind: "daily", grains: ["week"], version: 1,
    description: "For accounts created in the week (bucket), how many reached each stage: created, profile, follow, vote, artwork, reward, claim, power_up.",
  },
  {
    id: "cohort_retention", title: "Cohort retention", unit: "ratio", section: "accounts", kind: "daily", grains: ["week"], version: 1,
    description: "Of accounts created in the week (bucket), the share active in week +1, +4 and +12. Dimensions w1, w4, w12.",
  },

  // ------------------------------------------------------------------ content
  {
    id: "artworks_created", title: "Artworks published", unit: "posts", section: "content", kind: "counter", grains: H, version: 1,
    description: "Top-level posts whose body is an image data URI, by first publication time.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM posts WHERE kind = 'artwork' AND created_ts >= ?1 AND created_ts < ?2`,
  },
  {
    id: "blog_posts_created", title: "Blog posts published", unit: "posts", section: "content", kind: "counter", grains: H, version: 1,
    description: "Top-level markdown posts and posts in a portal. Dimension: the portal.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM posts WHERE kind = 'blog' AND created_ts >= ?1 AND created_ts < ?2
          UNION ALL SELECT portal, COUNT(*) FROM posts WHERE kind = 'blog' AND portal IS NOT NULL AND created_ts >= ?1 AND created_ts < ?2 GROUP BY portal`,
  },
  {
    id: "replies_created", title: "Replies", unit: "posts", section: "content", kind: "counter", grains: H, version: 1,
    description: "Comments under posts. Dimension: the portal of the thread.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM posts WHERE kind = 'reply' AND created_ts >= ?1 AND created_ts < ?2
          UNION ALL SELECT portal, COUNT(*) FROM posts WHERE kind = 'reply' AND portal IS NOT NULL AND created_ts >= ?1 AND created_ts < ?2 GROUP BY portal`,
  },
  {
    id: "artwork_bytes", title: "Artwork bytes added", unit: "bytes", section: "content", kind: "counter", grains: H, version: 1,
    description: "Size of artwork bodies published (first versions), i.e. how fast art makes the chain grow.",
    sql: `SELECT '' AS dim, COALESCE(SUM(body_bytes), 0) AS value FROM posts WHERE kind = 'artwork' AND created_ts >= ?1 AND created_ts < ?2`,
  },
  {
    id: "total_artworks", title: "Total artworks", unit: "posts", section: "content", kind: "gauge", grains: H, version: 1,
    description: "Artworks not marked deleted. Dimension 'deleted' counts the deleted ones.",
  },
  {
    id: "total_blog_posts", title: "Total blog posts", unit: "posts", section: "content", kind: "gauge", grains: H, version: 1,
    description: "Blog posts not marked deleted.",
  },
  {
    id: "total_replies", title: "Total replies", unit: "posts", section: "content", kind: "gauge", grains: H, version: 1,
    description: "Replies not removed.",
  },
  {
    id: "total_communities", title: "Total communities", unit: "portals", section: "content", kind: "gauge", grains: H, version: 1,
    description: "Accounts named portal-NNNN.",
  },
  {
    id: "nsfw_share", title: "NSFW share of new artworks", unit: "ratio", section: "content", kind: "range", grains: DW, version: 1,
    description: "Share of artworks published in the period that their author marked nsfw.",
    sql: `SELECT '' AS dim, AVG(CASE WHEN nsfw = 1 THEN 1.0 ELSE 0.0 END) AS value FROM posts
          WHERE kind = 'artwork' AND created_ts >= ?1 AND created_ts < ?2`,
  },
  {
    id: "licence_share", title: "Artworks with a licence", unit: "ratio", section: "content", kind: "range", grains: DW, version: 1,
    description: "Share of artworks published in the period that carry a licence record. Extra: average royalty asked.",
    sql: `SELECT '' AS dim, AVG(CASE WHEN license = 1 THEN 1.0 ELSE 0.0 END) AS value,
            json_object('avg_royalty_pct', AVG(royalty_pct), 'with_royalty', SUM(CASE WHEN royalty_pct > 0 THEN 1 ELSE 0 END)) AS extra
          FROM posts WHERE kind = 'artwork' AND created_ts >= ?1 AND created_ts < ?2`,
  },
  {
    id: "artwork_pixels_median", title: "Median artwork size", unit: "pixels", section: "content", kind: "daily", grains: D, version: 1,
    description: "Median width × height of artworks published that day. Extra: median width and height.",
  },
  {
    id: "cold_start_rate", title: "Posts with no vote in 24 h", unit: "ratio", section: "content", kind: "daily", grains: D, version: 1,
    description: "Of top-level posts published that day, the share that received no vote within 24 hours. Computed one day later.",
  },
  {
    id: "time_to_first_vote_median", title: "Median time to first vote", unit: "minutes", section: "content", kind: "daily", grains: D, version: 1,
    description: "Median minutes from publication to the first vote, top-level posts published that day.",
  },
  {
    id: "dust_payout_share", title: "Posts paying nothing", unit: "ratio", section: "content", kind: "range", grains: DW, version: 1,
    description: "Of top-level posts paid out in the period, the share whose payout was under 0.020 PXS.",
    sql: `SELECT '' AS dim, AVG(CASE WHEN COALESCE(total_payout_pxs, 0) < 20 THEN 1.0 ELSE 0.0 END) AS value FROM posts
          WHERE paid = 1 AND kind IN ('artwork','blog') AND payout_ts >= ?1 AND payout_ts < ?2`,
  },
  {
    id: "duplicate_artworks", title: "Exact duplicate artworks", unit: "posts", section: "content", kind: "counter", grains: H, version: 1,
    description: "Artworks published whose image is byte-identical to an earlier artwork. Dimension 'self' when by the same author.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM posts p WHERE p.kind = 'artwork' AND p.created_ts >= ?1 AND p.created_ts < ?2
            AND p.body_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM posts q WHERE q.body_sha256 = p.body_sha256 AND q.kind = 'artwork'
              AND (q.created_ts < p.created_ts OR (q.created_ts = p.created_ts AND q.permlink < p.permlink)))
          UNION ALL SELECT 'self', COUNT(*) FROM posts p WHERE p.kind = 'artwork' AND p.created_ts >= ?1 AND p.created_ts < ?2
            AND p.body_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM posts q WHERE q.body_sha256 = p.body_sha256 AND q.kind = 'artwork'
              AND q.author = p.author AND (q.created_ts < p.created_ts OR (q.created_ts = p.created_ts AND q.permlink < p.permlink)))`,
  },
  {
    id: "artwork_changed_after_payout", title: "Artworks changed after payout", unit: "events", section: "content", kind: "counter", grains: H, version: 1,
    description: "Edits that replaced an artwork's image after it was paid (bait-and-switch signal).",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM invariant_events WHERE kind = 'artwork_changed_after_payout' AND ts >= ?1 AND ts < ?2`,
  },
  {
    id: "deletion_rate", title: "Deleted artworks", unit: "ratio", section: "content", kind: "gauge", grains: D, version: 1,
    description: "Share of all artworks marked deleted or erased by their author.",
  },
  {
    id: "app_share", title: "Content by app", unit: "ratio", section: "content", kind: "range", grains: DW, version: 1,
    description: "Share of comment operations (posts, replies and edits) per writing app (json_metadata.app).",
    sql: `SELECT COALESCE(sub, 'unknown') AS dim, COUNT(*) * 1.0 / (SELECT COUNT(*) FROM op_log WHERE type = 'comment' AND ts >= ?1 AND ts < ?2) AS value
          FROM op_log WHERE type = 'comment' AND ts >= ?1 AND ts < ?2 GROUP BY 1`,
  },
  {
    id: "replies_per_post", title: "Replies per post", unit: "replies", section: "content", kind: "range", grains: DW, version: 1,
    description: "Replies published in the period divided by top-level posts published in the period.",
    sql: `SELECT '' AS dim, (SELECT COUNT(*) FROM posts WHERE kind = 'reply' AND created_ts >= ?1 AND created_ts < ?2) * 1.0 /
            NULLIF((SELECT COUNT(*) FROM posts WHERE kind IN ('artwork','blog') AND created_ts >= ?1 AND created_ts < ?2), 0) AS value`,
  },

  // ------------------------------------------------------------------ votes and controversy
  {
    id: "votes_cast", title: "Votes cast", unit: "votes", section: "votes", kind: "counter", grains: H, version: 1,
    description: "Vote operations. Dimensions: up, down, unvote.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM op_log WHERE type = 'vote' AND ts >= ?1 AND ts < ?2
          UNION ALL SELECT CASE WHEN percent > 0 THEN 'up' WHEN percent < 0 THEN 'down' ELSE 'unvote' END, COUNT(*)
          FROM votes WHERE ts >= ?1 AND ts < ?2 GROUP BY 1`,
  },
  {
    id: "controversy_index", title: "Controversy index", unit: "0-1", section: "votes", kind: "range", grains: DW, version: 1,
    description: "Mean of 2·min(U,D)/(U+D) over posts paid in the period with at least 5 votes, weighted by rshares at stake (U+D). Dimensions: each portal, _blogs, _artworks. Extra: posts scored.",
    sql: `SELECT CASE WHEN kind = 'artwork' THEN '_artworks' ELSE '_blogs' END AS dim,
            SUM(controversy * (up_rshares + down_rshares)) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0) AS value,
            json_object('posts', COUNT(*)) AS extra
          FROM posts WHERE paid = 1 AND controversy IS NOT NULL AND kind IN ('artwork','blog') AND payout_ts >= ?1 AND payout_ts < ?2 GROUP BY 1
          UNION ALL SELECT portal, SUM(controversy * (up_rshares + down_rshares)) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0), json_object('posts', COUNT(*))
          FROM posts WHERE paid = 1 AND controversy IS NOT NULL AND kind = 'blog' AND portal IS NOT NULL AND payout_ts >= ?1 AND payout_ts < ?2 GROUP BY portal
          UNION ALL SELECT '', SUM(controversy * (up_rshares + down_rshares)) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0), json_object('posts', COUNT(*))
          FROM posts WHERE paid = 1 AND controversy IS NOT NULL AND kind IN ('artwork','blog') AND payout_ts >= ?1 AND payout_ts < ?2`,
  },
  {
    id: "downvote_share", title: "Downvote share", unit: "ratio", section: "votes", kind: "range", grains: DW, version: 1,
    description: "Downvote rshares over all rshares on top-level posts paid in the period. Dimensions: each portal, _blogs, _artworks.",
    sql: `SELECT '' AS dim, SUM(down_rshares) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0) AS value FROM posts
            WHERE paid = 1 AND kind IN ('artwork','blog') AND payout_ts >= ?1 AND payout_ts < ?2
          UNION ALL SELECT CASE WHEN kind = 'artwork' THEN '_artworks' ELSE '_blogs' END, SUM(down_rshares) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0)
            FROM posts WHERE paid = 1 AND kind IN ('artwork','blog') AND payout_ts >= ?1 AND payout_ts < ?2 GROUP BY 1
          UNION ALL SELECT portal, SUM(down_rshares) * 1.0 / NULLIF(SUM(up_rshares + down_rshares), 0)
            FROM posts WHERE paid = 1 AND kind = 'blog' AND portal IS NOT NULL AND payout_ts >= ?1 AND payout_ts < ?2 GROUP BY portal`,
  },
  {
    id: "whale_crowd_divergence", title: "Whale-versus-crowd posts", unit: "ratio", section: "votes", kind: "range", grains: DW, version: 1,
    description: "Of posts paid in the period with at least 5 votes, the share where the stake verdict (net rshares) and the headcount verdict (net votes) disagree.",
    sql: `SELECT '' AS dim, AVG(CASE WHEN (up_rshares - down_rshares > 0) <> (up_count - down_count > 0) THEN 1.0 ELSE 0.0 END) AS value
          FROM posts WHERE paid = 1 AND kind IN ('artwork','blog') AND up_count + down_count >= 5 AND payout_ts >= ?1 AND payout_ts < ?2`,
  },
  {
    id: "self_vote_share", title: "Self-vote share", unit: "ratio", section: "votes", kind: "range", grains: DW, version: 1,
    description: "Share of upvote rshares cast in the period where the voter is the author.",
    sql: `SELECT '' AS dim, SUM(CASE WHEN voter = author THEN rshares ELSE 0 END) * 1.0 / NULLIF(SUM(rshares), 0) AS value
          FROM votes WHERE rshares > 0 AND ts >= ?1 AND ts < ?2`,
  },
  {
    id: "downvote_concentration", title: "Downvoters producing 80% of downvotes", unit: "accounts", section: "votes", kind: "daily", grains: D, version: 1,
    description: "Smallest number of accounts that cast 80% of downvote rshares over the 30 days ending that day. Small = one actor polices or suppresses.",
  },
  {
    id: "vote_rings", title: "Reciprocal voting pairs", unit: "pairs", section: "votes", kind: "daily", grains: D, version: 1,
    description: "Pairs of accounts that each upvoted the other at least 5 times in the 30 days ending that day. Extra: the largest pairs.",
  },
  {
    id: "repeat_downvote_pairs", title: "Repeat downvote targeting", unit: "pairs", section: "votes", kind: "daily", grains: D, version: 1,
    description: "Downvoter → author pairs with at least 3 downvotes in the 30 days ending that day. Extra: the pairs.",
  },
  {
    id: "attention_gini", title: "Attention Gini", unit: "0-1", section: "votes", kind: "daily", grains: D, version: 1,
    description: "Gini coefficient of upvote rshares received by top-level posts paid in the 7 days ending that day. Extra: long-tail share outside the top 10%.",
  },

  // ------------------------------------------------------------------ rewards
  {
    id: "rewards_paid_vests", title: "Rewards paid in VESTS", unit: "VESTS", section: "rewards", kind: "counter", grains: H, version: 1,
    description: "Author, curation, beneficiary and producer rewards paid as stake. Dimension: type.",
    sql: `SELECT type AS dim, SUM(vests) / 1e6 AS value FROM rewards WHERE ts >= ?1 AND ts < ?2 AND vests <> 0 GROUP BY type
          UNION ALL SELECT '', COALESCE(SUM(vests), 0) / 1e6 FROM rewards WHERE ts >= ?1 AND ts < ?2 AND type IN ('author','curation','beneficiary')`,
  },
  {
    id: "rewards_paid_pxs", title: "Rewards paid in PXS", unit: "PXS", section: "rewards", kind: "counter", grains: H, version: 1,
    description: "Author and beneficiary rewards paid in PXS, and DPF proposal payments. Dimension: type.",
    sql: `SELECT type AS dim, SUM(pxs) / 1e3 AS value FROM rewards WHERE ts >= ?1 AND ts < ?2 AND pxs <> 0 AND type <> 'dpf_funding' GROUP BY type
          UNION ALL SELECT '', COALESCE(SUM(pxs), 0) / 1e3 FROM rewards WHERE ts >= ?1 AND ts < ?2 AND type IN ('author','beneficiary')`,
  },
  {
    id: "rewards_paid_pixa", title: "Rewards paid in liquid PIXA", unit: "PIXA", section: "rewards", kind: "counter", grains: H, version: 1,
    description: "Author and beneficiary rewards paid in liquid PIXA (the PXS share while printing is stopped). Dimension: type.",
    sql: `SELECT type AS dim, SUM(pixa) / 1e3 AS value FROM rewards WHERE ts >= ?1 AND ts < ?2 AND pixa <> 0 AND type <> 'dpf_funding' GROUP BY type
          UNION ALL SELECT '', COALESCE(SUM(pixa), 0) / 1e3 FROM rewards WHERE ts >= ?1 AND ts < ?2 AND type IN ('author','beneficiary')`,
  },
  {
    id: "pending_payout", title: "Pending payout", unit: "PXS", section: "rewards", kind: "gauge", grains: H, version: 1,
    description: "Sum of the latest pending payout value of posts not yet paid (from effective_comment_vote).",
  },
  {
    id: "reward_concentration", title: "Reward concentration", unit: "ratio", section: "rewards", kind: "daily", grains: D, version: 1,
    description: "Share of the day's author rewards (dimension authors) and curation rewards (dimension curators) going to the top 10 accounts.",
  },
  {
    id: "curation_share_observed", title: "Observed curation share", unit: "ratio", section: "rewards", kind: "daily", grains: D, version: 1,
    description: "Curation rewards over author + curation + beneficiary rewards paid that day, in PIXA equivalent. Expected near 0.40.",
  },
  {
    id: "creator_earnings_median_30d", title: "Median creator earnings, 30 days", unit: "PIXA", section: "rewards", kind: "daily", grains: D, version: 1,
    description: "Median author rewards over the 30 days ending that day (PIXA equivalent) of accounts that published an artwork in those 30 days. Extra: share above 5 PXS.",
  },
  {
    id: "new_creator_reward_share", title: "Author rewards to new accounts", unit: "ratio", section: "rewards", kind: "daily", grains: D, version: 1,
    description: "Share of author rewards over the 30 days ending that day paid to accounts less than 30 days old at payout.",
  },
  {
    id: "tips", title: "Tips", unit: "transfers", section: "rewards", kind: "counter", grains: H, version: 1,
    description: "Transfers whose memo points at a post (@author/permlink). Extra: volume by asset.",
    sql: `SELECT '' AS dim, COUNT(*) AS value, json_object('pixa', SUM(CASE WHEN asset='PIXA' THEN amount END) / 1e3, 'pxs', SUM(CASE WHEN asset='PXS' THEN amount END) / 1e3) AS extra
          FROM transfers WHERE memo_ref IS NOT NULL AND ts >= ?1 AND ts < ?2`,
  },
  {
    id: "unclaimed_rewards", title: "Accounts with unclaimed rewards", unit: "accounts", section: "rewards", kind: "gauge", grains: D, version: 1,
    description: "Accounts holding reward balances not yet claimed. Extra: totals per asset.",
  },
  {
    id: "time_to_first_reward_median", title: "Median days to first reward", unit: "days", section: "rewards", kind: "daily", grains: ["week"], version: 1,
    description: "For accounts created in the week (bucket) that published, the median days from first post to first author or curation reward.",
  },

  // ------------------------------------------------------------------ economy
  { id: "current_supply", title: "Current PIXA supply", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "current_supply from the chain." },
  { id: "virtual_supply", title: "Virtual supply", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "PIXA supply plus PXS converted at the median feed." },
  { id: "pxs_supply", title: "PXS supply", unit: "PXS", section: "economy", kind: "gauge", grains: H, version: 1, description: "current_pxs_supply from the chain, DPF included." },
  { id: "dpf_balance", title: "DPF balance", unit: "PXS", section: "economy", kind: "gauge", grains: H, version: 1, description: "PXS held by the Decentralized Pixa Fund account." },
  { id: "liquid_pixa", title: "Liquid PIXA", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "Sum of balances and savings of all accounts except the DPF account." },
  { id: "liquid_pxs", title: "Liquid PXS", unit: "PXS", section: "economy", kind: "gauge", grains: H, version: 1, description: "Sum of PXS balances and savings, DPF excluded." },
  { id: "liquid_total", title: "Total liquid (PIXA + PXS)", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "Liquid PIXA plus liquid PXS converted at the median feed, DPF excluded. Extra: both parts." },
  { id: "liquid_supply_gap", title: "Liquid PIXA cross-check gap", unit: "ratio", section: "economy", kind: "gauge", grains: H, version: 1, description: "Difference between liquid PIXA from balances and from supply − vesting fund − reward pool − pending vesting, relative to supply. PIXA in orders, escrow and reward balances." },
  { id: "staked_pixa", title: "Staked PIXA (Pixa Power)", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "total_vesting_fund_pixa." },
  { id: "vests_ratio", title: "PIXA per VESTS", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "total_vesting_fund_pixa ÷ total_vesting_shares. About 1 on Pixa." },
  { id: "reward_pool", title: "Reward pool", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "reward_balance of the post reward fund." },
  { id: "feed_price", title: "Median price feed", unit: "PIXA per PXS", section: "economy", kind: "gauge", grains: H, version: 1, description: "Current median history price: PIXA per PXS." },
  { id: "feed_spread", title: "Price feed spread", unit: "ratio", section: "economy", kind: "gauge", grains: H, version: 1, description: "(max − min) ÷ median of the active witnesses' latest feeds." },
  { id: "pxs_debt_ratio", title: "PXS debt ratio", unit: "ratio", section: "economy", kind: "gauge", grains: H, version: 1, description: "PXS supply × feed ÷ virtual supply. Printing stops above 20%; the haircut applies above 30%." },
  { id: "days_to_stop_print", title: "Days to stop-print line", unit: "days", section: "economy", kind: "daily", grains: D, version: 1, description: "Days until the debt ratio reaches the stop-print percentage at its 30-day linear trend. Empty when the trend is flat or falling." },
  { id: "account_creation_fee", title: "Account creation fee", unit: "PIXA", section: "economy", kind: "gauge", grains: H, version: 1, description: "Median account creation fee voted by witnesses." },
  {
    id: "pxp_distribution", title: "Accounts by Pixa Power", unit: "accounts", section: "economy", kind: "daily", grains: D, version: 1,
    description: "User accounts per own-PXP bucket (VESTS × ratio). Dimension: bucket. Extra: effective PXP buckets (own ± delegations).",
  },
  { id: "pxp_gini", title: "Stake Gini", unit: "0-1", section: "economy", kind: "daily", grains: D, version: 1, description: "Gini of own PXP across user accounts (system and portal accounts excluded)." },
  { id: "pxp_nakamoto", title: "Stake Nakamoto coefficient", unit: "accounts", section: "economy", kind: "daily", grains: D, version: 1, description: "Fewest user accounts holding more than 50% of user PXP." },
  {
    id: "transfers_volume", title: "Transfer volume", unit: "units", section: "economy", kind: "counter", grains: H, version: 1,
    description: "Transfers (including savings and recurrent). Dimension: asset (PIXA, PXS, VESTS).",
    sql: `SELECT asset AS dim, SUM(amount) / CASE WHEN asset = 'VESTS' THEN 1e6 ELSE 1e3 END AS value FROM transfers
          WHERE ts >= ?1 AND ts < ?2 AND op NOT LIKE 'fill_%' GROUP BY asset`,
  },
  {
    id: "power_flow", title: "Power ups and downs", unit: "PIXA", section: "economy", kind: "counter", grains: H, version: 1,
    description: "PIXA staked (dimension up) and PIXA received from power-down payments (dimension down); total = net.",
    sql: `SELECT 'up' AS dim, COALESCE(SUM(pixa), 0) / 1e3 AS value FROM stake_events WHERE op = 'power_up' AND ts >= ?1 AND ts < ?2
          UNION ALL SELECT 'down', COALESCE(SUM(pixa), 0) / 1e3 FROM stake_events WHERE op = 'power_down' AND ts >= ?1 AND ts < ?2
          UNION ALL SELECT '', (COALESCE((SELECT SUM(pixa) FROM stake_events WHERE op = 'power_up' AND ts >= ?1 AND ts < ?2), 0)
            - COALESCE((SELECT SUM(pixa) FROM stake_events WHERE op = 'power_down' AND ts >= ?1 AND ts < ?2), 0)) / 1e3`,
  },
  { id: "powerdown_queue", title: "Power-down queue", unit: "PIXA", section: "economy", kind: "gauge", grains: D, version: 1, description: "PIXA scheduled to unvest. Dimensions: 7d, 30d. Future sell pressure." },
  {
    id: "delegation_changes", title: "Delegation changes", unit: "operations", section: "economy", kind: "counter", grains: H, version: 1,
    description: "Delegations created, changed or removed.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM stake_events WHERE op = 'delegate' AND ts >= ?1 AND ts < ?2`,
  },
  {
    id: "conversions", title: "Conversions and market fills", unit: "operations", section: "economy", kind: "counter", grains: H, version: 1,
    description: "Conversion requests, fills and order fills. Dimension: operation.",
    sql: `SELECT op AS dim, COUNT(*) AS value FROM market_events WHERE ts >= ?1 AND ts < ?2 GROUP BY op`,
  },
  {
    id: "velocity", title: "Velocity", unit: "ratio", section: "economy", kind: "daily", grains: D, version: 1,
    description: "PIXA and PXS transferred that day (PXS at the feed) divided by liquid supply.",
  },
  {
    id: "treasury_distribution", title: "Company treasury distribution", unit: "ratio", section: "economy", kind: "daily", grains: D, version: 1,
    description: "Share of the company treasury's initial stake transferred out, against the linear 9-to-11-year path. Dimensions: to_operating (to the operating account, an internal step before sale) and to_others. Extra: schedule bounds and gap in days.",
  },
  {
    id: "exchange_inflow", title: "Transfers to exchanges", unit: "PIXA", section: "economy", kind: "counter", grains: H, version: 1,
    description: "PIXA and PXS (at face value) sent to the accounts listed in EXCHANGE_ACCOUNTS. Empty until accounts are listed.",
  },

  // ------------------------------------------------------------------ governance
  { id: "witness_count", title: "Witnesses with a signing key", unit: "witnesses", section: "governance", kind: "gauge", grains: H, version: 1, description: "Witnesses eligible for the schedule. Extra: elected and scheduled." },
  { id: "free_witness_seats", title: "Free elected seats", unit: "seats", section: "governance", kind: "gauge", grains: H, version: 1, description: "Elected seats with no candidate: anyone running a witness with a key takes one without stake." },
  { id: "witness_bench", title: "Bench depth", unit: "witnesses", section: "governance", kind: "gauge", grains: H, version: 1, description: "Witnesses with a key ranked below the elected set." },
  {
    id: "capture_cost", title: "Cost of capture", unit: "PXP", section: "governance", kind: "gauge", grains: H, version: 1,
    description: "Stake needed to win enough schedule seats. Dimensions: stall_finality (more than 1/3), majority, hardfork_quorum. 0 = free seats suffice. Extra: share of user stake.",
  },
  { id: "vote_margin", title: "Margin at the last elected seat", unit: "PXP", section: "governance", kind: "gauge", grains: H, version: 1, description: "Votes of the last elected witness minus the first runner-up. Empty when there is no runner-up." },
  { id: "hf_readiness", title: "Elected witnesses on the majority version", unit: "ratio", section: "governance", kind: "gauge", grains: H, version: 1, description: "Share of elected witnesses whose running version equals the schedule's majority version. Extra: required witnesses." },
  { id: "shared_signing_keys", title: "Shared signing keys", unit: "keys", section: "governance", kind: "gauge", grains: H, version: 1, description: "Signing keys used by more than one witness. Extra: the witnesses." },
  { id: "witness_feed_age", title: "Witness feed age", unit: "hours", section: "governance", kind: "gauge", grains: H, version: 1, description: "Hours since each elected witness last published a price. Dimension: witness." },
  { id: "witness_feed_deviation", title: "Witness feed deviation", unit: "ratio", section: "governance", kind: "gauge", grains: H, version: 1, description: "Each witness's latest feed relative to the median, minus 1. Dimension: witness." },
  {
    id: "witness_missed_blocks", title: "Missed blocks", unit: "blocks", section: "governance", kind: "counter", grains: H, version: 1,
    description: "Blocks a scheduled witness failed to produce (producer_missed). Dimension: witness.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM witness_missed WHERE ts >= ?1 AND ts < ?2
          UNION ALL SELECT witness, COUNT(*) FROM witness_missed WHERE ts >= ?1 AND ts < ?2 GROUP BY witness`,
  },
  {
    id: "witness_votes_cast", title: "Witness votes cast", unit: "votes", section: "governance", kind: "counter", grains: H, version: 1,
    description: "Witness approvals and removals. Dimensions: approve, unapprove. Extra: VESTS behind them.",
    sql: `SELECT CASE WHEN approve = 1 THEN 'approve' ELSE 'unapprove' END AS dim, COUNT(*) AS value, json_object('vests', SUM(voter_vests) / 1e6) AS extra
          FROM witness_votes_log WHERE ts >= ?1 AND ts < ?2 GROUP BY 1
          UNION ALL SELECT '', COUNT(*), json_object('vests', SUM(voter_vests) / 1e6) FROM witness_votes_log WHERE ts >= ?1 AND ts < ?2`,
  },
  {
    id: "fresh_stake_witness_votes", title: "Witness votes from new accounts", unit: "votes", section: "governance", kind: "counter", grains: H, version: 1,
    description: "Witness approvals by accounts less than 7 days old: the hijack signature. Extra: VESTS behind them and the witnesses.",
    sql: `SELECT '' AS dim, COUNT(*) AS value, json_object('vests', SUM(voter_vests) / 1e6, 'witnesses', json_group_array(DISTINCT witness)) AS extra
          FROM witness_votes_log WHERE approve = 1 AND voter_age_days < 7 AND ts >= ?1 AND ts < ?2`,
  },
  { id: "witness_vote_swing", title: "Witness vote swing, 24 h", unit: "ratio", section: "governance", kind: "daily", grains: D, version: 1, description: "Change in each witness's votes over the day, relative to the start of the day. Dimension: witness." },
  { id: "elected_set_churn", title: "Elected set changes, 24 h", unit: "witnesses", section: "governance", kind: "daily", grains: D, version: 1, description: "Witnesses that entered or left the elected set over the day. Extra: who." },
  { id: "witness_vote_participation", title: "Witness vote participation", unit: "ratio", section: "governance", kind: "gauge", grains: D, version: 1, description: "Share of user stake that votes for at least one witness, directly or through a proxy." },
  { id: "proxy_top_share", title: "Largest proxy", unit: "ratio", section: "governance", kind: "gauge", grains: D, version: 1, description: "Share of voting user stake that flows through the largest proxy. Extra: the proxy." },
  {
    id: "witness_param_changes", title: "Witness parameter changes", unit: "changes", section: "governance", kind: "counter", grains: H, version: 1,
    description: "Changes of signing key, URL, account creation fee or block size voted by witnesses. Dimension: field.",
    sql: `SELECT field AS dim, COUNT(*) AS value FROM witness_events WHERE ts >= ?1 AND ts < ?2 AND field NOT LIKE 'proxy:%' GROUP BY field
          UNION ALL SELECT '', COUNT(*) FROM witness_events WHERE ts >= ?1 AND ts < ?2 AND field NOT LIKE 'proxy:%'`,
  },
  {
    id: "treasury_invariant", title: "Restricted-account votes", unit: "events", section: "governance", kind: "counter", grains: H, version: 1,
    description: "Votes, witness votes, proxies or proposal votes signed by a restricted treasury account. Must stay 0.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM invariant_events WHERE kind = 'restricted_account_voted' AND ts >= ?1 AND ts < ?2`,
  },
  {
    id: "dpf_paid", title: "DPF payments", unit: "PXS", section: "governance", kind: "counter", grains: H, version: 1,
    description: "PXS paid by the Decentralized Pixa Fund to proposals other than the return proposal (whose payments flow back into the fund). Dimension: receiver, the fund included.",
    sql: `SELECT '' AS dim, COALESCE(SUM(pxs), 0) / 1e3 AS value FROM rewards WHERE type = 'dpf' AND ts >= ?1 AND ts < ?2
          UNION ALL SELECT account, SUM(pxs) / 1e3 FROM rewards WHERE type = 'dpf' AND ts >= ?1 AND ts < ?2 GROUP BY account`,
  },
  { id: "dpf_runway", title: "DPF runway", unit: "days", section: "governance", kind: "gauge", grains: D, version: 1, description: "DPF balance divided by the PXS it paid over the last 24 hours." },
  { id: "dpf_return_margin", title: "Approval above the return proposal", unit: "ratio", section: "governance", kind: "gauge", grains: D, version: 1, description: "Each active proposal's votes over the return proposal's votes, minus 1. Below 0 = not funded. Dimension: proposal id." },

  // ------------------------------------------------------------------ portals
  {
    id: "portal_moderation", title: "Moderation actions", unit: "actions", section: "portals", kind: "counter", grains: H, version: 1,
    description: "Mute, unmute, pin, unpin and flag actions in communities. Dimension: portal.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM community_ops WHERE action IN ('mutePost','unmutePost','pinPost','unpinPost','flagPost','mutePost') AND ts >= ?1 AND ts < ?2
          UNION ALL SELECT community, COUNT(*) FROM community_ops WHERE action IN ('mutePost','unmutePost','pinPost','unpinPost','flagPost') AND community IS NOT NULL AND ts >= ?1 AND ts < ?2 GROUP BY community`,
  },
  {
    id: "portal_subscriptions", title: "Portal subscriptions", unit: "operations", section: "portals", kind: "counter", grains: H, version: 1,
    description: "Subscribe minus unsubscribe operations. Dimension: portal.",
    sql: `SELECT community AS dim, SUM(CASE WHEN action = 'subscribe' THEN 1 WHEN action = 'unsubscribe' THEN -1 ELSE 0 END) AS value
          FROM community_ops WHERE action IN ('subscribe','unsubscribe') AND ts >= ?1 AND ts < ?2 GROUP BY community`,
  },
  { id: "mute_reversal_rate", title: "Mute reversal rate", unit: "ratio", section: "portals", kind: "daily", grains: D, version: 1, description: "Of posts muted in the 30 days ending that day, the share later unmuted." },

  // ------------------------------------------------------------------ chain
  {
    id: "transactions", title: "Transactions", unit: "transactions", section: "chain", kind: "counter", grains: H, version: 1,
    description: "Transactions in blocks.",
    sql: `SELECT '' AS dim, COALESCE(SUM(tx_count), 0) AS value FROM blocks WHERE ts >= ?1 AND ts < ?2`,
  },
  {
    id: "operations", title: "Operations", unit: "operations", section: "chain", kind: "counter", grains: H, version: 1,
    description: "Signed operations. Dimension: operation type (one row per signing account).",
    sql: `SELECT '' AS dim, COALESCE(SUM(op_count), 0) AS value FROM blocks WHERE ts >= ?1 AND ts < ?2
          UNION ALL SELECT type, COUNT(*) FROM op_log WHERE ts >= ?1 AND ts < ?2 GROUP BY type`,
  },
  {
    id: "blocks_produced", title: "Blocks", unit: "blocks", section: "chain", kind: "counter", grains: H, version: 1,
    description: "Blocks produced (1,200 per hour at 3 s). Dimension: witness.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM blocks WHERE ts >= ?1 AND ts < ?2
          UNION ALL SELECT witness, COUNT(*) FROM blocks WHERE ts >= ?1 AND ts < ?2 GROUP BY witness`,
  },
  {
    id: "tps", title: "Transactions per second", unit: "tx/s", section: "chain", kind: "range", grains: H, version: 1,
    description: "Average over the period (dimension avg) and the busiest block (dimension peak, transactions ÷ 3 s).",
    sql: `SELECT 'avg' AS dim, COALESCE(SUM(tx_count), 0) * 1.0 / (?2 - ?1) AS value FROM blocks WHERE ts >= ?1 AND ts < ?2
          UNION ALL SELECT 'peak', COALESCE(MAX(tx_count), 0) / 3.0 FROM blocks WHERE ts >= ?1 AND ts < ?2`,
  },
  {
    id: "chain_bytes", title: "Transaction bytes", unit: "bytes", section: "chain", kind: "counter", grains: H, version: 1,
    description: "Approximate bytes of transactions (JSON size), a proxy for chain growth.",
    sql: `SELECT '' AS dim, COALESCE(SUM(size_bytes), 0) AS value FROM blocks WHERE ts >= ?1 AND ts < ?2`,
  },
  {
    id: "block_utilization", title: "Block utilization", unit: "ratio", section: "chain", kind: "range", grains: H, version: 1,
    description: "Average and peak transaction bytes per block over the maximum block size. Dimensions avg, peak.",
    sql: `SELECT 'avg' AS dim, AVG(size_bytes) * 1.0 / COALESCE((SELECT max_block_size FROM chain_snapshots ORDER BY ts DESC LIMIT 1), 2097152) AS value
            FROM blocks WHERE ts >= ?1 AND ts < ?2
          UNION ALL SELECT 'peak', MAX(size_bytes) * 1.0 / COALESCE((SELECT max_block_size FROM chain_snapshots ORDER BY ts DESC LIMIT 1), 2097152)
            FROM blocks WHERE ts >= ?1 AND ts < ?2`,
  },
  {
    id: "custom_json_ops", title: "custom_json by id", unit: "operations", section: "chain", kind: "counter", grains: H, version: 1,
    description: "custom_json operations per id: new ids show new apps building on the chain.",
    sql: `SELECT COALESCE(sub, '') AS dim, COUNT(*) AS value FROM op_log WHERE type = 'custom_json' AND ts >= ?1 AND ts < ?2 GROUP BY sub`,
  },
  {
    id: "unknown_ops", title: "Unknown operations", unit: "operations", section: "chain", kind: "counter", grains: H, version: 1,
    description: "Operations the parser does not know: a hardfork may have added one. Dimension: type.",
    sql: `SELECT subject AS dim, COUNT(*) AS value FROM invariant_events WHERE kind = 'unknown_op' AND ts >= ?1 AND ts < ?2 GROUP BY subject
          UNION ALL SELECT '', COUNT(*) FROM invariant_events WHERE kind = 'unknown_op' AND ts >= ?1 AND ts < ?2`,
  },
  { id: "ingest_lag", title: "Ingestion lag", unit: "blocks", section: "chain", kind: "gauge", grains: H, version: 1, description: "Last irreversible block minus the last block the Tower ingested." },
  { id: "head_block", title: "Head block", unit: "block", section: "chain", kind: "gauge", grains: H, version: 1, description: "Head block number." },

  // ------------------------------------------------------------------ social
  {
    id: "follows", title: "Follows", unit: "operations", section: "social", kind: "counter", grains: H, version: 1,
    description: "New follows recorded in the period (current state; later unfollows remove them).",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM follows WHERE what = 'blog' AND since_ts >= ?1 AND since_ts < ?2`,
  },
  {
    id: "reblogs", title: "Reblogs", unit: "reblogs", section: "social", kind: "counter", grains: H, version: 1,
    description: "Reblogs of posts.",
    sql: `SELECT '' AS dim, COUNT(*) AS value FROM reblogs WHERE ts >= ?1 AND ts < ?2`,
  },
  { id: "follow_reciprocity", title: "Mutual follows", unit: "ratio", section: "social", kind: "daily", grains: D, version: 1, description: "Share of follows that are mutual." },
  { id: "isolated_active_accounts", title: "Active accounts with no follower", unit: "accounts", section: "social", kind: "daily", grains: D, version: 1, description: "User accounts active in the last 30 days that nobody follows." },

  // ------------------------------------------------------------------ security
  {
    id: "authority_changes", title: "Key and authority changes", unit: "operations", section: "security", kind: "counter", grains: H, version: 1,
    description: "Owner, active, posting and memo key changes, and recovery operations. Dimension: kind; the total counts owner, active and posting changes. A burst can mean a phishing wave.",
    sql: `SELECT kind AS dim, COUNT(*) AS value FROM authority_events WHERE ts >= ?1 AND ts < ?2 GROUP BY kind
          UNION ALL SELECT '', COUNT(*) FROM authority_events WHERE ts >= ?1 AND ts < ?2 AND kind IN ('owner','active','posting')`,
  },
  { id: "recovery_concentration", title: "Recovery account concentration", unit: "ratio", section: "security", kind: "daily", grains: D, version: 1, description: "Share of user accounts whose recovery account is the single most common one. Extra: that account." },
  { id: "posting_grants_max", title: "Largest posting-authority grantee", unit: "accounts", section: "security", kind: "daily", grains: D, version: 1, description: "Most accounts that list one grantee in their posting authority: one key that could post for all of them. Extra: top grantees." },
  {
    id: "large_outflows_after_key_change", title: "Outflows after a key change", unit: "transfers", section: "security", kind: "daily", grains: D, version: 1,
    description: "Transfers or power-down starts within 1 hour after the same account changed its owner or active key. Extra: accounts.",
  },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));
