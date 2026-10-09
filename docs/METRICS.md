# Metric reference

Generated from `packages/core/src/metrics.ts` (117 metrics). Read any of them at `GET /v1/metrics/{id}?grain=…`.

Kinds: **counter**, counted per hour; day, week and month are sums; **range**, computed over each period directly (distinct counts, ratios, peaks); **daily**, computed once per closed day (cohort metrics per week); **gauge**, snapshot every 5 minutes; each period keeps its last value.

## Accounts and activity

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `accounts_created` | Accounts created | accounts | counter | hour, day, week, month | New accounts by creation time. Dimensions: user accounts and portal (community) accounts. |
| `active_accounts` | Active accounts | accounts | range | hour, day, week, month | Distinct accounts that signed at least one operation, witness feed and property updates excluded. Dimensions: creators (published a post) and voters. |
| `live_now` | Live now | accounts | gauge | hour, day | Distinct accounts that signed an operation in the 15 minutes before the last ingested block. |
| `total_accounts` | Total accounts | accounts | gauge | hour, day, week, month | Accounts on chain. Dimensions: users (not system, not portal), portals, system. |
| `stickiness` | Stickiness (DAU / MAU) | ratio | daily | day | Daily active accounts divided by active accounts over the 30 days ending that day. |
| `activation_rate_7d` | Activation rate within 7 days | ratio | daily | day | Of the user accounts created on the day 7 days before, the share that voted or published within 7 days of creation. |
| `dormant_share` | Dormant accounts | ratio | daily | day | Share of user accounts with no signed operation in the last 30 days. |
| `onboarding_funnel` | Onboarding funnel by weekly cohort | accounts | daily | week | For accounts created in the week (bucket), how many reached each stage: created, profile, follow, vote, artwork, reward, claim, power_up. |
| `cohort_retention` | Cohort retention | ratio | daily | week | Of accounts created in the week (bucket), the share active in week +1, +4 and +12. Dimensions w1, w4, w12. |

## Content

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `artworks_created` | Artworks published | posts | counter | hour, day, week, month | Top-level posts whose body is an image data URI, by first publication time. |
| `blog_posts_created` | Blog posts published | posts | counter | hour, day, week, month | Top-level markdown posts and posts in a portal. Dimension: the portal. |
| `replies_created` | Replies | posts | counter | hour, day, week, month | Comments under posts. Dimension: the portal of the thread. |
| `artwork_bytes` | Artwork bytes added | bytes | counter | hour, day, week, month | Size of artwork bodies published (first versions), i.e. how fast art makes the chain grow. |
| `total_artworks` | Total artworks | posts | gauge | hour, day, week, month | Artworks not marked deleted. Dimension 'deleted' counts the deleted ones. |
| `total_blog_posts` | Total blog posts | posts | gauge | hour, day, week, month | Blog posts not marked deleted. |
| `total_replies` | Total replies | posts | gauge | hour, day, week, month | Replies not removed. |
| `total_communities` | Total communities | portals | gauge | hour, day, week, month | Accounts named portal-NNNN. |
| `nsfw_share` | NSFW share of new artworks | ratio | range | day, week, month | Share of artworks published in the period that their author marked nsfw. |
| `licence_share` | Artworks with a licence | ratio | range | day, week, month | Share of artworks published in the period that carry a licence record. Extra: average royalty asked. |
| `artwork_pixels_median` | Median artwork size | pixels | daily | day | Median width × height of artworks published that day. Extra: median width and height. |
| `cold_start_rate` | Posts with no vote in 24 h | ratio | daily | day | Of top-level posts published that day, the share that received no vote within 24 hours. Computed one day later. |
| `time_to_first_vote_median` | Median time to first vote | minutes | daily | day | Median minutes from publication to the first vote, top-level posts published that day. |
| `dust_payout_share` | Posts paying nothing | ratio | range | day, week, month | Of top-level posts paid out in the period, the share whose payout was under 0.020 PXS. |
| `duplicate_artworks` | Exact duplicate artworks | posts | counter | hour, day, week, month | Artworks published whose image is byte-identical to an earlier artwork. Dimension 'self' when by the same author. |
| `artwork_changed_after_payout` | Artworks changed after payout | events | counter | hour, day, week, month | Edits that replaced an artwork's image after it was paid (bait-and-switch signal). |
| `deletion_rate` | Deleted artworks | ratio | gauge | day | Share of all artworks marked deleted or erased by their author. |
| `app_share` | Content by app | ratio | range | day, week, month | Share of comment operations (posts, replies and edits) per writing app (json_metadata.app). |
| `replies_per_post` | Replies per post | replies | range | day, week, month | Replies published in the period divided by top-level posts published in the period. |

## Votes and controversy

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `votes_cast` | Votes cast | votes | counter | hour, day, week, month | Vote operations. Dimensions: up, down, unvote. |
| `controversy_index` | Controversy index | 0-1 | range | day, week, month | Mean of 2·min(U,D)/(U+D) over posts paid in the period with at least 5 votes, weighted by rshares at stake (U+D). Dimensions: each portal, _blogs, _artworks. Extra: posts scored. |
| `downvote_share` | Downvote share | ratio | range | day, week, month | Downvote rshares over all rshares on top-level posts paid in the period. Dimensions: each portal, _blogs, _artworks. |
| `whale_crowd_divergence` | Whale-versus-crowd posts | ratio | range | day, week, month | Of posts paid in the period with at least 5 votes, the share where the stake verdict (net rshares) and the headcount verdict (net votes) disagree. |
| `self_vote_share` | Self-vote share | ratio | range | day, week, month | Share of upvote rshares cast in the period where the voter is the author. |
| `downvote_concentration` | Downvoters producing 80% of downvotes | accounts | daily | day | Smallest number of accounts that cast 80% of downvote rshares over the 30 days ending that day. Small = one actor polices or suppresses. |
| `vote_rings` | Reciprocal voting pairs | pairs | daily | day | Pairs of accounts that each upvoted the other at least 5 times in the 30 days ending that day. Extra: the largest pairs. |
| `repeat_downvote_pairs` | Repeat downvote targeting | pairs | daily | day | Downvoter → author pairs with at least 3 downvotes in the 30 days ending that day. Extra: the pairs. |
| `attention_gini` | Attention Gini | 0-1 | daily | day | Gini coefficient of upvote rshares received by top-level posts paid in the 7 days ending that day. Extra: long-tail share outside the top 10%. |

## Rewards

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `rewards_paid_vests` | Rewards paid in VESTS | VESTS | counter | hour, day, week, month | Author, curation, beneficiary and producer rewards paid as stake. Dimension: type. |
| `rewards_paid_pxs` | Rewards paid in PXS | PXS | counter | hour, day, week, month | Author and beneficiary rewards paid in PXS, and DPF proposal payments. Dimension: type. |
| `rewards_paid_pixa` | Rewards paid in liquid PIXA | PIXA | counter | hour, day, week, month | Author and beneficiary rewards paid in liquid PIXA (the PXS share while printing is stopped). Dimension: type. |
| `pending_payout` | Pending payout | PXS | gauge | hour, day, week, month | Sum of the latest pending payout value of posts not yet paid (from effective_comment_vote). |
| `reward_concentration` | Reward concentration | ratio | daily | day | Share of the day's author rewards (dimension authors) and curation rewards (dimension curators) going to the top 10 accounts. |
| `curation_share_observed` | Observed curation share | ratio | daily | day | Curation rewards over author + curation + beneficiary rewards paid that day, in PIXA equivalent. Expected near 0.40. |
| `creator_earnings_median_30d` | Median creator earnings, 30 days | PIXA | daily | day | Median author rewards over the 30 days ending that day (PIXA equivalent) of accounts that published an artwork in those 30 days. Extra: share above 5 PXS. |
| `new_creator_reward_share` | Author rewards to new accounts | ratio | daily | day | Share of author rewards over the 30 days ending that day paid to accounts less than 30 days old at payout. |
| `tips` | Tips | transfers | counter | hour, day, week, month | Transfers whose memo points at a post (@author/permlink). Extra: volume by asset. |
| `unclaimed_rewards` | Accounts with unclaimed rewards | accounts | gauge | day | Accounts holding reward balances not yet claimed. Extra: totals per asset. |
| `time_to_first_reward_median` | Median days to first reward | days | daily | week | For accounts created in the week (bucket) that published, the median days from first post to first author or curation reward. |

## Economy and supply

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `current_supply` | Current PIXA supply | PIXA | gauge | hour, day, week, month | current_supply from the chain. |
| `virtual_supply` | Virtual supply | PIXA | gauge | hour, day, week, month | PIXA supply plus PXS converted at the median feed. |
| `pxs_supply` | PXS supply | PXS | gauge | hour, day, week, month | current_pxs_supply from the chain, DPF included. |
| `dpf_balance` | DPF balance | PXS | gauge | hour, day, week, month | PXS held by the Decentralized Pixa Fund account. |
| `liquid_pixa` | Liquid PIXA | PIXA | gauge | hour, day, week, month | Sum of balances and savings of all accounts except the DPF account. |
| `liquid_pxs` | Liquid PXS | PXS | gauge | hour, day, week, month | Sum of PXS balances and savings, DPF excluded. |
| `liquid_total` | Total liquid (PIXA + PXS) | PIXA | gauge | hour, day, week, month | Liquid PIXA plus liquid PXS converted at the median feed, DPF excluded. Extra: both parts. |
| `liquid_supply_gap` | Liquid PIXA cross-check gap | ratio | gauge | hour, day, week, month | Difference between liquid PIXA from balances and from supply − vesting fund − reward pool − pending vesting, relative to supply. PIXA in orders, escrow and reward balances. |
| `staked_pixa` | Staked PIXA (Pixa Power) | PIXA | gauge | hour, day, week, month | total_vesting_fund_pixa. |
| `vests_ratio` | PIXA per VESTS | PIXA | gauge | hour, day, week, month | total_vesting_fund_pixa ÷ total_vesting_shares. About 1 on Pixa. |
| `reward_pool` | Reward pool | PIXA | gauge | hour, day, week, month | reward_balance of the post reward fund. |
| `feed_price` | Median price feed | PIXA per PXS | gauge | hour, day, week, month | Current median history price: PIXA per PXS. |
| `feed_spread` | Price feed spread | ratio | gauge | hour, day, week, month | (max − min) ÷ median of the active witnesses' latest feeds. |
| `pxs_debt_ratio` | PXS debt ratio | ratio | gauge | hour, day, week, month | PXS supply × feed ÷ virtual supply. Printing stops above 20%; the haircut applies above 30%. |
| `days_to_stop_print` | Days to stop-print line | days | daily | day | Days until the debt ratio reaches the stop-print percentage at its 30-day linear trend. Empty when the trend is flat or falling. |
| `account_creation_fee` | Account creation fee | PIXA | gauge | hour, day, week, month | Median account creation fee voted by witnesses. |
| `pxp_distribution` | Accounts by Pixa Power | accounts | daily | day | User accounts per own-PXP bucket (VESTS × ratio). Dimension: bucket. Extra: effective PXP buckets (own ± delegations). |
| `pxp_gini` | Stake Gini | 0-1 | daily | day | Gini of own PXP across user accounts (system and portal accounts excluded). |
| `pxp_nakamoto` | Stake Nakamoto coefficient | accounts | daily | day | Fewest user accounts holding more than 50% of user PXP. |
| `transfers_volume` | Transfer volume | units | counter | hour, day, week, month | Transfers (including savings and recurrent). Dimension: asset (PIXA, PXS, VESTS). |
| `power_flow` | Power ups and downs | PIXA | counter | hour, day, week, month | PIXA staked (dimension up) and PIXA received from power-down payments (dimension down); total = net. |
| `powerdown_queue` | Power-down queue | PIXA | gauge | day | PIXA scheduled to unvest. Dimensions: 7d, 30d. Future sell pressure. |
| `delegation_changes` | Delegation changes | operations | counter | hour, day, week, month | Delegations created, changed or removed. |
| `conversions` | Conversions and market fills | operations | counter | hour, day, week, month | Conversion requests, fills and order fills. Dimension: operation. |
| `velocity` | Velocity | ratio | daily | day | PIXA and PXS transferred that day (PXS at the feed) divided by liquid supply. |
| `treasury_distribution` | Company treasury distribution | ratio | daily | day | Share of the company treasury's initial stake transferred out, against the linear 9-to-11-year path. Dimensions: to_operating (to the operating account, an internal step before sale) and to_others. Extra: schedule bounds and gap in days. |
| `exchange_inflow` | Transfers to exchanges | PIXA | counter | hour, day, week, month | PIXA and PXS (at face value) sent to the accounts listed in EXCHANGE_ACCOUNTS. Empty until accounts are listed. |

## Governance

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `witness_count` | Witnesses with a signing key | witnesses | gauge | hour, day, week, month | Witnesses eligible for the schedule. Extra: elected and scheduled. |
| `free_witness_seats` | Free elected seats | seats | gauge | hour, day, week, month | Elected seats with no candidate: anyone running a witness with a key takes one without stake. |
| `witness_bench` | Bench depth | witnesses | gauge | hour, day, week, month | Witnesses with a key ranked below the elected set. |
| `capture_cost` | Cost of capture | PXP | gauge | hour, day, week, month | Stake needed to win enough schedule seats. Dimensions: stall_finality (more than 1/3), majority, hardfork_quorum. 0 = free seats suffice. Extra: share of user stake. |
| `vote_margin` | Margin at the last elected seat | PXP | gauge | hour, day, week, month | Votes of the last elected witness minus the first runner-up. Empty when there is no runner-up. |
| `hf_readiness` | Elected witnesses on the majority version | ratio | gauge | hour, day, week, month | Share of elected witnesses whose running version equals the schedule's majority version. Extra: required witnesses. |
| `shared_signing_keys` | Shared signing keys | keys | gauge | hour, day, week, month | Signing keys used by more than one witness. Extra: the witnesses. |
| `witness_feed_age` | Witness feed age | hours | gauge | hour, day, week, month | Hours since each elected witness last published a price. Dimension: witness. |
| `witness_feed_deviation` | Witness feed deviation | ratio | gauge | hour, day, week, month | Each witness's latest feed relative to the median, minus 1. Dimension: witness. |
| `witness_missed_blocks` | Missed blocks | blocks | counter | hour, day, week, month | Blocks a scheduled witness failed to produce (producer_missed). Dimension: witness. |
| `witness_votes_cast` | Witness votes cast | votes | counter | hour, day, week, month | Witness approvals and removals. Dimensions: approve, unapprove. Extra: VESTS behind them. |
| `fresh_stake_witness_votes` | Witness votes from new accounts | votes | counter | hour, day, week, month | Witness approvals by accounts less than 7 days old: the hijack signature. Extra: VESTS behind them and the witnesses. |
| `witness_vote_swing` | Witness vote swing, 24 h | ratio | daily | day | Change in each witness's votes over the day, relative to the start of the day. Dimension: witness. |
| `elected_set_churn` | Elected set changes, 24 h | witnesses | daily | day | Witnesses that entered or left the elected set over the day. Extra: who. |
| `witness_vote_participation` | Witness vote participation | ratio | gauge | day | Share of user stake that votes for at least one witness, directly or through a proxy. |
| `proxy_top_share` | Largest proxy | ratio | gauge | day | Share of voting user stake that flows through the largest proxy. Extra: the proxy. |
| `witness_param_changes` | Witness parameter changes | changes | counter | hour, day, week, month | Changes of signing key, URL, account creation fee or block size voted by witnesses. Dimension: field. |
| `treasury_invariant` | Restricted-account votes | events | counter | hour, day, week, month | Votes, witness votes, proxies or proposal votes signed by a restricted treasury account. Must stay 0. |
| `dpf_paid` | DPF payments | PXS | counter | hour, day, week, month | PXS paid by the Decentralized Pixa Fund to proposals other than the return proposal (whose payments flow back into the fund). Dimension: receiver, the fund included. |
| `dpf_runway` | DPF runway | days | gauge | day | DPF balance divided by the PXS it paid over the last 24 hours. |
| `dpf_return_margin` | Approval above the return proposal | ratio | gauge | day | Each active proposal's votes over the return proposal's votes, minus 1. Below 0 = not funded. Dimension: proposal id. |

## Portals

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `portal_moderation` | Moderation actions | actions | counter | hour, day, week, month | Mute, unmute, pin, unpin and flag actions in communities. Dimension: portal. |
| `portal_subscriptions` | Portal subscriptions | operations | counter | hour, day, week, month | Subscribe minus unsubscribe operations. Dimension: portal. |
| `mute_reversal_rate` | Mute reversal rate | ratio | daily | day | Of posts muted in the 30 days ending that day, the share later unmuted. |

## Chain health

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `transactions` | Transactions | transactions | counter | hour, day, week, month | Transactions in blocks. |
| `operations` | Operations | operations | counter | hour, day, week, month | Signed operations. Dimension: operation type (one row per signing account). |
| `blocks_produced` | Blocks | blocks | counter | hour, day, week, month | Blocks produced (1,200 per hour at 3 s). Dimension: witness. |
| `tps` | Transactions per second | tx/s | range | hour, day, week, month | Average over the period (dimension avg) and the busiest block (dimension peak, transactions ÷ 3 s). |
| `chain_bytes` | Transaction bytes | bytes | counter | hour, day, week, month | Approximate bytes of transactions (JSON size), a proxy for chain growth. |
| `block_utilization` | Block utilization | ratio | range | hour, day, week, month | Average and peak transaction bytes per block over the maximum block size. Dimensions avg, peak. |
| `custom_json_ops` | custom_json by id | operations | counter | hour, day, week, month | custom_json operations per id: new ids show new apps building on the chain. |
| `unknown_ops` | Unknown operations | operations | counter | hour, day, week, month | Operations the parser does not know: a hardfork may have added one. Dimension: type. |
| `ingest_lag` | Ingestion lag | blocks | gauge | hour, day, week, month | Last irreversible block minus the last block the Tower ingested. |
| `head_block` | Head block | block | gauge | hour, day, week, month | Head block number. |

## Social graph

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `follows` | Follows | operations | counter | hour, day, week, month | New follows recorded in the period (current state; later unfollows remove them). |
| `reblogs` | Reblogs | reblogs | counter | hour, day, week, month | Reblogs of posts. |
| `follow_reciprocity` | Mutual follows | ratio | daily | day | Share of follows that are mutual. |
| `isolated_active_accounts` | Active accounts with no follower | accounts | daily | day | User accounts active in the last 30 days that nobody follows. |

## Security

| id | Metric | Unit | Kind | Grains | Definition |
| --- | --- | --- | --- | --- | --- |
| `authority_changes` | Key and authority changes | operations | counter | hour, day, week, month | Owner, active, posting and memo key changes, and recovery operations. Dimension: kind; the total counts owner, active and posting changes. A burst can mean a phishing wave. |
| `recovery_concentration` | Recovery account concentration | ratio | daily | day | Share of user accounts whose recovery account is the single most common one. Extra: that account. |
| `posting_grants_max` | Largest posting-authority grantee | accounts | daily | day | Most accounts that list one grantee in their posting authority: one key that could post for all of them. Extra: top grantees. |
| `large_outflows_after_key_change` | Outflows after a key change | transfers | daily | day | Transfers or power-down starts within 1 hour after the same account changed its owner or active key. Extra: accounts. |
