// Runtime configuration, read from Worker vars (wrangler.jsonc "vars") with safe defaults.
// Every list is comma-separated in the vars.

export interface TowerVars {
  CHAIN_NODES?: string;
  SYSTEM_ACCOUNTS?: string;
  RESTRICTED_ACCOUNTS?: string;
  DPF_ACCOUNT?: string;
  OPERATING_ACCOUNT?: string;
  TREASURY_SCHEDULE_ACCOUNT?: string;
  TREASURY_INITIAL_VESTS?: string;
  TGE_TIME?: string;
  ONBOARDING_ACCOUNTS?: string;
  EXCHANGE_ACCOUNTS?: string;
  ACTIVE_EXCLUDE_OPS?: string;
  CONTROVERSY_MIN_VOTES?: string;
  START_BLOCK?: string;
  LIVE_BATCH?: string;
  BACKFILL_BATCH?: string;
  MAX_BLOCKS_PER_TICK?: string;
  VERIFY_SECOND_NODE?: string;
  ARCHIVE_RAW?: string;
  BALANCE_FULL_REFRESH_MAX?: string;
  PUBLIC_BASE_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  APP_URL?: string;
}

export interface TowerConfig {
  nodes: string[];
  systemAccounts: Set<string>;
  restrictedAccounts: Set<string>;
  dpfAccount: string;
  operatingAccount: string;
  treasuryScheduleAccount: string;
  treasuryInitialVests: number; // VESTS smallest unit (6 decimals)
  tgeTime: number;
  onboardingAccounts: Set<string>;
  exchangeAccounts: Set<string>;
  activeExcludeOps: Set<string>;
  controversyMinVotes: number;
  startBlock: number;
  liveBatch: number;
  backfillBatch: number;
  maxBlocksPerTick: number;
  verifySecondNode: boolean;
  archiveRaw: boolean;
  balanceFullRefreshMax: number;
  appUrl: string;
}

const list = (v: string | undefined, fallback: string[]): string[] =>
  v === undefined || v.trim() === "" ? fallback : v.split(",").map((s) => s.trim()).filter(Boolean);

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};

export const DEFAULT_NODES = ["https://api.pixagram.com"];

export function loadConfig(vars: TowerVars): TowerConfig {
  const restricted = list(vars.RESTRICTED_ACCOUNTS, ["pixa.rex", "pixa.team"]);
  const dpf = vars.DPF_ACCOUNT || "pixa.omnibus";
  const operating = vars.OPERATING_ACCOUNT || "pixa";
  return {
    nodes: list(vars.CHAIN_NODES, DEFAULT_NODES),
    systemAccounts: new Set(list(vars.SYSTEM_ACCOUNTS, [...restricted, dpf, operating, "initminer", "null", "temp", "miners"])),
    restrictedAccounts: new Set(restricted),
    dpfAccount: dpf,
    operatingAccount: operating,
    treasuryScheduleAccount: vars.TREASURY_SCHEDULE_ACCOUNT || "pixa.rex",
    // 75,000,000 PIXA staked at genesis ≈ 75,000,000 VESTS (ratio about 1); stored with 6 decimals.
    treasuryInitialVests: num(vars.TREASURY_INITIAL_VESTS, 75_000_000 * 1e6),
    tgeTime: num(vars.TGE_TIME, Date.UTC(2026, 8, 4) / 1000),
    onboardingAccounts: new Set(list(vars.ONBOARDING_ACCOUNTS, [])),
    exchangeAccounts: new Set(list(vars.EXCHANGE_ACCOUNTS, [])),
    activeExcludeOps: new Set(list(vars.ACTIVE_EXCLUDE_OPS, ["feed_publish", "witness_set_properties", "witness_update"])),
    controversyMinVotes: num(vars.CONTROVERSY_MIN_VOTES, 5),
    startBlock: num(vars.START_BLOCK, 1),
    liveBatch: num(vars.LIVE_BATCH, 20),
    backfillBatch: num(vars.BACKFILL_BATCH, 200),
    maxBlocksPerTick: num(vars.MAX_BLOCKS_PER_TICK, 2000),
    verifySecondNode: (vars.VERIFY_SECOND_NODE ?? "true") === "true",
    archiveRaw: vars.ARCHIVE_RAW === "true",
    balanceFullRefreshMax: num(vars.BALANCE_FULL_REFRESH_MAX, 20000),
    appUrl: vars.APP_URL || "https://pixagram.com",
  };
}

export const PORTAL_RE = /^portal-\d+$/;
export const NULL_SIGNING_KEY_RE = /^PIX1111111111111111111111111111111114T1Anm$/;
