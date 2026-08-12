// Economy config — direct shop purchase pricing (§3.1, ECONOMY_BALANCE.md) + duplicate-conversion
// refunds (§4.3). 2026-08-11 split (independent function modules form, see ../economy.ts's header).
// Zero cross-file dependency within economy/*.
import type { Rarity } from '../types';

export interface ShopItemDef {
  id: string;
  cost: number;
  kind: string; // skin | item | material …
  grants: string; // itemId (or materialId, for kind='material') written into inventory at delivery
  rarity: Rarity;
  /** Quantity granted per purchase. Only meaningful for kind='material' bundles; skins/items always grant 1. */
  qty?: number;
}

// Direct shop purchase pricing (§3.1, legendary items only available through gacha, not direct sale).
// The 3 Tao-faction skins (one per Tao character) are shop-only at launch (owner decision 2026-07-02, GACHA_DESIGN §9.5),
// full-.tao like the Anna gacha skins. Tiered pricing retained (300/800/1800). Mapping (skin restyles that unit type):
//   skin_shop_c1 → Infantry / Lichuang (common),  skin_shop_r1 → Archer / Suyuan (rare),  skin_shop_e1 → ShieldBearer / Chenshou (epic).
// protect_enhance: enhancement protection item (E7 §6.2), preserves materials on failure without consuming them, consumable for big spenders.
// kind='item' → delivery writes save.inventory.items[grants], not skins (see metaserver/economy.ts deliverOrder).
// mat_buy_*: gold→material exchange (ECONOMY_NUMBERS §6.5, 2026-08-03 owner decision). Priced at ~2× the
// econ-sim coin-eq valuation (DUPE_REFUND_COINS/GACHA_MATERIAL_GRANTS-derived: scrap=1, lead≈16.67 coin-eq) —
// a deliberate markup so this is a "catch-up/convenience" tap, never a cheaper substitute for the
// stamina-gated PvE grind (ADR-022 red line: coin buys convenience, not power/supply). binding is
// deliberately NOT purchasable — the deepest material stays farm/gacha-only, mirroring the
// legendary-skins-are-gacha-only rule (ADR-003). Daily purchase caps live in MATERIAL_SHOP_DAILY_CAP below
// (keyed by this item's id, counts *purchases* not units — e.g. mat_buy_scrap cap=5 → 50 scrap/day).
export const SHOP_ITEMS: ShopItemDef[] = [
  { id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1', rarity: 'common' },
  { id: 'skin_shop_r1', cost: 800, kind: 'skin', grants: 'skin_shop_r1', rarity: 'rare' },
  { id: 'skin_shop_e1', cost: 1800, kind: 'skin', grants: 'skin_shop_e1', rarity: 'epic' },
  { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance', rarity: 'rare' },
  { id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', rarity: 'common', qty: 10 },
  { id: 'mat_buy_lead', cost: 105, kind: 'material', grants: 'lead', rarity: 'rare', qty: 3 },
];

/** Daily purchase cap per material shop item (counts *purchases*, not units — see SHOP_ITEMS comment above). */
export const MATERIAL_SHOP_DAILY_CAP: Record<string, number> = {
  mat_buy_scrap: 5, // ×10 scrap/purchase = 50 scrap/day
  mat_buy_lead: 6, // ×3 lead/purchase = 18 lead/day
};

/**
 * Max `qty` accepted by a single POST /shop/buy call (2026-08-10, closes the "×10 button = 10 sequential
 * round trips" latency bug — the client used to fire `cb.buy()` qty times in a loop under one busy-lock;
 * now it's one request that charges/delivers all `qty` units server-side). Bounded well above the client's
 * BULK_BUY_QTY=10 button so the UI has headroom, but still a hard ceiling against a malformed/adversarial
 * request asking for an absurd quantity in one call.
 */
export const SHOP_BUY_MAX_QTY = 20;

export function findShopItem(id: string): ShopItemDef | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

// Duplicate conversion (§4.3). Original design: common/rare → shards, epic/legendary → coin refund;
// but shards land in client-synced materials, which client PUT overwrites (authority conflict), and
// the shard redemption table is "TBD". S5 unifies to coin refund for now (authoritative wallet,
// idempotent, no sync conflict): common/rare use small placeholder amounts, epic/legendary per §4.3.
// Shard path to be wired up once materials authority is finalized.
export const DUPE_REFUND_COINS: Record<Rarity, number> = {
  common: 10,
  rare: 50,
  epic: 400,
  legendary: 1500,
};
