// Witness-election arithmetic: how much stake it takes to capture the block schedule.
//
// hived schedules the top `max_voted_witnesses` witnesses by votes among those with a signing key,
// plus `max_runner_witnesses` by timeshare. A witness with a key is scheduled even with zero votes
// when there are fewer candidates than slots, so free slots cost an attacker almost nothing.

import { NULL_SIGNING_KEY_RE } from "./config";

export interface WitnessInfo {
  owner: string;
  votes: number; // VESTS in smallest unit (6 decimals), as on chain
  signing_key: string;
  running_version?: string;
  hardfork_version_vote?: string;
  last_confirmed_block_num?: number;
  last_pxs_exchange_update?: number; // unix seconds
}

export interface CaptureInput {
  witnesses: WitnessInfo[];
  maxVoted: number; // max_voted_witnesses
  maxRunner: number; // max_runner_witnesses
  hfRequired: number; // hardfork_required_witnesses
  vestsToPixa: number; // total_vesting_fund_pixa / total_vesting_shares
}

export interface CaptureTarget {
  goal: "stall_finality" | "majority" | "hardfork_quorum";
  seats: number; // seats the attacker needs
  freeSeats: number; // seats available without displacing anyone
  displace: number; // incumbents to outvote
  costVests: number; // stake needed (VESTS smallest unit), 0 when free seats suffice
  costPxp: number; // same in PXP (Pixa Power, PIXA units)
  weakestDisplaced: string | null;
}

export interface CaptureResult {
  eligible: number;
  elected: string[];
  scheduleSize: number;
  freeSeats: number;
  bench: number;
  marginVests: number | null; // votes of last elected minus first non-elected
  targets: CaptureTarget[];
}

export function isNullKey(key: string | undefined | null): boolean {
  return !key || NULL_SIGNING_KEY_RE.test(key);
}

export function captureCost(input: CaptureInput): CaptureResult {
  const eligible = input.witnesses.filter((w) => !isNullKey(w.signing_key)).sort((a, b) => b.votes - a.votes);
  const elected = eligible.slice(0, input.maxVoted);
  const bench = Math.max(0, eligible.length - elected.length);
  const scheduleSize = input.maxVoted + input.maxRunner;
  const freeSeats = Math.max(0, input.maxVoted - elected.length);
  const marginVests = eligible.length > input.maxVoted ? elected[elected.length - 1].votes - eligible[input.maxVoted].votes : null;

  const goals: { goal: CaptureTarget["goal"]; seats: number }[] = [
    { goal: "stall_finality", seats: Math.floor(scheduleSize / 3) + 1 },
    { goal: "majority", seats: Math.floor(scheduleSize / 2) + 1 },
    { goal: "hardfork_quorum", seats: input.hfRequired },
  ];

  const targets = goals.map(({ goal, seats }) => {
    const displace = Math.max(0, seats - freeSeats);
    let costVests = 0;
    let weakest: string | null = null;
    if (displace > 0) {
      if (displace > elected.length) {
        costVests = Infinity;
      } else {
        // Each attacker witness must outvote the displace-th weakest elected witness.
        const target = elected[elected.length - displace];
        costVests = target.votes + 1;
        weakest = target.owner;
      }
    }
    return {
      goal, seats, freeSeats, displace, costVests,
      costPxp: Number.isFinite(costVests) ? (costVests / 1e6) * input.vestsToPixa : Infinity,
      weakestDisplaced: weakest,
    };
  });

  return { eligible: eligible.length, elected: elected.map((w) => w.owner), scheduleSize, freeSeats, bench, marginVests, targets };
}

/** Witnesses sharing one signing key: one operator behind several witnesses. */
export function sharedKeys(witnesses: WitnessInfo[]): { key: string; owners: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const w of witnesses) {
    if (isNullKey(w.signing_key)) continue;
    byKey.set(w.signing_key, [...(byKey.get(w.signing_key) ?? []), w.owner]);
  }
  return [...byKey.entries()].filter(([, o]) => o.length > 1).map(([key, owners]) => ({ key, owners }));
}
