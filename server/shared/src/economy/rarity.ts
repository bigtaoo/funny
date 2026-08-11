// Economy config — rarity tiers (ECONOMY_BALANCE.md §4.1). 2026-08-11 split (independent function
// modules form, claudedocs/server.md's "拆分形态的优先级" 形态①) — zero cross-file dependency, the DAG
// root gacha.ts imports from. See ../economy.ts for the full split rationale.
import type { Rarity } from '../types';

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Rarity-tier weights (§4.1). Used as the soft-pity boosted-roll rarity split and by limited/starter pools'
 *  flat rarity-tier roll; the standard pool's own base roll uses STANDARD_POOL_FIXED_ODDS instead (§2.1b). */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 700,
  rare: 230,
  epic: 60,
  legendary: 10,
};
