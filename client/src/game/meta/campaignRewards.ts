// Campaign clear star-rating pure functions (S3-1). Decoupled from UI / save — easy to unit-test.
//
// Star rating: remaining base HP% compared against level.rewards.starThresholds
// ([1★,2★,3★] HP% thresholds).
// Full base HP = BASE_HP(100); no healing, so remaining HP% = clamp(100 - damageTakenByBase, 0, 100).
//
// From PVE_INTEGRITY_PLAN §8 onward, clear settlement (progress/stars/materials) is server-authoritative:
// the client computes stars from this file and reports them to the server (POST /pve/clear validates
// and grants rewards). Materials are no longer granted locally and progress is no longer written locally
// (the old applyCampaignClear has been deleted; use SaveManager.recordClear instead).

import { BASE_HP } from '../config';

/**
 * Remaining base HP% → star count (0..3), based on non-decreasing thresholds.
 * A clear always grants at least 1★: as long as the base was not destroyed (HP>0) the level
 * counts as cleared → at least 1★ (unlocks the next level).
 * starThresholds only **upgrade** the rating to 2★/3★; they must not demote a win to 0★.
 * (Previously, thresholds [50,80,100] would score a "HP<50% win" as 0★, causing the clear
 * not to be recorded and the next level not to unlock — see the §clear-0-star bug.)
 */
export function computeStars(
  thresholds: [number, number, number] | undefined,
  remainingHpPct: number,
): 0 | 1 | 2 | 3 {
  if (remainingHpPct <= 0) return 0; // base destroyed = level failed
  if (!thresholds) return 1;
  let stars = 0;
  for (const t of thresholds) {
    if (remainingHpPct >= t) stars++;
  }
  return Math.max(1, stars) as 0 | 1 | 2 | 3; // floor at 1★ on any win
}

/** Compute remaining base HP% from damage taken by the player's base this match (full HP = 100, clamped to 0..100). */
export function remainingHpPct(damageTakenByBase: number): number {
  return Math.max(0, Math.min(100, BASE_HP - damageTakenByBase));
}
