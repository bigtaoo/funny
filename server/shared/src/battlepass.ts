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

/**
 * Battle Pass level definition table. Free track gives a small coin pack every 5 levels; paid track
 * gives rewards every level, with special milestones (10/20/30) awarding large coin/material bonuses.
 * Numbers are provisional, pending calibration in ECONOMY_NUMBERS §13.
 */
export const BATTLEPASS_DEFS: BpLevelDef[] = Array.from({ length: BATTLEPASS_MAX_LEVEL }, (_, i) => {
  const level = i + 1;
  const xpRequired = level * BP_XP_PER_LEVEL;

  let free: BpReward | undefined;
  let paid: BpReward | undefined;

  // Free track: award coins at every 5th level; other levels award material (early scrap / mid lead / late binding).
  if (level % 5 === 0) {
    free = { kind: 'coins', count: 50 };
  } else if (level <= 10) {
    free = { kind: 'material', id: 'scrap', count: 3 };
  } else if (level <= 20) {
    free = { kind: 'material', id: 'lead', count: 1 };
  } else {
    free = { kind: 'material', id: 'binding', count: 1 };
  }
  // Special milestone overrides
  if (level === 10) free = { kind: 'coins', count: 150 };
  if (level === 20) free = { kind: 'coins', count: 200 };
  if (level === 30) free = { kind: 'coins', count: 300 };

  // Paid track: 20 coins per level + special milestones
  paid = { kind: 'coins', count: 20 };
  if (level === 10) paid = { kind: 'coins', count: 200 };
  if (level === 20) paid = { kind: 'coins', count: 300 };
  if (level === 30) paid = { kind: 'coins', count: 500 };

  return { level, xpRequired, free, paid };
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
