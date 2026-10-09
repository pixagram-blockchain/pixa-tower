-- Pixa Tower schema.
-- Amounts are integers in the smallest unit (PIXA, PXS: 3 decimals; VESTS: 6 decimals).
-- Times are block timestamps in Unix seconds, UTC.
-- Event tables are keyed by (block, pos): re-ingesting a range never duplicates a row.
-- pos = trx_in_block * 65536 + op_in_trx for signed ops; 2^31 + index for virtual ops.

-- ---------------------------------------------------------------- control
CREATE TABLE cursor (
  name TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  block_ts INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE blocks (
  num INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  witness TEXT NOT NULL,
  block_id TEXT,
  tx_count INTEGER NOT NULL,
  op_count INTEGER NOT NULL,
  vop_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL
);
CREATE INDEX blocks_ts ON blocks(ts);

-- Every signed operation, one row per signing account. Source of activity, TPS by type and app usage.
CREATE TABLE op_log (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  account TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  sub TEXT,
  PRIMARY KEY (block, pos, account)
) WITHOUT ROWID;
CREATE INDEX op_log_ts ON op_log(ts);
CREATE INDEX op_log_account_ts ON op_log(account, ts);

-- ---------------------------------------------------------------- accounts
CREATE TABLE accounts (
  name TEXT PRIMARY KEY,
  created_block INTEGER,
  created_ts INTEGER,
  creator TEXT,
  create_op TEXT,
  fee_pixa INTEGER,
  delegation_vests INTEGER,
  recovery_account TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_portal INTEGER NOT NULL DEFAULT 0,
  profile_set_ts INTEGER,
  first_follow_ts INTEGER,
  first_vote_ts INTEGER,
  first_post_ts INTEGER,
  first_artwork_ts INTEGER,
  first_reward_ts INTEGER,
  first_claim_ts INTEGER,
  first_powerup_ts INTEGER,
  last_active_ts INTEGER
);
CREATE INDEX accounts_created ON accounts(created_ts);
CREATE INDEX accounts_creator ON accounts(creator);

-- ---------------------------------------------------------------- content
CREATE TABLE posts (
  author TEXT NOT NULL,
  permlink TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- artwork | blog | reply | other
  portal TEXT,                        -- community (portal-NNNN) of the post or of its thread
  category TEXT,
  parent_author TEXT,
  parent_permlink TEXT,
  root_author TEXT,
  root_permlink TEXT,
  title TEXT,
  created_block INTEGER,
  created_ts INTEGER,
  app TEXT,
  format TEXT,
  tags TEXT,
  nsfw INTEGER,
  license INTEGER,
  royalty_pct REAL,
  image_format TEXT,
  width INTEGER,
  height INTEGER,
  body_bytes INTEGER,
  body_sha256 TEXT,
  paph TEXT,
  meta_invalid INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  last_op_seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,  -- 1 marked deleted, 2 removed from chain state
  body_changed_after_payout INTEGER NOT NULL DEFAULT 0,
  max_payout_pxs INTEGER,
  percent_pxs INTEGER,
  beneficiaries TEXT,
  up_rshares INTEGER NOT NULL DEFAULT 0,
  down_rshares INTEGER NOT NULL DEFAULT 0,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  controversy REAL,
  controversy_count REAL,
  pending_payout_pxs INTEGER,
  first_vote_ts INTEGER,
  paid INTEGER NOT NULL DEFAULT 0,
  payout_ts INTEGER,
  total_payout_pxs INTEGER,
  author_payout_pxs INTEGER,
  curator_payout_pxs INTEGER,
  beneficiary_payout_pxs INTEGER,
  PRIMARY KEY (author, permlink)
);
CREATE INDEX posts_kind_ts ON posts(kind, created_ts);
CREATE INDEX posts_portal_ts ON posts(portal, created_ts) WHERE portal IS NOT NULL;
CREATE INDEX posts_payout ON posts(paid, payout_ts);
CREATE INDEX posts_sha ON posts(body_sha256) WHERE kind = 'artwork';
CREATE INDEX posts_root ON posts(root_author, root_permlink);

CREATE TABLE votes (
  author TEXT NOT NULL,
  permlink TEXT NOT NULL,
  voter TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  percent INTEGER,          -- -10000..10000 from the vote operation
  rshares INTEGER NOT NULL DEFAULT 0, -- from effective_comment_vote (hived, never Hivemind)
  PRIMARY KEY (author, permlink, voter)
) WITHOUT ROWID;
CREATE INDEX votes_voter_ts ON votes(voter, ts);
CREATE INDEX votes_ts ON votes(ts);

-- ---------------------------------------------------------------- rewards, money, stake
CREATE TABLE rewards (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,       -- author | curation | beneficiary | producer | dpf | dpf_funding
  account TEXT NOT NULL,
  author TEXT,
  permlink TEXT,
  pixa INTEGER NOT NULL DEFAULT 0,
  pxs INTEGER NOT NULL DEFAULT 0,
  vests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (block, pos)
);
CREATE INDEX rewards_ts ON rewards(ts);
CREATE INDEX rewards_type_ts ON rewards(type, ts);
CREATE INDEX rewards_account ON rewards(account, ts);

CREATE TABLE transfers (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount INTEGER NOT NULL,
  asset TEXT NOT NULL,
  memo_ref TEXT,             -- author/permlink when the memo points at a post (tips)
  PRIMARY KEY (block, pos)
);
CREATE INDEX transfers_ts ON transfers(ts);
CREATE INDEX transfers_sender ON transfers(sender, ts);
CREATE INDEX transfers_receiver ON transfers(receiver, ts);

CREATE TABLE stake_events (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,          -- power_up | power_down_set | power_down | delegate | delegation_return | claim | route
  account TEXT NOT NULL,
  counterparty TEXT,
  vests INTEGER NOT NULL DEFAULT 0,
  pixa INTEGER NOT NULL DEFAULT 0,
  pxs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (block, pos)
);
CREATE INDEX stake_events_ts ON stake_events(ts);
CREATE INDEX stake_events_account ON stake_events(account, ts);

CREATE TABLE market_events (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,
  account TEXT NOT NULL,
  amount_in INTEGER,
  asset_in TEXT,
  amount_out INTEGER,
  asset_out TEXT,
  detail TEXT,
  PRIMARY KEY (block, pos)
);
CREATE INDEX market_events_ts ON market_events(ts);

CREATE TABLE delegations (
  delegator TEXT NOT NULL,
  delegatee TEXT NOT NULL,
  vests INTEGER NOT NULL,
  since_block INTEGER NOT NULL,
  PRIMARY KEY (delegator, delegatee)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- governance
CREATE TABLE witness_votes_log (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  voter TEXT NOT NULL,
  witness TEXT NOT NULL,
  approve INTEGER NOT NULL,
  voter_vests INTEGER,
  voter_age_days REAL,
  PRIMARY KEY (block, pos)
);
CREATE INDEX witness_votes_log_ts ON witness_votes_log(ts);
CREATE INDEX witness_votes_log_witness ON witness_votes_log(witness, ts);

CREATE TABLE witness_votes (
  voter TEXT NOT NULL,
  witness TEXT NOT NULL,
  since_block INTEGER NOT NULL,
  PRIMARY KEY (voter, witness)
) WITHOUT ROWID;
CREATE INDEX witness_votes_witness ON witness_votes(witness);

CREATE TABLE proxies (
  account TEXT PRIMARY KEY,
  proxy TEXT NOT NULL,
  since_block INTEGER NOT NULL
);

CREATE TABLE witness_state (
  witness TEXT PRIMARY KEY,
  signing_key TEXT,
  url TEXT,
  props TEXT,
  updated_block INTEGER
);

CREATE TABLE witness_events (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  witness TEXT NOT NULL,
  op TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  PRIMARY KEY (block, pos, field)
);
CREATE INDEX witness_events_ts ON witness_events(ts);

-- One row per missed slot: a block can follow several empty slots, so the key includes pos.
CREATE TABLE witness_missed (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  witness TEXT NOT NULL,
  PRIMARY KEY (block, pos)
);
CREATE INDEX witness_missed_ts ON witness_missed(ts);

CREATE TABLE feeds (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  witness TEXT NOT NULL,
  base INTEGER NOT NULL,     -- PXS, 3 decimals
  quote INTEGER NOT NULL,    -- PIXA, 3 decimals
  PRIMARY KEY (block, pos)
);
CREATE INDEX feeds_ts ON feeds(ts);
CREATE INDEX feeds_witness ON feeds(witness, ts);

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  creator TEXT,
  receiver TEXT,
  daily_pay INTEGER,
  start_ts INTEGER,
  end_ts INTEGER,
  subject TEXT,
  permlink TEXT,
  total_votes TEXT,          -- VESTS*1e6 as text (can exceed 2^53)
  status TEXT,
  updated_ts INTEGER
);

CREATE TABLE proposal_votes (
  proposal_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  approve INTEGER NOT NULL,
  since_block INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, voter)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- social and security
CREATE TABLE follows (
  follower TEXT NOT NULL,
  following TEXT NOT NULL,
  what TEXT NOT NULL,        -- blog | ignore
  since_block INTEGER NOT NULL,
  since_ts INTEGER,
  PRIMARY KEY (follower, following)
) WITHOUT ROWID;
CREATE INDEX follows_following ON follows(following);

CREATE TABLE reblogs (
  account TEXT NOT NULL,
  author TEXT NOT NULL,
  permlink TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (account, author, permlink)
) WITHOUT ROWID;

CREATE TABLE community_ops (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  community TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  notes TEXT,
  PRIMARY KEY (block, pos, idx)
);
CREATE INDEX community_ops_ts ON community_ops(ts);
CREATE INDEX community_ops_community ON community_ops(community, ts);

CREATE TABLE authority_events (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,        -- owner | active | posting | memo | change_recovery | request_recovery | recover | decline_voting
  detail TEXT,
  PRIMARY KEY (block, pos, kind)
);
CREATE INDEX authority_events_ts ON authority_events(ts);

CREATE TABLE posting_grants (
  account TEXT NOT NULL,
  grantee TEXT NOT NULL,
  updated_ts INTEGER,
  PRIMARY KEY (account, grantee)
) WITHOUT ROWID;
CREATE INDEX posting_grants_grantee ON posting_grants(grantee);

-- Community metadata from Hivemind (bridge.list_communities), refreshed by the snapshotter.
CREATE TABLE communities (
  name TEXT PRIMARY KEY,
  title TEXT,
  about TEXT,
  lang TEXT,
  type_id INTEGER,
  subscribers INTEGER,
  created_at TEXT,
  updated_ts INTEGER
);

-- Single events that matter on their own: treasury votes, bait-and-switch edits, unknown ops, hardforks.
CREATE TABLE invariant_events (
  block INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,    -- info | amber | red
  subject TEXT,
  detail TEXT,
  alerted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (block, pos, kind)
);
CREATE INDEX invariant_events_ts ON invariant_events(ts);
CREATE INDEX invariant_events_alerted ON invariant_events(alerted);

-- ---------------------------------------------------------------- snapshots
CREATE TABLE chain_snapshots (
  ts INTEGER PRIMARY KEY,
  block INTEGER,
  head_block INTEGER,
  lib INTEGER,
  current_supply INTEGER,
  virtual_supply INTEGER,
  pxs_supply INTEGER,
  dpf_pxs INTEGER,
  dpf_pixa INTEGER,
  vesting_fund_pixa INTEGER,
  vesting_shares INTEGER,
  reward_fund_pixa INTEGER,
  recent_claims TEXT,
  pending_rewarded_vesting_pixa INTEGER,
  feed_base INTEGER,
  feed_quote INTEGER,
  pxs_print_rate INTEGER,
  pxs_stop_percent INTEGER,
  creation_fee INTEGER,
  max_block_size INTEGER,
  liquid_pixa INTEGER,
  liquid_pxs INTEGER,
  liquid_pixa_supply_method INTEGER,
  account_count INTEGER,
  witness_count INTEGER,
  scheduled_witnesses INTEGER,
  max_voted_witnesses INTEGER,
  hf_required_witnesses INTEGER,
  majority_version TEXT
);

CREATE TABLE witness_snapshots (
  ts INTEGER NOT NULL,
  witness TEXT NOT NULL,
  rank INTEGER,
  votes TEXT,                -- VESTS*1e6 as text
  total_missed INTEGER,
  last_confirmed_block INTEGER,
  last_feed_ts INTEGER,
  feed_base INTEGER,
  feed_quote INTEGER,
  running_version TEXT,
  hf_version_vote TEXT,
  signing_key TEXT,
  url TEXT,
  creation_fee INTEGER,
  max_block_size INTEGER,
  PRIMARY KEY (ts, witness)
) WITHOUT ROWID;
CREATE INDEX witness_snapshots_witness ON witness_snapshots(witness, ts);

CREATE TABLE balances (
  account TEXT PRIMARY KEY,
  pixa INTEGER,
  pxs INTEGER,
  savings_pixa INTEGER,
  savings_pxs INTEGER,
  vests INTEGER,
  delegated_out INTEGER,
  received INTEGER,
  withdraw_rate INTEGER,
  next_withdrawal_ts INTEGER,
  to_withdraw INTEGER,
  withdrawn INTEGER,
  reward_pixa INTEGER,
  reward_pxs INTEGER,
  reward_vests INTEGER,
  proxy TEXT,
  witnesses_voted_for INTEGER,
  recovery_account TEXT,
  last_post_ts INTEGER,
  last_vote_ts INTEGER,
  updated_ts INTEGER
);

-- ---------------------------------------------------------------- metrics, alerts, actions
CREATE TABLE metric_defs (
  metric TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  unit TEXT,
  section TEXT,
  grains TEXT,
  kind TEXT,                 -- counter | gauge | distinct | ratio | distribution
  description TEXT,
  def_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE metric_rollup (
  metric TEXT NOT NULL,
  grain TEXT NOT NULL,       -- hour | day | week | month | snap
  dim TEXT NOT NULL DEFAULT '',
  bucket INTEGER NOT NULL,
  value REAL,
  extra TEXT,
  def_version INTEGER NOT NULL DEFAULT 1,
  computed_at INTEGER,
  PRIMARY KEY (metric, grain, dim, bucket)
) WITHOUT ROWID;
CREATE INDEX metric_rollup_bucket ON metric_rollup(grain, bucket);

CREATE TABLE rollup_state (
  job TEXT PRIMARY KEY,
  last_bucket INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE thresholds (
  metric TEXT NOT NULL,
  dim TEXT NOT NULL DEFAULT '',  -- '' = every dimension's total; '*' = each dimension separately
  grain TEXT NOT NULL,
  op TEXT NOT NULL,              -- gt | lt | abs_change_pct
  amber REAL,
  red REAL,
  window_buckets INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  action_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER,
  PRIMARY KEY (metric, dim, grain)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,             -- metric|grain|dim or invariant|kind|subject
  metric TEXT,
  dim TEXT,
  severity TEXT NOT NULL,        -- amber | red
  state TEXT NOT NULL,           -- open | acknowledged | closed
  opened_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  closed_ts INTEGER,
  clear_count INTEGER NOT NULL DEFAULT 0,
  value REAL,
  threshold REAL,
  title TEXT,
  evidence TEXT,
  note TEXT
);
CREATE INDEX alerts_state ON alerts(state, key);
CREATE INDEX alerts_opened ON alerts(opened_ts);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER,
  ts INTEGER NOT NULL,
  actor TEXT,
  lever TEXT,
  description TEXT,
  tx_id TEXT,
  metric TEXT,
  dim TEXT,
  value_at_action REAL,
  review_7d REAL,
  review_30d REAL
);
CREATE INDEX actions_alert ON actions(alert_id);
