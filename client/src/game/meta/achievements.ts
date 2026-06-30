// Client-side pure logic for the achievement system (ACHIEVEMENT_DESIGN §4.1).
// Authoritative implementation = server/shared/src/achievements.ts; this file **only mirrors
// the stateless tier-derivation** — these few stable lines — and does not mirror the
// ACHIEVEMENTS definition table. `defs` is delivered by GET /achievements from the server
// (codegen Achievement type) to avoid definition-table drift. Client and server use the
// same calculation (§4.1: the unlocked tier is always derived from stats on the spot, never
// persisted to the database).
import type { components } from '../../net/openapi';
import type { SaveData } from './SaveData';

/** Achievement definition (wire protocol, from codegen openapi schema, delivered by the server). */
export type Achievement = components['schemas']['Achievement'];

export interface TierState {
  tier: number; // 1-based
  threshold: number;
  coins: number;
  reached: boolean; // stat >= threshold
  claimable: boolean; // threshold reached and not yet claimed (badge source)
  claimed: boolean; // already claimed
  progress: number; // min(stat, threshold), used for the progress bar
}

/**
 * Derive the current state of each tier (stateless, same calculation as the server's tierState, §4.1).
 * @param claimedTiers Tier numbers already claimed for this achievement (from SaveData.achievements[id].claimedTiers).
 */
export function tierState(
  def: Achievement,
  stats: SaveData['stats'],
  claimedTiers: number[],
): TierState[] {
  const v = stats?.[def.statKey] ?? 0;
  return def.tiers.map((tDef, i) => {
    const tier = i + 1;
    const reached = v >= tDef.threshold;
    const claimed = claimedTiers.includes(tier);
    return {
      tier,
      threshold: tDef.threshold,
      coins: tDef.coins,
      reached,
      claimable: reached && !claimed,
      claimed,
      progress: Math.min(v, tDef.threshold),
    };
  });
}

/** Whether a given achievement has any claimable tier (badge source for cards / categories). */
export function achievementClaimable(
  def: Achievement,
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  const claimed = achievements?.[def.id]?.claimedTiers ?? [];
  return tierState(def, stats, claimed).some((s) => s.claimable);
}

/** Any achievement has a claimable tier → aggregate entry badge (§4.1). defs is the definition table delivered by the server. */
export function hasClaimable(
  defs: Achievement[],
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  return defs.some((def) => achievementClaimable(def, stats, achievements));
}

/**
 * Stable set of keys for all currently reached tiers, key = `${achId}#${tier}` (S9-5b).
 * Used after a cross-scene stats refresh to compute the "newly unlocked tier" diff set →
 * batched into a single achievement toast (ACHIEVEMENT_DESIGN §7).
 * Note: reached is based solely on stat >= threshold (independent of whether it has been
 * claimed); it grows monotonically with accumulated progress, so the diff set only gains
 * entries and never loses them.
 */
export function reachedTierKeys(defs: Achievement[], stats: SaveData['stats']): Set<string> {
  const out = new Set<string>();
  for (const def of defs) {
    const v = stats?.[def.statKey] ?? 0;
    def.tiers.forEach((tDef, i) => {
      if (v >= tDef.threshold) out.add(`${def.id}#${i + 1}`);
    });
  }
  return out;
}
