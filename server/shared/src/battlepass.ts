// Battle Pass system (S11, SEASON_DESIGN.md §C). Pure data + pure functions, no DB / no PIXI.
// Reward curve numbers are provisional; tunable parameters see ECONOMY_NUMBERS §13.

/** Maximum Battle Pass level within a single season. */
export const BATTLEPASS_MAX_LEVEL = 30;

/** Cost to buy a Pass (coins). Benchmarked against the ¥6 tier (ECONOMY_BALANCE §2.2). */
export const BATTLEPASS_BUY_COST = 600;

/** Season XP awarded per ranked game (more for a win). */
export const BP_XP_PER_RANKED_WIN = 120;
export const BP_XP_PER_RANKED_LOSS = 40;

/** Cumulative XP required for a single level (fixed per level). */
export const BP_XP_PER_LEVEL = 600;

export type BpRewardKind = 'coins' | 'material' | 'skin';

export interface BpReward {
  kind: BpRewardKind;
  /** kind=coins → amount; kind=material/skin → id. */
  id?: string;
  count: number;
}

export interface BpLevelDef {
  level: number; // 1..MAX_LEVEL
  /** Cumulative XP required to reach this level. */
  xpRequired: number;
  free?: BpReward; // free track reward
  paid?: BpReward; // paid track reward (requires hasPass)
}

// ── Reward shorthands (keep the table below terse + scannable) ──────────────────
const coins = (count: number): BpReward => ({ kind: 'coins', count });
const scrap = (count: number): BpReward => ({ kind: 'material', id: 'scrap', count });
const lead = (count: number): BpReward => ({ kind: 'material', id: 'lead', count });
const binding = (count: number): BpReward => ({ kind: 'material', id: 'binding', count });

/**
 * Battle Pass reward table (30 levels, re-planned ECONOMY_NUMBERS §13.3). Design shape:
 *  · Both tracks escalate — material tiers climb scrap → lead → binding and coin milestones grow.
 *  · Milestone rows (every 5th level) always pay coins, growing to a season-ending jackpot at Lv30.
 *  · Free track fills the gaps with crafting material (a steady equipment-economy faucet); its coin
 *    total (960) stays under one 10-pull (1,350), per the §13.3 cap.
 *  · Paid track pays coins on most levels (the monetization faucet) with fatter material bundles on a
 *    few levels; every paid coin payout ≥ its free counterpart, and Lv30 is the single biggest payout.
 * Only 'coins' and 'material' kinds are used — these are the two the claim path grants (service.ts);
 * card/skin rewards are intentionally excluded (would enter PvP power / collide with skin monetization).
 * Numbers are [tunable] — tune here + mirror in client/src/game/balance/battlepassDefs.ts + doc §13.3.
 */
const REWARD_ROWS: Array<[free: BpReward, paid: BpReward]> = [
  /* Lv1  */ [scrap(2), coins(20)],
  /* Lv2  */ [scrap(3), coins(20)],
  /* Lv3  */ [scrap(3), scrap(5)],
  /* Lv4  */ [scrap(4), coins(25)],
  /* Lv5  */ [coins(60), coins(60)],
  /* Lv6  */ [lead(1), coins(25)],
  /* Lv7  */ [scrap(5), lead(2)],
  /* Lv8  */ [lead(1), coins(30)],
  /* Lv9  */ [lead(2), coins(30)],
  /* Lv10 */ [coins(150), coins(220)],
  /* Lv11 */ [lead(2), coins(30)],
  /* Lv12 */ [scrap(6), lead(3)],
  /* Lv13 */ [lead(2), coins(35)],
  /* Lv14 */ [lead(3), coins(35)],
  /* Lv15 */ [coins(90), coins(90)],
  /* Lv16 */ [binding(1), coins(35)],
  /* Lv17 */ [lead(3), binding(2)],
  /* Lv18 */ [binding(1), coins(40)],
  /* Lv19 */ [binding(2), coins(40)],
  /* Lv20 */ [coins(220), coins(320)],
  /* Lv21 */ [binding(2), coins(40)],
  /* Lv22 */ [lead(4), binding(3)],
  /* Lv23 */ [binding(2), coins(45)],
  /* Lv24 */ [binding(3), coins(45)],
  /* Lv25 */ [coins(120), coins(120)],
  /* Lv26 */ [binding(3), coins(45)],
  /* Lv27 */ [lead(5), binding(4)],
  /* Lv28 */ [binding(3), coins(50)],
  /* Lv29 */ [binding(4), coins(50)],
  /* Lv30 */ [coins(320), coins(520)],
];

export const BATTLEPASS_DEFS: BpLevelDef[] = REWARD_ROWS.map(([free, paid], i) => {
  const level = i + 1;
  return { level, xpRequired: level * BP_XP_PER_LEVEL, free, paid };
});

/** Given cumulative XP, return the current Battle Pass level (1-based, capped at MAX_LEVEL). */
export function xpToLevel(xp: number): number {
  return Math.min(BATTLEPASS_MAX_LEVEL, Math.max(1, Math.floor(xp / BP_XP_PER_LEVEL) + 1));
}

/** XP still needed to reach the next level from the current one (for display purposes). */
export function xpToNextLevel(xp: number): number {
  if (xp >= BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL) return 0;
  const curLevel = xpToLevel(xp);
  return curLevel * BP_XP_PER_LEVEL - xp;
}

/** Battle Pass data block (SaveData.battlePass). Absence is treated as "not participating this season"; lazily created. */
export interface BattlePassData {
  seasonNo: number;     // owning season; if behind the clock the data is reset via cross-season migration
  xp: number;           // cumulative season XP this season
  level: number;        // derived from xp (cached for display)
  hasPass: boolean;     // whether the paid Pass has been purchased
  claimedFree: number[]; // set of free-track levels already claimed
  claimedPaid: number[]; // set of paid-track levels already claimed (only claimable with hasPass)
}

/** Fresh/reset Battle Pass data (initial state after cross-season migration). */
export function makeFreshBattlePass(seasonNo: number): BattlePassData {
  return {
    seasonNo,
    xp: 0,
    level: 1,
    hasPass: false,
    claimedFree: [],
    claimedPaid: [],
  };
}

/** Battle Pass claim error codes. */
export type BpClaimError =
  | 'NOT_REACHED'     // level not yet unlocked
  | 'ALREADY_CLAIMED' // reward already claimed
  | 'PASS_REQUIRED'   // paid track requires Pass
  | 'BAD_REQUEST';    // invalid parameters

/**
 * Pure function: validates and executes a claim, returning {new battlePass, reward} or an error code.
 * No DB operations; wrapped in an optimistic-lock transaction by the meta handler.
 */
export function claimBpReward(
  bp: BattlePassData,
  track: 'free' | 'paid',
  level: number,
): { ok: true; bp: BattlePassData; reward: BpReward } | { ok: false; error: BpClaimError } {
  if (level < 1 || level > BATTLEPASS_MAX_LEVEL) return { ok: false, error: 'BAD_REQUEST' };
  const def = BATTLEPASS_DEFS[level - 1];
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  if (level > bp.level) return { ok: false, error: 'NOT_REACHED' };
  if (track === 'free') {
    if (bp.claimedFree.includes(level)) return { ok: false, error: 'ALREADY_CLAIMED' };
    if (!def.free) return { ok: false, error: 'BAD_REQUEST' };
    return {
      ok: true,
      bp: { ...bp, claimedFree: [...bp.claimedFree, level] },
      reward: def.free,
    };
  } else {
    if (!bp.hasPass) return { ok: false, error: 'PASS_REQUIRED' };
    if (bp.claimedPaid.includes(level)) return { ok: false, error: 'ALREADY_CLAIMED' };
    if (!def.paid) return { ok: false, error: 'BAD_REQUEST' };
    return {
      ok: true,
      bp: { ...bp, claimedPaid: [...bp.claimedPaid, level] },
      reward: def.paid,
    };
  }
}

/**
 * Compute "cross-season Battle Pass catch-up": returns all unclaimed rewards the player should receive (sent as mail attachments).
 * Free track: all unclaimed slots at or below the reached level; paid track: same, when hasPass is true.
 */
export function pendingBpRewards(
  bp: BattlePassData,
): { track: 'free' | 'paid'; level: number; reward: BpReward }[] {
  const result: { track: 'free' | 'paid'; level: number; reward: BpReward }[] = [];
  const freeSet = new Set(bp.claimedFree);
  const paidSet = new Set(bp.claimedPaid);
  for (const def of BATTLEPASS_DEFS) {
    if (def.level > bp.level) break;
    if (def.free && !freeSet.has(def.level)) {
      result.push({ track: 'free', level: def.level, reward: def.free });
    }
    if (def.paid && bp.hasPass && !paidSet.has(def.level)) {
      result.push({ track: 'paid', level: def.level, reward: def.paid });
    }
  }
  return result;
}
