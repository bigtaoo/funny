// Equipment catalog + numeric functions — client-side mirror (EQUIPMENT_DESIGN §3/§6/§17).
//
// This is the client mirror of the pure-data + numeric-functions portion of server/shared/src/equipment.ts.
// Client webpack only aliases `@nw/engine` (zero dependencies); `@nw/shared` pulls in mongodb/jsonwebtoken,
// which the client cannot import. The catalog / craft cost / enhance success rate / salvage refund data
// needed for UI display is therefore mirrored here.
//
// ⚠️ Field changes must be kept in sync in three places (same discipline as SaveData.ts): this file ↔ server/shared/src/equipment.ts.
//    The server remains the sole authority: the UI uses this data to **preview** costs/rates; actual charges/dice rolls follow the server response.
//    The enhancement multiplier table (ENHANCE_LEVEL_MULTIPLIER / enhanceMultiplier) is imported directly from @nw/engine and is not duplicated here.

import type { EquipSlot, EquipRarity } from './SaveData';

export interface EquipDef {
  defId: string;
  slot: EquipSlot;
  rarity: EquipRarity;
  /** Material skin (stationery type), used for i18n/rendering. */
  media: string;
  /** Crafting recipe (material id → quantity); undefined = not craftable (drop/gacha source only). */
  craftCost?: Record<string, number>;
}

// Catalog (§17.2, 3 slots × 4 rarities = 12 items). Kept in sync with server/shared.
export const EQUIPMENT_DEFS: Record<string, EquipDef> = {
  // weapon
  wp_pencil: { defId: 'wp_pencil', slot: 'weapon', rarity: 'common', media: 'pencil', craftCost: { scrap: 5 } },
  wp_pen: { defId: 'wp_pen', slot: 'weapon', rarity: 'fine', media: 'pen', craftCost: { scrap: 8, lead: 2 } },
  wp_marker: { defId: 'wp_marker', slot: 'weapon', rarity: 'rare', media: 'marker', craftCost: { lead: 6, binding: 2 } },
  wp_highlighter: { defId: 'wp_highlighter', slot: 'weapon', rarity: 'epic', media: 'highlighter' },
  // armor
  ar_draft: { defId: 'ar_draft', slot: 'armor', rarity: 'common', media: 'draft', craftCost: { scrap: 5 } },
  ar_cardstock: { defId: 'ar_cardstock', slot: 'armor', rarity: 'fine', media: 'cardstock', craftCost: { scrap: 8, lead: 2 } },
  ar_leather: { defId: 'ar_leather', slot: 'armor', rarity: 'rare', media: 'leather', craftCost: { lead: 6, binding: 2 } },
  ar_foil: { defId: 'ar_foil', slot: 'armor', rarity: 'epic', media: 'foil' },
  // trinket
  tk_clip: { defId: 'tk_clip', slot: 'trinket', rarity: 'common', media: 'clip', craftCost: { scrap: 5 } },
  tk_bookmark: { defId: 'tk_bookmark', slot: 'trinket', rarity: 'fine', media: 'bookmark', craftCost: { scrap: 8, lead: 2 } },
  tk_sticker: { defId: 'tk_sticker', slot: 'trinket', rarity: 'rare', media: 'sticker', craftCost: { lead: 6, binding: 2 } },
  tk_seal: { defId: 'tk_seal', slot: 'trinket', rarity: 'epic', media: 'seal' },
};

export function getEquipDef(defId: string): EquipDef | undefined {
  return EQUIPMENT_DEFS[defId];
}

const RARITY_ORDER: Record<EquipRarity, number> = { common: 0, fine: 1, rare: 2, epic: 3 };

/** Craftable equipment definitions (those with craftCost), sorted by rarity so the forge grid groups tiers together. */
export function craftableDefs(): EquipDef[] {
  return Object.values(EQUIPMENT_DEFS)
    .filter((d) => d.craftCost)
    .sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
}

/** Enhancement level cap (+0..+9). */
export const EQUIP_MAX_LEVEL = 9;
/** Hard cap on the number of distinct instances in the inventory (ADR-012; raised 300→1000 2026-08-10). */
export const EQUIPMENT_INV_CAP = 1000;
/** Salvage refund ratio / level threshold (§6.3, ADR-012). */
export const SALVAGE_REFUND_RATIO = 0.7;
export const SALVAGE_MAX_LEVEL = 4; // +5 and above cannot be salvaged

/** Epic-rarity gear never salvages regardless of level (ADR-050): high-tier pieces exit via auction/wear only, never destruction. */
export function isSalvageable(rarity: EquipRarity, level: number): boolean {
  return rarity !== 'epic' && level <= SALVAGE_MAX_LEVEL;
}

/**
 * Enhancement success rate (by current level fromLevel): 0→1=90%, 1→2=80% … 8→9=10%.
 * fromLevel ≥ 9 = already max level (returns 0). Same formula as server/shared enhanceSuccessRate.
 */
export function enhanceSuccessRate(fromLevel: number): number {
  if (fromLevel < 0 || fromLevel >= EQUIP_MAX_LEVEL) return 0;
  return (EQUIP_MAX_LEVEL - fromLevel) / 10;
}

/**
 * Enhancement demote chance on failure (mirrors server/shared enhanceDemoteChance, ADR-063):
 * +0~+6 never demote; +7/+8 attempts risk falling back one level on failure. Used for the UI's
 * demote-risk warning line — the server remains authoritative for the actual roll.
 */
export function enhanceDemoteChance(fromLevel: number): number {
  if (fromLevel === 7) return 0.2;
  if (fromLevel === 8) return 0.25;
  return 0;
}

export interface EnhanceCost {
  materials: Record<string, number>;
  coins: number;
}

/** Cost to enhance fromLevel→fromLevel+1 (same formula as server/shared enhanceCost, DRAFT). */
export function enhanceCost(fromLevel: number): EnhanceCost {
  const lv = Math.max(0, Math.min(fromLevel, EQUIP_MAX_LEVEL - 1));
  const materials: Record<string, number> = { scrap: 4 + 2 * lv };
  if (lv >= 3) materials.lead = lv - 2;
  // binding required from +4 (was +6) — keep in sync with server/shared/src/equipment.ts.
  if (lv >= 4) materials.binding = lv - 3;
  return { materials, coins: 40 * (lv + 1) };
}

/** Salvage refund (craft cost × 70% floored; non-craftable items return empty). Same formula as server/shared salvageRefund. */
export function salvageRefund(defId: string): Record<string, number> {
  const def = EQUIPMENT_DEFS[defId];
  if (!def?.craftCost) return {};
  const out: Record<string, number> = {};
  for (const [mat, qty] of Object.entries(def.craftCost)) {
    const r = Math.floor(qty * SALVAGE_REFUND_RATIO);
    if (r > 0) out[mat] = r;
  }
  return out;
}

/** Affix type (self-described by id prefix; see @nw/engine balance/equipment.ts). */
export function affixKind(id: string): 'main' | 'sub' | 'skill' | 'unknown' {
  if (id.startsWith('m_')) return 'main';
  if (id.startsWith('s_')) return 'sub';
  if (id.startsWith('k_')) return 'skill';
  return 'unknown';
}

/** Reforge material cost: target rarity → required material item rarity (same source as server/shared REFORGE_MATERIAL_RARITY). */
export const REFORGE_MATERIAL_RARITY: Partial<Record<EquipRarity, EquipRarity>> = {
  fine: 'common',
  rare: 'fine',
  epic: 'rare',
};

/**
 * Per-reforge coin fee by target rarity — mirrors server/shared/src/equipment.ts REFORGE_COIN_COST
 * (ADR-030). Charged on every reforge attempt on top of the fuel item; unlike enhance/craft, the
 * reforge UI previously had no client-side notion of this cost at all (2026-08-03 fix — reforge
 * used to be the only spend action in EquipmentScene that didn't preview/gate on affordability).
 */
export const REFORGE_COIN_COST: Partial<Record<EquipRarity, number>> = {
  fine: 80,
  rare: 200,
  epic: 500,
};

/** Coin cost to reforge an item of the given rarity (0 if not reforge-eligible). */
export function reforgeCoinCost(rarity: EquipRarity): number {
  return REFORGE_COIN_COST[rarity] ?? 0;
}

/** Protection item id (E7). Stored in save.inventory.items[PROTECT_ENHANCE_ITEM_ID]; value is quantity held. */
export const PROTECT_ENHANCE_ITEM_ID = 'protect_enhance';
