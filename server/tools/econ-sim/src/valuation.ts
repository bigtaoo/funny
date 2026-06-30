// ─────────────────────────────────────────────────────────────────────────────
// Material -> coin valuation basis (SLG_ECONOMY_CHECK §2.4)
//
// The project has NO explicit material price. We derive a CONSERVATIVE upper bound
// straight from two shipped tables so the basis never drifts from code:
//
//   DUPE_REFUND_COINS[rarity]      = coin value the game itself assigns to landing a
//                                    duplicate (= the value of one gacha slot of that rarity)
//   GACHA_MATERIAL_GRANTS[mat_*]   = how much raw material one slot of that rarity grants
//
// A gacha rarity slot can resolve to either a (dupe) skin or its material grant, so the
// game treats them as same-value within a tier. Therefore:
//
//   value(material) = DUPE_REFUND_COINS[tier(material)] / GACHA_MATERIAL_GRANTS[mat][material]
//
//   scrap   = common dupe (10)  / 10  = 1      coin
//   lead    = rare   dupe (50)  / 3   = 16.67  coins
//   binding = epic   dupe (400) / 1   = 400    coins   <- dominant lever (epic value)
//
// Using the high epic value for binding makes the check CONSERVATIVE: it OVER-estimates
// settle output, so anything that passes here is genuinely safe (§2.4 "保守上界").
// ─────────────────────────────────────────────────────────────────────────────

import { DUPE_REFUND_COINS, GACHA_MATERIAL_GRANTS } from '@nw/shared';

export type MaterialKey = 'scrap' | 'lead' | 'binding';
export const MATERIALS: MaterialKey[] = ['scrap', 'lead', 'binding'];

/** mat_* gacha grant -> the rarity tier it sits in (from GACHA_POOLS standard pool layout). */
const MATERIAL_GACHA_TIER: Record<MaterialKey, keyof typeof DUPE_REFUND_COINS> = {
  scrap: 'common', // mat_scrap lives in common slots
  lead: 'rare', //    mat_lead lives in rare slots
  binding: 'epic', //  mat_binding lives in epic slots
};

const GRANT_KEY: Record<MaterialKey, string> = {
  scrap: 'mat_scrap',
  lead: 'mat_lead',
  binding: 'mat_binding',
};

/** Derived material -> coin valuation (conservative upper bound). Computed from shipped constants. */
export const MATERIAL_COIN_VALUE: Record<MaterialKey, number> = (() => {
  const out = {} as Record<MaterialKey, number>;
  for (const mat of MATERIALS) {
    const dupe = DUPE_REFUND_COINS[MATERIAL_GACHA_TIER[mat]];
    const grant = GACHA_MATERIAL_GRANTS[GRANT_KEY[mat]]?.[mat] ?? 1;
    out[mat] = dupe / grant;
  }
  return out;
})();

/** Coin-equivalent of a material bundle. */
export function bundleCoinValue(items: Partial<Record<string, number>>): number {
  let coins = 0;
  for (const mat of MATERIALS) {
    coins += (items[mat] ?? 0) * MATERIAL_COIN_VALUE[mat];
  }
  return coins;
}

// ── Regular F2P material grind baseline (per player), for the 人均稀释 denominator (§2.3 / §3) ──
//
// §2 stamina gate: 240 natural stamina/day, normal stage costs 6 -> 40 runs/day.
// §3 "基准 ×1" normal-stage material drop has no single absolute in code; we take a
// representative MID-GAME normal stage from server/shared/src/pveRewards.ts (ch3-5 band),
// discounted by the §3 re-grind factor (复刷 ×0.7). These are the player's recurring
// income from re-farming a chosen material stage, NOT one-time first-clear rewards.
export const GRIND_RUNS_PER_DAY = 40; // 240 stamina / 6 per normal run
export const REGRIND_FACTOR = 0.7; // §3 复刷材料折 70%
/** Representative mid-game normal-stage first-clear drop (pveRewards ch3-5 band, per run). */
export const NORMAL_STAGE_DROP: Record<MaterialKey, number> = { scrap: 9, lead: 5, binding: 0.3 };

/** Per-player regular MONTHLY material income from grinding (stamina-gated, re-grind rate). */
export const REGULAR_MONTHLY_MATERIAL: Record<MaterialKey, number> = (() => {
  const out = {} as Record<MaterialKey, number>;
  const runsPerMonth = GRIND_RUNS_PER_DAY * 30 * REGRIND_FACTOR;
  for (const mat of MATERIALS) out[mat] = runsPerMonth * NORMAL_STAGE_DROP[mat];
  return out;
})();

export const REGULAR_MONTHLY_MATERIAL_COINS = bundleCoinValue(REGULAR_MONTHLY_MATERIAL);

// ── Coin faucet baseline (per player), for the coin-economy cross-reference (§6.1) ──
// §6.1: ads ~900-1500/mo (dominant) + tasks ~60 + events ~40 + titles ~20 + achiev ~10.
// We take a mid figure; the strict early-target is ~300/mo (kept for reference).
export const MONTHLY_COIN_FAUCET_PER_PLAYER = 1200;
export const MONTHLY_COIN_FAUCET_STRICT = 300;
