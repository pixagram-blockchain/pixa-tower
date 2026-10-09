-- Seed thresholds. Starting values: tune them after the first month of data,
-- with PUT /v1/admin/thresholds/{metric} (no deploy needed).
-- op: gt | lt | abs_gt | abs_change_pct. dim '' = total, '*' = every dimension separately.

INSERT OR IGNORE INTO thresholds (metric, dim, grain, op, amber, red, window_buckets, owner, action_hint) VALUES
-- the Tower itself
('ingest_lag', '', 'hour', 'gt', 100, 1200, 1, 'tower operator', 'Check the scanner logs and the public nodes; the API serves stale data meanwhile'),
('unknown_ops', '', 'hour', 'gt', 0, 0, 1, 'tower operator', 'A hardfork may have added an operation: update the parser and replay the range'),

-- economy
('pxs_debt_ratio', '', 'hour', 'gt', 0.15, 0.20, 3, 'Pixagram SA', 'Debt ratio near the stop-print line: prepare communication to creators'),
('days_to_stop_print', '', 'day', 'lt', 90, 30, 1, 'Pixagram SA', 'Communicate early; consider a policy proposal'),
('feed_spread', '', 'hour', 'gt', 0.05, 0.15, 2, 'witnesses', 'Witness feeds disagree: find the outlier in witness_feed_deviation'),
('liquid_supply_gap', '', 'hour', 'abs_gt', 0.001, 0.01, 3, 'tower operator', 'Liquid PIXA from balances and from supply disagree: check balance refresh and parser'),
('dpf_runway', '', 'day', 'lt', 365, 90, 1, 'DPF voters', 'Defund lower-priority proposals'),

-- governance
('free_witness_seats', '', 'hour', 'gt', 0, 7, 1, 'stakeholders', 'Elected seats are free: anyone running witness nodes takes them without stake. Recruit witnesses.'),
('capture_cost', 'stall_finality', 'hour', 'lt', 1000000, 1, 1, 'stakeholders', 'Stalling finality costs little or nothing: raise vote participation, recruit witnesses'),
('capture_cost', 'majority', 'hour', 'lt', 5000000, 1, 1, 'stakeholders', 'A majority of the schedule costs little or nothing: raise vote participation, recruit witnesses'),
('witness_bench', '', 'hour', 'lt', 5, 3, 1, 'stakeholders', 'Few or no backup witnesses: recruit operators, consider a DPF proposal for backup nodes'),
('witness_feed_age', '*', 'hour', 'gt', 24, 72, 1, 'witness operators', 'Contact the operator; unvote if the feed stays stale'),
('witness_feed_deviation', '*', 'hour', 'abs_gt', 0.10, 0.25, 2, 'witness operators', 'Broken price bot or manipulation: publish it'),
('witness_missed_blocks', '*', 'day', 'gt', 36, 144, 1, 'witness operators', 'Contact the operator, then unvote'),
('fresh_stake_witness_votes', '', 'hour', 'gt', 0, 5, 1, 'stakeholders', 'Witness votes from accounts under 7 days old: check where their stake came from'),
('witness_vote_swing', '', 'day', 'gt', 0.10, 0.25, 1, 'stakeholders', 'Large swing in a witness''s votes: see the dimension and the vote log'),
('elected_set_churn', '', 'day', 'gt', 0, 2, 1, 'stakeholders', 'The elected set changed: check who entered and why'),
('hf_readiness', '', 'hour', 'lt', 1.0, 0.67, 12, 'witness operators', 'Elected witnesses lag the majority version: contact them before the next hardfork'),
('shared_signing_keys', '', 'hour', 'gt', 0, 0, 1, 'stakeholders', 'One signing key behind several witnesses: one operator holds several seats'),
('treasury_invariant', '', 'hour', 'gt', 0, 0, 1, 'Pixagram SA', 'A restricted treasury account voted: investigate the signers immediately'),

-- content and community
('cold_start_rate', '', 'day', 'gt', 0.5, 0.8, 3, 'Pixa Rex', 'Many posts get no vote in 24 h: run curation efforts, review discovery'),
('duplicate_artworks', '', 'day', 'gt', 2, 10, 1, 'Pixa Rex', 'Exact duplicate artworks: check for plagiarism or reward farming'),
('stickiness', '', 'day', 'lt', 0.15, 0.05, 7, 'Pixa Rex', 'Few monthly users come back daily: review notifications and the feed'),
('dormant_share', '', 'day', 'gt', 0.6, 0.8, 7, 'Pixa Rex', 'Most accounts are dormant: reactivation campaign'),
('reward_concentration', 'authors', 'day', 'gt', 0.5, 0.8, 7, 'Pixa Rex', 'Rewards concentrate on few authors: review curation and the reward curve'),
('vote_rings', '', 'day', 'gt', 0, 5, 1, 'community', 'Reciprocal voting pairs: publish the evidence, coordinate downvotes'),
('authority_changes', '', 'hour', 'gt', 10, 50, 1, 'security', 'A burst of key changes may be a phishing wave: warn users'),
('large_outflows_after_key_change', '', 'day', 'gt', 0, 3, 1, 'security', 'Funds moved right after a key change: possible account takeover'),
('posting_grants_max', '', 'day', 'gt', 50, 500, 1, 'security', 'One app key could post for many accounts: audit that app'),
('recovery_concentration', '', 'day', 'gt', 0.9, NULL, 1, 'security', 'Most accounts share one recovery account: protect its keys');
