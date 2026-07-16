// ─────────────────────────────────────────────────────────────────────────────
// D-track: equipment `protect_enhance` shop-item pricing check (EQUIPMENT_DESIGN §6.2 / §E7).
//
// protect_enhance (SHOP_ITEMS, server/shared/src/economy.ts) is a consumable: used on one
// enhance attempt, if that attempt FAILS the materials are not consumed (coins still are —
// see enhanceEquipment's skipMaterials path, server/metaserver/src/equipment.ts). Its value
// to a player is therefore exactly "the material cost of the one failed attempt it protects",
// valued in coin-equivalent via the same conservative valuation basis as the A-track
// (valuation.ts: value(material) = DUPE_REFUND_COINS[tier] / GACHA_MATERIAL_GRANTS[mat]).
//
// This does NOT re-litigate the flat price (SHOP_ITEMS: protect_enhance cost=500, kept as-is
// 2026-07-16) — it computes, per enhance level, what one use is actually worth, so the flat
// price can be read against a real number instead of a guess.
// ─────────────────────────────────────────────────────────────────────────────

import { enhanceCost, enhanceSuccessRate, EQUIP_MAX_LEVEL } from '@nw/shared';
import { bundleCoinValue } from './valuation';

export interface ProtectLevelRow {
  fromLevel: number;
  toLevel: number;
  successRate: number;
  /** Expected attempts to clear this one level-up (1/p, geometric). */
  expectedAttempts: number;
  /** Materials spent on a single attempt at this level, coin-equivalent (conservative valuation). */
  materialCoinValuePerAttempt: number;
  /** Coins spent on a single attempt at this level (deducted regardless of protect — §E7 "金币仍照扣"). */
  coinsPerAttempt: number;
  /** Expected material coin-value LOST across the whole climb to this level (failures only, i.e. expectedAttempts-1). */
  expectedMaterialLossToClimb: number;
}

/** Per-level breakdown of what a single protect_enhance use is worth (materials-only, coins are never protected). */
export function protectValueByLevel(): ProtectLevelRow[] {
  const rows: ProtectLevelRow[] = [];
  for (let lv = 0; lv < EQUIP_MAX_LEVEL; lv++) {
    const cost = enhanceCost(lv);
    const p = enhanceSuccessRate(lv);
    const expectedAttempts = 1 / p;
    const materialCoinValuePerAttempt = bundleCoinValue(cost.materials);
    rows.push({
      fromLevel: lv,
      toLevel: lv + 1,
      successRate: p,
      expectedAttempts,
      materialCoinValuePerAttempt,
      coinsPerAttempt: cost.coins,
      expectedMaterialLossToClimb: (expectedAttempts - 1) * materialCoinValuePerAttempt,
    });
  }
  return rows;
}

/**
 * Break-even read on a flat shop price for protect_enhance: at which levels is `priceCoins`
 * cheaper than the material value it protects on ONE failed attempt (its actual payoff — using
 * it does not change future attempts, only whether this one failure costs materials).
 */
export function breakEvenLevels(priceCoins: number): { profitableFromLevel: number | null; rows: ProtectLevelRow[] } {
  const rows = protectValueByLevel();
  const profitable = rows.find((r) => r.materialCoinValuePerAttempt >= priceCoins);
  return { profitableFromLevel: profitable ? profitable.fromLevel : null, rows };
}
