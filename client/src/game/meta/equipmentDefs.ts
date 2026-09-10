// Equipment catalog + numeric functions — client view over the server-authoritative table
// (EQUIPMENT_DESIGN §3/§6/§17).
//
// This file used to be a hand-copied mirror of server/shared/src/equipment.ts. It no longer is:
// `server/shared/src/equipment.ts` has zero imports at all (not even `import type`), so it is
// browser-safe on its own and is aliased as `@nw/shared/equipment` (webpack / tsconfig / every
// vitest config), the same treatment cards.ts already had. The numbers below therefore come from
// the one authoritative table — a value can no longer drift between the two sides because there is
// only one side.
//
// What stays local is only what the server has no use for:
//   · craftableDefs()  — forge grid ordering (presentation)
//   · affixKind()      — affix id prefix → UI bucket
// The server remains the sole authority on outcomes: the UI uses this data to **preview**
// costs/rates; actual charges and dice rolls follow the server response, so the roll helpers
// (rollEnhanceSuccess / rollCraftedAffixes / makeDropInstance …) are deliberately NOT re-exported.
// The enhancement multiplier table (ENHANCE_LEVEL_MULTIPLIER / enhanceMultiplier) comes from
// @nw/engine and is not duplicated here either.

import type { EquipRarity } from './SaveData';
import { EQUIPMENT_DEFS } from '@nw/shared/equipment';

export type { EquipDef, EnhanceCost } from '@nw/shared/equipment';
export {
  /** Catalog (§17.2, 3 slots × 4 rarities = 12 items). */
  EQUIPMENT_DEFS,
  getEquipDef,
  /** Enhancement level cap (+0..+9). */
  EQUIP_MAX_LEVEL,
  /** Hard cap on the number of distinct instances in the inventory (ADR-012; raised 300→1000 2026-08-10). */
  EQUIPMENT_INV_CAP,
  /** Salvage refund ratio / level threshold (§6.3, ADR-012). */
  SALVAGE_REFUND_RATIO,
  SALVAGE_MAX_LEVEL,
  /** Epic-rarity gear never salvages regardless of level (ADR-050). */
  isSalvageable,
  /** Enhancement success rate by current level: 0→1=90%, 1→2=80% … 8→9=10%. */
  enhanceSuccessRate,
  /** Demote chance on a failed attempt (ADR-063): +0~+6 never demote, +7/+8 do. */
  enhanceDemoteChance,
  /** Cost to enhance fromLevel→fromLevel+1. */
  enhanceCost,
  /** Salvage refund (craft cost × 70% floored; non-craftable items return empty). */
  salvageRefund,
  /** Reforge material cost: target rarity → required material item rarity. */
  REFORGE_MATERIAL_RARITY,
  /** Per-reforge coin fee by target rarity (ADR-030), charged on top of the fuel item. */
  REFORGE_COIN_COST,
  /** Coin cost to reforge an item of the given rarity (0 if not reforge-eligible). */
  reforgeCoinCost,
  /** Protection item id (E7). Stored in save.inventory.items[PROTECT_ENHANCE_ITEM_ID]. */
  PROTECT_ENHANCE_ITEM_ID,
} from '@nw/shared/equipment';

import type { EquipDef } from '@nw/shared/equipment';

const RARITY_ORDER: Record<EquipRarity, number> = { common: 0, fine: 1, rare: 2, epic: 3 };

/** Craftable equipment definitions (those with craftCost), sorted by rarity so the forge grid groups tiers together. */
export function craftableDefs(): EquipDef[] {
  return Object.values(EQUIPMENT_DEFS)
    .filter((d) => d.craftCost)
    .sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
}

/** Affix type (self-described by id prefix; see @nw/engine balance/equipment.ts). */
export function affixKind(id: string): 'main' | 'sub' | 'skill' | 'unknown' {
  if (id.startsWith('m_')) return 'main';
  if (id.startsWith('s_')) return 'sub';
  if (id.startsWith('k_')) return 'skill';
  return 'unknown';
}
