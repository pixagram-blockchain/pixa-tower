// Turns a range of Pixa blocks and their virtual operations into SQL statements.
// Every statement is idempotent: re-running a range leaves the database unchanged.
// Votes and rewards come from hived's virtual operations, never from Hivemind.

import { amountOf, parseAmount, parsePrice, pick, type Amount } from "./assets";
import { PORTAL_RE, type TowerConfig } from "./config";
import { imageInfo, isArtworkBody, sha256Hex } from "./image";
import type { RawBlock, RawOp, RawVop } from "./rpc";
import { seq, signedPos, StmtList, virtualPos } from "./sql";
import { chainTime } from "./time";

export interface OpCtx {
  block: number;
  pos: number;
  ts: number;
  type: string; // without "_operation"
  value: Record<string, any>;
  virtual: boolean;
  trxId?: string;
}

export interface ParseStats {
  blocks: number;
  ops: number;
  vops: number;
  unknown: Record<string, number>;
  firstTs: number;
  lastTs: number;
}

export interface ParseResult {
  stmts: StmtList;
  stats: ParseStats;
}

export const opName = (t: string) => t.replace(/_operation$/, "");

// Signed operations the Tower understands. Anything else is counted as unknown and raises an event.
export const KNOWN_SIGNED = new Set([
  "vote", "comment", "transfer", "transfer_to_vesting", "withdraw_vesting", "limit_order_create", "limit_order_cancel",
  "feed_publish", "convert", "account_create", "account_update", "witness_update", "account_witness_vote",
  "account_witness_proxy", "pow", "custom", "report_over_production", "delete_comment", "custom_json", "comment_options",
  "set_withdraw_vesting_route", "limit_order_create2", "claim_account", "create_claimed_account",
  "request_account_recovery", "recover_account", "change_recovery_account", "escrow_transfer", "escrow_dispute",
  "escrow_release", "pow2", "escrow_approve", "transfer_to_savings", "transfer_from_savings",
  "cancel_transfer_from_savings", "custom_binary", "decline_voting_rights", "reset_account", "set_reset_account",
  "claim_reward_balance", "delegate_vesting_shares", "account_create_with_delegation", "witness_set_properties",
  "account_update2", "create_proposal", "update_proposal_votes", "remove_proposal", "update_proposal",
  "collateralized_convert", "recurrent_transfer",
]);

export const KNOWN_VIRTUAL = new Set([
  "fill_convert_request", "author_reward", "curation_reward", "comment_reward", "liquidity_reward", "interest",
  "fill_vesting_withdraw", "fill_order", "shutdown_witness", "fill_transfer_from_savings", "hardfork",
  "comment_payout_update", "return_vesting_delegation", "comment_benefactor_reward", "producer_reward",
  "clear_null_account_balance", "proposal_pay", "dhf_funding", "sps_fund", "hardfork_hive", "hardfork_hive_restore",
  "delayed_voting", "consolidate_treasury_balance", "effective_comment_vote", "ineffective_delete_comment",
  "dhf_conversion", "sps_convert", "expired_account_notification", "changed_recovery_account",
  "transfer_to_vesting_completed", "pow_reward", "vesting_shares_split", "account_created",
  "fill_collateralized_convert_request", "system_warning", "fill_recurrent_transfer", "failed_recurrent_transfer",
  "limit_order_cancelled", "producer_missed", "proposal_fee", "collateralized_convert_immediate_conversion",
  "escrow_approved", "escrow_rejected", "proxy_cleared", "declined_voting_rights",
]);

/** Accounts whose authority signed an operation. Used for activity. */
export function actorsOf(type: string, v: Record<string, any>): string[] {
  switch (type) {
    case "vote":
      return [v.voter];
    case "comment":
    case "comment_options":
    case "delete_comment":
      return [v.author];
    case "transfer":
    case "transfer_to_vesting":
    case "transfer_to_savings":
    case "transfer_from_savings":
    case "cancel_transfer_from_savings":
    case "recurrent_transfer":
    case "escrow_transfer":
      return [v.from];
    case "escrow_approve":
      return [v.who];
    case "escrow_dispute":
    case "escrow_release":
      return [v.who];
    case "withdraw_vesting":
    case "account_witness_vote":
    case "account_witness_proxy":
    case "claim_reward_balance":
    case "decline_voting_rights":
    case "account_update":
    case "account_update2":
      return [v.account];
    case "limit_order_create":
    case "limit_order_create2":
    case "limit_order_cancel":
    case "convert":
    case "collateralized_convert":
    case "witness_update":
    case "witness_set_properties":
      return [v.owner];
    case "feed_publish":
      return [v.publisher];
    case "account_create":
    case "account_create_with_delegation":
    case "claim_account":
    case "create_claimed_account":
    case "create_proposal":
    case "update_proposal":
      return [v.creator];
    case "custom_json": {
      const a = [...(v.required_posting_auths ?? []), ...(v.required_auths ?? [])];
      return a.length ? a : [];
    }
    case "custom":
    case "custom_binary":
      return [...(v.required_auths ?? []), ...(v.required_posting_auths ?? [])];
    case "set_withdraw_vesting_route":
      return [v.from_account];
    case "request_account_recovery":
      return [v.recovery_account];
    case "recover_account":
    case "change_recovery_account":
      return [v.account_to_recover];
    case "delegate_vesting_shares":
      return [v.delegator];
    case "update_proposal_votes":
      return [v.voter];
    case "remove_proposal":
      return [v.proposal_owner];
    default: {
      for (const k of ["account", "owner", "author", "from", "creator", "voter", "publisher", "worker_account"]) {
        if (typeof v[k] === "string") return [v[k]];
      }
      return [];
    }
  }
}

export function safeJson(text: unknown, maxBytes = 64 * 1024): { value: any; invalid: boolean } {
  if (text && typeof text === "object") return { value: text, invalid: false };
  if (typeof text !== "string" || text.trim() === "") return { value: null, invalid: false };
  if (text.length > maxBytes) return { value: null, invalid: true };
  try {
    return { value: JSON.parse(text), invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}

export type PostKind = "artwork" | "blog" | "reply" | "other";

/** Content classification, in the order the spec defines it. */
export function classifyPost(v: { parent_author?: string; parent_permlink?: string; body?: string }, meta: any): PostKind {
  if (v.parent_author) return "reply";
  if (v.parent_permlink && PORTAL_RE.test(v.parent_permlink)) return "blog";
  if (typeof v.body === "string" && isArtworkBody(v.body)) return "artwork";
  const format = meta && typeof meta === "object" ? meta.format : undefined;
  if (format === "markdown") return "blog";
  if (format === "image") return "artwork";
  return "other";
}

export function isDeletedMeta(meta: any, body: string | undefined): boolean {
  if (body !== undefined && body.trim() === "deleted") return true;
  if (!meta || typeof meta !== "object") return false;
  const d = meta.deleted;
  if (d === true || d === "true" || d === 1) return true;
  return Array.isArray(meta.tags) && meta.tags.includes("deleted");
}

/** A tip: a transfer whose memo points at a post: "@author/permlink" or an app URL. */
export function memoRef(memo: unknown): string | null {
  if (typeof memo !== "string" || memo.length > 2048 || memo.startsWith("#")) return null;
  const m = memo.match(/@([a-z0-9][a-z0-9.-]{1,15})\/([a-z0-9-]{1,255})/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---- witness_set_properties decoding (props are hex-serialized values) ----

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function readLegacyAsset(b: Uint8Array, off: number): Amount | null {
  if (b.length < off + 16) return null;
  const dv = new DataView(b.buffer, b.byteOffset);
  const amount = Number(dv.getBigInt64(off, true));
  const symbol = String.fromCharCode(...b.slice(off + 9, off + 16)).replace(/\0+$/, "");
  const parsed = parseAmount(`${(amount / 10 ** b[off + 8]).toFixed(b[off + 8])} ${symbol}`);
  return parsed;
}

export function decodeWitnessProps(props: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(props)) return out;
  for (const entry of props) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, hex] = [String(entry[0]), String(entry[1])];
    try {
      const b = hexBytes(hex);
      const dv = new DataView(b.buffer);
      switch (key) {
        case "account_creation_fee":
          out.account_creation_fee = readLegacyAsset(b, 0);
          break;
        case "maximum_block_size":
        case "account_subsidy_budget":
        case "account_subsidy_decay":
          out[key] = dv.getUint32(0, true);
          break;
        case "hbd_interest_rate":
        case "pxs_interest_rate":
          out.pxs_interest_rate = dv.getUint16(0, true);
          break;
        case "hbd_exchange_rate":
        case "pxs_exchange_rate": {
          const base = readLegacyAsset(b, 0);
          const quote = readLegacyAsset(b, 16);
          if (base && quote) out.pxs_exchange_rate = { base, quote };
          break;
        }
        case "url": {
          let len = 0, shift = 0, i = 0;
          for (; i < b.length; i++) {
            len |= (b[i] & 0x7f) << shift;
            shift += 7;
            if (!(b[i] & 0x80)) break;
          }
          out.url = new TextDecoder().decode(b.slice(i + 1, i + 1 + len));
          break;
        }
        default:
          out[key] = hex; // keys and unknown fields kept raw
      }
    } catch {
      out[key] = hex;
    }
  }
  return out;
}

// ---- the parser ----

export interface ParseOptions {
  /** Called for every artwork body. Default computes sha256; tests may stub it. */
  hashBody?: (body: string) => Promise<string>;
}

/** Merge signed and virtual operations in chain order. */
export function orderedOps(blocks: RawBlock[], startNum: number, vops: RawVop[]): { block: RawBlock; num: number; ops: OpCtx[] }[] {
  const byBlock = new Map<number, RawVop[]>();
  for (const v of vops) {
    const list = byBlock.get(v.block) ?? [];
    list.push(v);
    byBlock.set(v.block, list);
  }
  return blocks.map((block, i) => {
    const num = startNum + i;
    const ts = chainTime(block.timestamp);
    const signed: (OpCtx & { k1: number; k2: number; k3: number })[] = [];
    block.transactions.forEach((trx, ti) => {
      trx.operations.forEach((op, oi) => {
        signed.push({
          block: num, pos: signedPos(ti, oi), ts, type: opName(op.type), value: op.value as Record<string, any>,
          virtual: false, trxId: block.transaction_ids?.[ti], k1: ti, k2: oi, k3: 0,
        });
      });
    });
    const virt = (byBlock.get(num) ?? []).map((v, vi) => ({
      block: num, pos: virtualPos(vi), ts: chainTime(v.timestamp), type: opName(v.op.type),
      value: v.op.value as Record<string, any>, virtual: true, trxId: v.trx_id,
      // Block-level virtual ops (trx_in_block = 0xFFFFFFFF) run at the end of the block.
      k1: v.trx_in_block >= 4294967295 ? Number.MAX_SAFE_INTEGER : v.trx_in_block, k2: v.op_in_trx, k3: 1 + vi,
    }));
    const ops = [...signed, ...virt].sort((a, b) => a.k1 - b.k1 || a.k2 - b.k2 || a.k3 - b.k3);
    return { block, num, ops };
  });
}

/** Per-range accumulators: account updates are deduplicated and written once at the end of the range. */
export interface RangeAcc {
  lastActive: Map<string, number>;
  milestones: Map<string, number>; // "column\u0000account" -> earliest ts
  touchedPosts: Set<string>;
}

export async function parseRange(
  blocks: RawBlock[],
  startNum: number,
  vops: RawVop[],
  cfg: TowerConfig,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const s = new StmtList();
  const hash = opts.hashBody ?? sha256Hex;
  const stats: ParseStats = { blocks: blocks.length, ops: 0, vops: 0, unknown: {}, firstTs: 0, lastTs: 0 };
  const acc: RangeAcc = { lastActive: new Map(), milestones: new Map(), touchedPosts: new Set() };

  for (const { block, num, ops } of orderedOps(blocks, startNum, vops)) {
    const ts = chainTime(block.timestamp);
    if (!stats.firstTs) stats.firstTs = ts;
    stats.lastTs = ts;
    const signedCount = ops.filter((o) => !o.virtual).length;
    const vopCount = ops.length - signedCount;
    const sizeBytes = JSON.stringify(block.transactions).length;
    s.add(
      `INSERT INTO blocks (num, ts, witness, block_id, tx_count, op_count, vop_count, size_bytes) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(num) DO UPDATE SET ts=excluded.ts, witness=excluded.witness, block_id=excluded.block_id,
         tx_count=excluded.tx_count, op_count=excluded.op_count, vop_count=excluded.vop_count, size_bytes=excluded.size_bytes`,
      num, ts, block.witness, block.block_id ?? null, block.transactions.length, signedCount, vopCount, sizeBytes,
    );
    for (const op of ops) {
      if (op.virtual) stats.vops++;
      else stats.ops++;
      try {
        await handleOp(s, op, cfg, hash, acc);
      } catch (e) {
        s.add(
          `INSERT OR IGNORE INTO invariant_events (block, pos, ts, kind, severity, subject, detail) VALUES (?,?,?,?,?,?,?)`,
          op.block, op.pos, op.ts, "parse_error", "amber", op.type, String((e as Error).message).slice(0, 500),
        );
      }
      const known = op.virtual ? KNOWN_VIRTUAL.has(op.type) : KNOWN_SIGNED.has(op.type);
      if (!known) {
        stats.unknown[op.type] = (stats.unknown[op.type] ?? 0) + 1;
        s.add(
          `INSERT OR IGNORE INTO invariant_events (block, pos, ts, kind, severity, subject, detail) VALUES (?,?,?,?,?,?,?)`,
          op.block, op.pos, op.ts, "unknown_op", "red", op.type, JSON.stringify(op.value).slice(0, 2000),
        );
      }
    }
  }

  // Account activity and first-time milestones, once per account and column.
  for (const [account, ts] of acc.lastActive) {
    s.add(
      `INSERT INTO accounts (name, last_active_ts) VALUES (?2, ?1)
       ON CONFLICT(name) DO UPDATE SET last_active_ts = MAX(COALESCE(accounts.last_active_ts, 0), ?1)`,
      ts, account,
    );
  }
  for (const [key, ts] of acc.milestones) {
    const [column, account] = key.split("\u0000");
    s.add(
      `INSERT INTO accounts (name, ${column}) VALUES (?2, ?1)
       ON CONFLICT(name) DO UPDATE SET ${column} = MIN(COALESCE(accounts.${column}, ?1), ?1)`,
      ts, account,
    );
  }

  // Recompute vote aggregates and controversy once per touched post.
  for (const key of acc.touchedPosts) {
    const [author, permlink] = splitKey(key);
    s.add(
      `UPDATE posts SET
         up_rshares = (SELECT COALESCE(SUM(rshares),0) FROM votes WHERE author=?1 AND permlink=?2 AND rshares>0),
         down_rshares = (SELECT COALESCE(-SUM(rshares),0) FROM votes WHERE author=?1 AND permlink=?2 AND rshares<0),
         up_count = (SELECT COUNT(*) FROM votes WHERE author=?1 AND permlink=?2 AND rshares>0),
         down_count = (SELECT COUNT(*) FROM votes WHERE author=?1 AND permlink=?2 AND rshares<0),
         first_vote_ts = (SELECT MIN(ts) FROM votes WHERE author=?1 AND permlink=?2 AND rshares<>0)
       WHERE author=?1 AND permlink=?2`,
      author, permlink,
    );
    s.add(
      `UPDATE posts SET
         controversy = CASE WHEN up_count + down_count >= ?3 AND up_rshares + down_rshares > 0
           THEN 2.0 * MIN(up_rshares, down_rshares) / (up_rshares + down_rshares) END,
         controversy_count = CASE WHEN up_count + down_count >= ?3
           THEN 2.0 * MIN(up_count, down_count) / (up_count + down_count) END
       WHERE author=?1 AND permlink=?2`,
      author, permlink, cfg.controversyMinVotes,
    );
  }
  return { stmts: s, stats };
}

const postKey = (a: string, p: string) => `${a}\u0000${p}`;
const splitKey = (k: string) => k.split("\u0000") as [string, string];

function activity(s: StmtList, op: OpCtx, cfg: TowerConfig, acc: RangeAcc, sub: string | null = null) {
  for (const account of new Set(actorsOf(op.type, op.value))) {
    if (typeof account !== "string" || !account) continue;
    s.add(
      `INSERT OR IGNORE INTO op_log (block, pos, account, ts, type, sub) VALUES (?,?,?,?,?,?)`,
      op.block, op.pos, account, op.ts, op.type, sub,
    );
    if (!cfg.activeExcludeOps.has(op.type)) {
      acc.lastActive.set(account, Math.max(acc.lastActive.get(account) ?? 0, op.ts));
    }
    if (cfg.restrictedAccounts.has(account) && isVotingOp(op.type)) {
      s.add(
        `INSERT OR IGNORE INTO invariant_events (block, pos, ts, kind, severity, subject, detail) VALUES (?,?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, "restricted_account_voted", "red", account,
        JSON.stringify({ op: op.type, value: op.value, trx_id: op.trxId }),
      );
    }
  }
}

function isVotingOp(type: string) {
  return type === "vote" || type === "account_witness_vote" || type === "account_witness_proxy" || type === "update_proposal_votes";
}

/** Set a first-time milestone: keeps the earliest timestamp, whatever order ranges are replayed in. */
function milestone(acc: RangeAcc, account: string, column: string, ts: number) {
  if (!account) return;
  const key = `${column}\u0000${account}`;
  const prev = acc.milestones.get(key);
  if (prev === undefined || ts < prev) acc.milestones.set(key, ts);
}

function invariant(s: StmtList, op: OpCtx, kind: string, severity: "info" | "amber" | "red", subject: string, detail: unknown) {
  s.add(
    `INSERT OR IGNORE INTO invariant_events (block, pos, ts, kind, severity, subject, detail) VALUES (?,?,?,?,?,?,?)`,
    op.block, op.pos, op.ts, kind, severity, subject, typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

function amt(raw: unknown): Amount {
  return parseAmount(raw) ?? { amount: 0, asset: "PIXA" };
}

async function handleOp(s: StmtList, op: OpCtx, cfg: TowerConfig, hash: (b: string) => Promise<string>, acc: RangeAcc) {
  const v = op.value;
  if (!op.virtual) {
    const sub = op.type === "custom_json" ? String(v.id ?? "").slice(0, 64) : op.type === "comment" ? commentSub(v) : null;
    activity(s, op, cfg, acc, sub);
  }

  switch (op.type) {
    // ------------------------------------------------------------ accounts
    case "account_created": {
      const name = v.new_account_name;
      s.add(
        `INSERT INTO accounts (name, created_block, created_ts, creator, delegation_vests, recovery_account, is_system, is_portal)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET created_block=excluded.created_block, created_ts=excluded.created_ts,
           creator=excluded.creator, recovery_account=COALESCE(accounts.recovery_account, excluded.recovery_account),
           is_system=excluded.is_system, is_portal=excluded.is_portal`,
        name, op.block, op.ts, v.creator, amountOf(v.initial_delegation, "VESTS"), v.creator,
        cfg.systemAccounts.has(name) ? 1 : 0, PORTAL_RE.test(name) ? 1 : 0,
      );
      return;
    }
    case "account_create":
    case "account_create_with_delegation":
    case "create_claimed_account": {
      const name = v.new_account_name;
      const fee = op.type === "create_claimed_account" ? 0 : amountOf(v.fee, "PIXA");
      const deleg = amountOf(v.delegation, "VESTS");
      s.add(
        `INSERT INTO accounts (name, created_block, created_ts, creator, create_op, fee_pixa, delegation_vests, recovery_account, is_system, is_portal)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET create_op=excluded.create_op, fee_pixa=excluded.fee_pixa,
           delegation_vests=MAX(COALESCE(accounts.delegation_vests,0), excluded.delegation_vests),
           created_block=COALESCE(accounts.created_block, excluded.created_block),
           created_ts=COALESCE(accounts.created_ts, excluded.created_ts),
           creator=COALESCE(accounts.creator, excluded.creator)`,
        name, op.block, op.ts, v.creator, op.type, fee, deleg, v.creator,
        cfg.systemAccounts.has(name) ? 1 : 0, PORTAL_RE.test(name) ? 1 : 0,
      );
      if (deleg > 0) {
        s.add(
          `INSERT INTO delegations (delegator, delegatee, vests, since_block) VALUES (?,?,?,?)
           ON CONFLICT(delegator, delegatee) DO UPDATE SET vests=excluded.vests, since_block=excluded.since_block`,
          v.creator, name, deleg, op.block,
        );
      }
      return;
    }
    case "account_update":
    case "account_update2": {
      for (const kind of ["owner", "active", "posting"] as const) {
        if (v[kind]) {
          s.add(
            `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
            op.block, op.pos, op.ts, v.account, kind,
            JSON.stringify({ threshold: v[kind].weight_threshold, keys: (v[kind].key_auths ?? []).length, account_auths: v[kind].account_auths ?? [] }),
          );
        }
      }
      if (v.memo_key) {
        s.add(
          `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
          op.block, op.pos, op.ts, v.account, "memo", null,
        );
      }
      const pjm = safeJson(v.posting_json_metadata).value;
      if (pjm && typeof pjm === "object" && pjm.profile && pjm.profile.profile_image) {
        milestone(acc, v.account, "profile_set_ts", op.ts);
      }
      return;
    }
    case "change_recovery_account":
      s.add(
        `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, v.account_to_recover, "change_recovery", JSON.stringify({ new: v.new_recovery_account }),
      );
      return;
    case "changed_recovery_account":
      s.add(`UPDATE accounts SET recovery_account = ? WHERE name = ?`, v.new_recovery_account, v.account);
      return;
    case "request_account_recovery":
      s.add(
        `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, v.account_to_recover, "request_recovery", JSON.stringify({ by: v.recovery_account }),
      );
      return;
    case "recover_account":
      s.add(
        `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, v.account_to_recover, "recover", null,
      );
      return;
    case "decline_voting_rights":
      s.add(
        `INSERT OR IGNORE INTO authority_events (block, pos, ts, account, kind, detail) VALUES (?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, v.account, "decline_voting", JSON.stringify({ decline: v.decline }),
      );
      return;

    // ------------------------------------------------------------ content
    case "comment":
      await handleComment(s, op, cfg, hash, acc);
      return;
    case "comment_options": {
      const ext = Array.isArray(v.extensions) ? v.extensions : [];
      const benef = ext
        .map((e: any) => (Array.isArray(e) ? e[1] : e?.value))
        .find((x: any) => x && Array.isArray(x.beneficiaries))?.beneficiaries ?? null;
      s.add(
        `UPDATE posts SET max_payout_pxs = ?, percent_pxs = ?, beneficiaries = ? WHERE author = ? AND permlink = ?`,
        amountOf(v.max_accepted_payout, "PXS"), pick<number>(v, ["percent_pxs", "percent_hbd", "percent_steem_dollars"]) ?? null,
        benef ? JSON.stringify(benef) : null, v.author, v.permlink,
      );
      return;
    }
    case "delete_comment": {
      // Only a post at or before this operation is removed: the permlink can be reused later.
      const opSeq = seq(op.block, op.pos);
      s.add(`DELETE FROM votes WHERE author = ? AND permlink = ? AND block <= ?`, v.author, v.permlink, op.block);
      s.add(
        `UPDATE posts SET deleted = 2, up_rshares = 0, down_rshares = 0, up_count = 0, down_count = 0, controversy = NULL,
           controversy_count = NULL, pending_payout_pxs = 0
         WHERE author = ? AND permlink = ? AND last_op_seq <= CAST(? AS INTEGER)`,
        v.author, v.permlink, opSeq,
      );
      return;
    }

    // ------------------------------------------------------------ votes
    case "vote": {
      s.add(
        `INSERT INTO votes (author, permlink, voter, block, ts, percent, rshares) VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(author, permlink, voter) DO UPDATE SET block=excluded.block, ts=excluded.ts, percent=excluded.percent`,
        v.author, v.permlink, v.voter, op.block, op.ts, v.weight,
      );
      milestone(acc, v.voter, "first_vote_ts", op.ts);
      acc.touchedPosts.add(postKey(v.author, v.permlink));
      return;
    }
    case "effective_comment_vote": {
      s.add(
        `INSERT INTO votes (author, permlink, voter, block, ts, rshares) VALUES (?,?,?,?,?,?)
         ON CONFLICT(author, permlink, voter) DO UPDATE SET rshares=excluded.rshares, block=excluded.block, ts=excluded.ts`,
        v.author, v.permlink, v.voter, op.block, op.ts, Number(v.rshares ?? 0),
      );
      const pending = parseAmount(v.pending_payout);
      if (pending) {
        s.add(`UPDATE posts SET pending_payout_pxs = ? WHERE author = ? AND permlink = ?`,
          pending.asset === "PXS" ? pending.amount : null, v.author, v.permlink);
      }
      acc.touchedPosts.add(postKey(v.author, v.permlink));
      return;
    }

    // ------------------------------------------------------------ rewards
    case "author_reward": {
      reward(s, op, "author", v.author, v.author, v.permlink,
        amountOf(pick(v, ["hive_payout", "pixa_payout", "steem_payout"]), "PIXA"),
        amountOf(pick(v, ["hbd_payout", "pxs_payout", "sbd_payout"]), "PXS"),
        amountOf(v.vesting_payout, "VESTS"));
      milestone(acc, v.author, "first_reward_ts", op.ts);
      return;
    }
    case "curation_reward": {
      const author = pick<string>(v, ["comment_author", "author"]);
      const permlink = pick<string>(v, ["comment_permlink", "permlink"]);
      reward(s, op, "curation", v.curator, author, permlink, 0, 0, amountOf(v.reward, "VESTS"));
      milestone(acc, v.curator, "first_reward_ts", op.ts);
      return;
    }
    case "comment_benefactor_reward": {
      reward(s, op, "beneficiary", v.benefactor, v.author, v.permlink,
        amountOf(pick(v, ["hive_payout", "pixa_payout"]), "PIXA"),
        amountOf(pick(v, ["hbd_payout", "pxs_payout"]), "PXS"),
        amountOf(v.vesting_payout, "VESTS"));
      return;
    }
    case "comment_reward": {
      s.add(
        `UPDATE posts SET paid = 1, payout_ts = ?, total_payout_pxs = ?, author_payout_pxs = ?,
           curator_payout_pxs = ?, beneficiary_payout_pxs = ?, pending_payout_pxs = 0
         WHERE author = ? AND permlink = ?`,
        op.ts, amountOf(v.payout, "PXS"), amountOf(v.total_payout_value, "PXS"),
        amountOf(v.curator_payout_value, "PXS"), amountOf(v.beneficiary_payout_value, "PXS"), v.author, v.permlink,
      );
      return;
    }
    case "comment_payout_update":
      s.add(
        `UPDATE posts SET paid = 1, payout_ts = COALESCE(payout_ts, ?), pending_payout_pxs = 0 WHERE author = ? AND permlink = ?`,
        op.ts, v.author, v.permlink,
      );
      return;
    case "producer_reward":
      reward(s, op, "producer", v.producer, null, null, 0, 0, amountOf(v.vesting_shares, "VESTS"));
      return;
    case "proposal_pay":
      reward(s, op, "dpf", v.receiver, null, String(v.proposal_id ?? ""), 0, amountOf(v.payment, "PXS"), 0);
      return;
    case "dhf_funding":
    case "sps_fund":
      reward(s, op, "dpf_funding", pick<string>(v, ["treasury", "fund_account"]) ?? cfg.dpfAccount, null, null,
        amountOf(v.additional_funds, "PIXA"), amountOf(v.additional_funds, "PXS"), 0);
      return;
    case "producer_missed":
      s.add(`INSERT OR IGNORE INTO witness_missed (block, pos, ts, witness) VALUES (?,?,?,?)`, op.block, op.pos, op.ts, v.producer);
      return;

    // ------------------------------------------------------------ money
    case "transfer":
    case "transfer_to_savings":
    case "transfer_from_savings":
    case "recurrent_transfer": {
      const a = amt(v.amount);
      const kind = op.type === "transfer" && a.asset === "VESTS" ? "vests_transfer" : op.type;
      s.add(
        `INSERT OR IGNORE INTO transfers (block, pos, ts, op, sender, receiver, amount, asset, memo_ref) VALUES (?,?,?,?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, kind, v.from, v.to, a.amount, a.asset, op.type === "transfer" ? memoRef(v.memo) : null,
      );
      return;
    }
    case "fill_transfer_from_savings":
    case "fill_recurrent_transfer": {
      const a = amt(v.amount);
      s.add(
        `INSERT OR IGNORE INTO transfers (block, pos, ts, op, sender, receiver, amount, asset, memo_ref) VALUES (?,?,?,?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, op.type, v.from, v.to, a.amount, a.asset, op.type === "fill_recurrent_transfer" ? memoRef(v.memo) : null,
      );
      return;
    }
    case "convert":
    case "collateralized_convert": {
      const a = amt(v.amount);
      market(s, op, v.owner, a.amount, a.asset, null, null, { requestid: v.requestid });
      return;
    }
    case "fill_convert_request":
    case "fill_collateralized_convert_request": {
      const i = amt(v.amount_in);
      const o = amt(v.amount_out);
      market(s, op, v.owner, i.amount, i.asset, o.amount, o.asset, { requestid: v.requestid, excess: v.excess_collateral });
      return;
    }
    case "limit_order_create":
    case "limit_order_create2": {
      const sell = amt(v.amount_to_sell);
      const recv = op.type === "limit_order_create" ? amt(v.min_to_receive) : null;
      market(s, op, v.owner, sell.amount, sell.asset, recv?.amount ?? null, recv?.asset ?? null, { orderid: v.orderid });
      return;
    }
    case "fill_order": {
      const pays = amt(v.current_pays);
      const got = amt(v.open_pays);
      market(s, op, v.current_owner, pays.amount, pays.asset, got.amount, got.asset, { counterparty: v.open_owner });
      return;
    }
    case "limit_order_cancel":
    case "limit_order_cancelled":
    case "escrow_transfer":
    case "escrow_approve":
    case "escrow_dispute":
    case "escrow_release":
    case "escrow_approved":
    case "escrow_rejected":
    case "collateralized_convert_immediate_conversion":
      market(s, op, v.owner ?? v.from ?? v.seller ?? v.who ?? "", null, null, null, null, v);
      return;
    case "claim_reward_balance": {
      s.add(
        `INSERT OR IGNORE INTO stake_events (block, pos, ts, op, account, counterparty, vests, pixa, pxs) VALUES (?,?,?,?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, "claim", v.account, null,
        amountOf(v.reward_vests, "VESTS"),
        amountOf(pick(v, ["reward_pixa", "reward_hive", "reward_steem"]), "PIXA"),
        amountOf(pick(v, ["reward_pxs", "reward_hbd", "reward_sbd"]), "PXS"),
      );
      milestone(acc, v.account, "first_claim_ts", op.ts);
      return;
    }

    // ------------------------------------------------------------ stake
    case "transfer_to_vesting": {
      stake(s, op, "power_up", v.from, v.to || v.from, 0, amountOf(v.amount, "PIXA"));
      milestone(acc, v.from, "first_powerup_ts", op.ts);
      return;
    }
    case "withdraw_vesting":
      stake(s, op, "power_down_set", v.account, null, amountOf(v.vesting_shares, "VESTS"), 0);
      return;
    case "fill_vesting_withdraw":
      stake(s, op, "power_down", v.from_account, v.to_account, amountOf(v.withdrawn, "VESTS"), amountOf(v.deposited, "PIXA"));
      return;
    case "set_withdraw_vesting_route":
      stake(s, op, "route", v.from_account, v.to_account, Number(v.percent ?? 0), 0);
      return;
    case "delegate_vesting_shares": {
      const vests = amountOf(v.vesting_shares, "VESTS");
      stake(s, op, "delegate", v.delegator, v.delegatee, vests, 0);
      if (vests === 0) {
        s.add(`DELETE FROM delegations WHERE delegator = ? AND delegatee = ?`, v.delegator, v.delegatee);
      } else {
        s.add(
          `INSERT INTO delegations (delegator, delegatee, vests, since_block) VALUES (?,?,?,?)
           ON CONFLICT(delegator, delegatee) DO UPDATE SET vests=excluded.vests, since_block=excluded.since_block`,
          v.delegator, v.delegatee, vests, op.block,
        );
      }
      return;
    }
    case "return_vesting_delegation":
      stake(s, op, "delegation_return", v.account, null, amountOf(v.vesting_shares, "VESTS"), 0);
      return;

    // ------------------------------------------------------------ governance
    case "account_witness_vote": {
      s.add(
        `INSERT OR IGNORE INTO witness_votes_log (block, pos, ts, voter, witness, approve, voter_vests, voter_age_days)
         VALUES (?,?,?,?,?,?,
           (SELECT vests FROM balances WHERE account = ?4),
           (SELECT (?3 - created_ts) / 86400.0 FROM accounts WHERE name = ?4))`,
        op.block, op.pos, op.ts, v.account, v.witness, v.approve ? 1 : 0,
      );
      if (v.approve) {
        s.add(`INSERT OR REPLACE INTO witness_votes (voter, witness, since_block) VALUES (?,?,?)`, v.account, v.witness, op.block);
      } else {
        s.add(`DELETE FROM witness_votes WHERE voter = ? AND witness = ?`, v.account, v.witness);
      }
      return;
    }
    case "account_witness_proxy":
      if (v.proxy) {
        s.add(`INSERT OR REPLACE INTO proxies (account, proxy, since_block) VALUES (?,?,?)`, v.account, v.proxy, op.block);
      } else {
        s.add(`DELETE FROM proxies WHERE account = ?`, v.account);
      }
      s.add(
        `INSERT OR IGNORE INTO witness_events (block, pos, ts, witness, op, field, old_value, new_value) VALUES (?,?,?,?,?,?,?,?)`,
        op.block, op.pos, op.ts, v.proxy || "", "account_witness_proxy", "proxy:" + v.account, null, v.proxy || "",
      );
      return;
    case "proxy_cleared":
      s.add(`DELETE FROM proxies WHERE account = ?`, v.account);
      return;
    case "witness_update": {
      witnessChange(s, op, v.owner, "signing_key", v.block_signing_key);
      witnessChange(s, op, v.owner, "url", v.url);
      const fee = parseAmount(v.props?.account_creation_fee);
      if (fee) witnessChange(s, op, v.owner, "account_creation_fee", String(fee.amount));
      if (v.props?.maximum_block_size !== undefined) witnessChange(s, op, v.owner, "maximum_block_size", String(v.props.maximum_block_size));
      return;
    }
    case "witness_set_properties": {
      const props = decodeWitnessProps(v.props);
      if (typeof props.new_signing_key === "string") witnessChange(s, op, v.owner, "signing_key_hex", props.new_signing_key);
      if (typeof props.url === "string") witnessChange(s, op, v.owner, "url", props.url);
      const fee = props.account_creation_fee as Amount | null | undefined;
      if (fee) witnessChange(s, op, v.owner, "account_creation_fee", String(fee.amount));
      if (props.maximum_block_size !== undefined) witnessChange(s, op, v.owner, "maximum_block_size", String(props.maximum_block_size));
      const rate = props.pxs_exchange_rate as { base: Amount; quote: Amount } | undefined;
      if (rate) feed(s, op, v.owner, rate.base, rate.quote);
      return;
    }
    case "feed_publish": {
      const price = parsePrice(v.exchange_rate);
      if (price) feed(s, op, v.publisher, price.base, price.quote);
      return;
    }
    case "update_proposal_votes": {
      const ids: number[] = Array.isArray(v.proposal_ids) ? v.proposal_ids : [];
      for (const id of ids) {
        if (v.approve) {
          s.add(`INSERT OR REPLACE INTO proposal_votes (proposal_id, voter, approve, since_block) VALUES (?,?,1,?)`, id, v.voter, op.block);
        } else {
          s.add(`DELETE FROM proposal_votes WHERE proposal_id = ? AND voter = ?`, id, v.voter);
        }
      }
      return;
    }
    case "create_proposal":
    case "update_proposal":
    case "remove_proposal":
      return; // the snapshotter keeps the proposals table from the chain's own list

    // ------------------------------------------------------------ social
    case "custom_json":
      handleCustomJson(s, op, cfg, acc);
      return;

    // ------------------------------------------------------------ chain events
    case "hardfork":
    case "hardfork_hive":
      invariant(s, op, "hardfork", "info", String(v.hardfork_id ?? ""), v);
      return;
    case "system_warning":
      invariant(s, op, "system_warning", "amber", "", v);
      return;
    case "shutdown_witness":
      invariant(s, op, "witness_shutdown", "amber", String(v.owner ?? ""), v);
      return;
    default:
      return;
  }
}

function commentSub(v: Record<string, any>): string | null {
  const meta = safeJson(v.json_metadata).value;
  const app = meta && typeof meta === "object" && typeof meta.app === "string" ? meta.app : null;
  return app ? app.slice(0, 64) : null;
}

function reward(
  s: StmtList, op: OpCtx, type: string, account: string, author: string | null | undefined,
  permlink: string | null | undefined, pixa: number, pxs: number, vests: number,
) {
  s.add(
    `INSERT OR IGNORE INTO rewards (block, pos, ts, type, account, author, permlink, pixa, pxs, vests) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    op.block, op.pos, op.ts, type, account, author ?? null, permlink ?? null, pixa, pxs, vests,
  );
}

function stake(s: StmtList, op: OpCtx, kind: string, account: string, counterparty: string | null, vests: number, pixa: number) {
  s.add(
    `INSERT OR IGNORE INTO stake_events (block, pos, ts, op, account, counterparty, vests, pixa, pxs) VALUES (?,?,?,?,?,?,?,?,0)`,
    op.block, op.pos, op.ts, kind, account, counterparty, vests, pixa,
  );
}

function market(
  s: StmtList, op: OpCtx, account: string, amountIn: number | null, assetIn: string | null,
  amountOut: number | null, assetOut: string | null, detail: unknown,
) {
  s.add(
    `INSERT OR IGNORE INTO market_events (block, pos, ts, op, account, amount_in, asset_in, amount_out, asset_out, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    op.block, op.pos, op.ts, op.type, account, amountIn, assetIn, amountOut, assetOut, JSON.stringify(detail).slice(0, 4000),
  );
}

function feed(s: StmtList, op: OpCtx, witness: string, base: Amount, quote: Amount) {
  // Stored as base = PXS, quote = PIXA whatever the orientation published.
  const [b, q] = base.asset === "PXS" ? [base, quote] : [quote, base];
  if (b.asset !== "PXS" || q.asset !== "PIXA") return;
  s.add(
    `INSERT OR IGNORE INTO feeds (block, pos, ts, witness, base, quote) VALUES (?,?,?,?,?,?)`,
    op.block, op.pos, op.ts, witness, b.amount, q.amount,
  );
}

function witnessChange(s: StmtList, op: OpCtx, witness: string, field: string, value: unknown) {
  if (value === undefined || value === null) return;
  // Logged only when the value differs from the previous one for this witness and field.
  s.add(
    `INSERT OR IGNORE INTO witness_events (block, pos, ts, witness, op, field, old_value, new_value)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, prev.new_value, ?7
     FROM (SELECT 1) AS one
     LEFT JOIN (SELECT new_value FROM witness_events
                WHERE witness = ?4 AND field = ?6 AND (block < ?1 OR (block = ?1 AND pos < ?2))
                ORDER BY block DESC, pos DESC LIMIT 1) AS prev ON 1 = 1
     WHERE prev.new_value IS NULL OR prev.new_value <> ?7`,
    op.block, op.pos, op.ts, witness, op.type, field, String(value),
  );
  // witness_state keeps the base58 key from witness_update only; set_properties gives raw hex.
  const column = field === "signing_key" ? "signing_key" : field === "url" ? "url" : null;
  if (column) {
    s.add(
      `INSERT INTO witness_state (witness, ${column}, updated_block) VALUES (?,?,?)
       ON CONFLICT(witness) DO UPDATE SET ${column}=excluded.${column}, updated_block=excluded.updated_block`,
      witness, String(value), op.block,
    );
  }
}

function handleCustomJson(s: StmtList, op: OpCtx, cfg: TowerConfig, acc: RangeAcc) {
  const v = op.value;
  const id = String(v.id ?? "");
  const actor: string | undefined = (v.required_posting_auths ?? [])[0] ?? (v.required_auths ?? [])[0];
  if (id !== "follow" && id !== "community" && id !== "reblog") return;
  const parsed = safeJson(v.json).value;
  if (!Array.isArray(parsed)) return;
  // Accept both ["follow", {...}] and [["follow", {...}], ...]
  const items: any[] = typeof parsed[0] === "string" ? [parsed] : parsed.filter(Array.isArray);
  items.slice(0, 100).forEach((item, idx) => {
    const [action, body] = [String(item[0] ?? ""), item[1] ?? {}];
    if (id === "follow" || id === "reblog") {
      if (action === "follow" && body && typeof body === "object") {
        const follower = String(body.follower ?? actor ?? "");
        if (!follower || (actor && follower !== actor)) return;
        const followings: string[] = Array.isArray(body.following) ? body.following : [body.following];
        const what = Array.isArray(body.what) ? body.what : [];
        for (const following of followings.filter((x) => typeof x === "string").slice(0, 100)) {
          if (what.length === 0) {
            s.add(`DELETE FROM follows WHERE follower = ? AND following = ?`, follower, following);
          } else {
            s.add(
              `INSERT INTO follows (follower, following, what, since_block, since_ts) VALUES (?,?,?,?,?)
               ON CONFLICT(follower, following) DO UPDATE SET what=excluded.what, since_block=excluded.since_block, since_ts=excluded.since_ts`,
              follower, following, String(what[0]), op.block, op.ts,
            );
            if (what[0] === "blog") milestone(acc, follower, "first_follow_ts", op.ts);
          }
        }
      } else if (action === "reblog" && body && typeof body === "object") {
        const account = String(body.account ?? actor ?? "");
        if (!account || (actor && account !== actor)) return;
        if (body.delete === "delete") {
          s.add(`DELETE FROM reblogs WHERE account = ? AND author = ? AND permlink = ?`, account, body.author, body.permlink);
        } else {
          s.add(`INSERT OR IGNORE INTO reblogs (account, author, permlink, ts) VALUES (?,?,?,?)`, account, body.author, body.permlink, op.ts);
        }
      }
      return;
    }
    // community
    const community = typeof body.community === "string" ? body.community : null;
    const target = body.account && body.permlink ? `${body.account}/${body.permlink}` : body.account ?? null;
    s.add(
      `INSERT OR IGNORE INTO community_ops (block, pos, idx, ts, community, actor, action, target, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      op.block, op.pos, idx, op.ts, community, actor ?? null, action.slice(0, 32),
      target ? String(target).slice(0, 300) : null,
      typeof body.notes === "string" ? body.notes.slice(0, 200) : body.role ? String(body.role) : null,
    );
  });
  void cfg;
}

async function handleComment(s: StmtList, op: OpCtx, cfg: TowerConfig, hash: (b: string) => Promise<string>, acc: RangeAcc) {
  const v = op.value;
  const { value: meta, invalid } = safeJson(v.json_metadata);
  const body: string = typeof v.body === "string" ? v.body : "";
  const isPatch = body.startsWith("@@ -");
  const kind = classifyPost(v, meta);
  const isRoot = !v.parent_author;
  const portal = isRoot && PORTAL_RE.test(v.parent_permlink ?? "") ? v.parent_permlink : null;
  const tags: string[] = meta && Array.isArray(meta.tags) ? meta.tags.filter((t: unknown) => typeof t === "string").slice(0, 10) : [];
  const app = meta && typeof meta.app === "string" ? meta.app.slice(0, 64) : null;
  const format = meta && typeof meta.format === "string" ? meta.format.slice(0, 32) : null;
  const nsfw = meta && typeof meta.nsfw === "boolean" ? (meta.nsfw ? 1 : 0) : null;
  const license = meta && meta.license && typeof meta.license === "object" ? 1 : meta ? 0 : null;
  const royalty = license && typeof meta.license.royaltyPercentage === "number" ? meta.license.royaltyPercentage : null;
  const deleted = isDeletedMeta(meta, isPatch ? undefined : body) ? 1 : 0;

  let info: ReturnType<typeof imageInfo> = null;
  let sha: string | null = null;
  let bytes: number | null = null;
  if (!isPatch && isArtworkBody(body)) {
    info = imageInfo(body.trim());
    sha = await hash(body.trim());
    bytes = body.length;
  } else if (!isPatch) {
    bytes = body.length;
  }
  const opSeq = seq(op.block, op.pos);

  // Bait-and-switch: the artwork's image changes after the post has been paid.
  if (sha) {
    s.add(
      `INSERT OR IGNORE INTO invariant_events (block, pos, ts, kind, severity, subject, detail)
       SELECT ?,?,?,'artwork_changed_after_payout','amber',?,?
       WHERE EXISTS (SELECT 1 FROM posts WHERE author = ?6 AND permlink = ?7 AND paid = 1 AND kind = 'artwork'
         AND body_sha256 IS NOT NULL AND body_sha256 <> ?8 AND last_op_seq < CAST(?9 AS INTEGER))`,
      op.block, op.pos, op.ts, `${v.author}/${v.permlink}`, JSON.stringify({ new_sha256: sha }),
      v.author, v.permlink, sha, opSeq,
    );
  }

  const newer = "excluded.last_op_seq >= posts.last_op_seq";
  // A permlink removed by delete_comment can be published again: the new comment replaces the old row.
  const reborn = "(posts.deleted = 2 AND excluded.last_op_seq > posts.last_op_seq)";
  const fresh = (col: string) => `${col} = CASE WHEN ${reborn} THEN excluded.${col} ELSE posts.${col} END`;
  const keep = (col: string) => `${col} = CASE WHEN ${newer} THEN excluded.${col} ELSE posts.${col} END`;
  const keepBody = (col: string) =>
    `${col} = CASE WHEN ${newer} AND excluded.body_bytes IS NOT NULL
      AND (excluded.body_sha256 IS NOT NULL OR posts.kind <> 'artwork') THEN excluded.${col} ELSE posts.${col} END`;

  s.add(
    `INSERT INTO posts (author, permlink, kind, portal, category, parent_author, parent_permlink, root_author, root_permlink,
       title, created_block, created_ts, app, format, tags, nsfw, license, royalty_pct, image_format, width, height,
       body_bytes, body_sha256, meta_invalid, deleted, last_op_seq)
     VALUES (?1, ?2, ?3,
       COALESCE(?4, (SELECT portal FROM posts WHERE author = ?6 AND permlink = ?7)),
       ?5, ?6, ?7,
       CASE WHEN ?6 = '' THEN ?1 ELSE COALESCE((SELECT root_author FROM posts WHERE author = ?6 AND permlink = ?7), ?6) END,
       CASE WHEN ?6 = '' THEN ?2 ELSE COALESCE((SELECT root_permlink FROM posts WHERE author = ?6 AND permlink = ?7), ?7) END,
       ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, CAST(?24 AS INTEGER))
     ON CONFLICT(author, permlink) DO UPDATE SET
       ${fresh("kind")}, ${fresh("portal")}, ${fresh("category")}, ${fresh("parent_author")}, ${fresh("parent_permlink")},
       ${fresh("root_author")}, ${fresh("root_permlink")}, ${fresh("created_block")}, ${fresh("created_ts")},
       paid = CASE WHEN ${reborn} THEN 0 ELSE posts.paid END,
       ${keep("title")}, ${keep("app")}, ${keep("format")}, ${keep("tags")}, ${keep("nsfw")}, ${keep("license")},
       ${keep("royalty_pct")}, ${keep("meta_invalid")},
       ${keepBody("image_format")}, ${keepBody("width")}, ${keepBody("height")}, ${keepBody("body_bytes")}, ${keepBody("body_sha256")},
       body_changed_after_payout = CASE WHEN ${newer} AND posts.paid = 1 AND excluded.body_sha256 IS NOT NULL
         AND posts.body_sha256 IS NOT NULL AND excluded.body_sha256 <> posts.body_sha256
         THEN 1 ELSE posts.body_changed_after_payout END,
       deleted = CASE WHEN ${reborn} THEN excluded.deleted WHEN posts.deleted = 2 THEN 2 WHEN ${newer} THEN excluded.deleted ELSE posts.deleted END,
       edit_count = CASE WHEN ${reborn} THEN 0 ELSE posts.edit_count + CASE WHEN excluded.last_op_seq > posts.last_op_seq THEN 1 ELSE 0 END END,
       last_op_seq = MAX(posts.last_op_seq, excluded.last_op_seq)`,
    v.author, v.permlink, kind, portal, isRoot ? v.parent_permlink : null, v.parent_author ?? "", v.parent_permlink ?? "",
    String(v.title ?? "").slice(0, 256), op.block, op.ts, app, format, tags.length ? JSON.stringify(tags) : null,
    nsfw, license, royalty, info?.format ?? null, info?.width ?? null, info?.height ?? null,
    bytes, sha, invalid ? 1 : 0, deleted, opSeq,
  );

  if (isRoot && (kind === "artwork" || kind === "blog")) {
    milestone(acc, v.author, "first_post_ts", op.ts);
    if (kind === "artwork") milestone(acc, v.author, "first_artwork_ts", op.ts);
  }
  void cfg;
}
