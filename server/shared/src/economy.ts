// Single source of truth for economy values (ECONOMY_BALANCE.md §2~4). Pure data, no DB / no PIXI.
// meta uses it to list shop items/gacha pools + compute dupe refunds; commercial uses it to run gacha RNG. Same source on both ends avoids drift.
import type { Rarity } from './types';
import type { RankId } from './ladder';
import { UNIT_CARD_POOL_ID, unitCardPoolItems } from './unitCards';

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Standard pool rarity weights (§4.1). */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 700,
  rare: 230,
  epic: 60,
  legendary: 10,
};

export interface GachaPoolDef {
  id: string;
  costSingle: number; // §3.2 single pull cost
  costTen: number; // §3.2 ten-pull cost
  pityThreshold: number; // hard pity: guaranteed legendary after N cumulative pulls (§4.2)
  tenFloor: Rarity; // ten-pull guaranteed minimum rarity (§4.2, at least 1 epic+ per 10 pulls)
  dupePolicy: 'shards' | 'coins'; // openapi top-level compatibility field; per-rarity breakdown see DUPE_*
  itemsByRarity: Record<Rarity, string[]>;
}

/**
 * Gacha material grants (E7 §4): `mat_*` prefix itemId → quantity to credit.
 * Delivery side (metaserver/economy.ts deliverOrder) routes these to save.materials, bypassing skin dupe refunds.
 * Quantities are DRAFT [adjustable]: higher tiers yield rarer materials, but absolute amounts are intentionally low (primary material faucet remains level drops).
 */
export const GACHA_MATERIAL_GRANTS: Record<string, Record<string, number>> = {
  mat_scrap: { scrap: 10 },
  mat_lead: { lead: 3 },
  mat_binding: { binding: 1 },
};

// Placeholder skin pool (real skin content pending art); RNG first rolls by rarity tier, then picks uniformly within tier.
// E7: standard pool adds material slots (mat_*, delivery routes to materials) + equipment slots (defId, delivery routes to equipment).
// "Materials primary + equipment as low-chance jackpot" (ADR-017): common materials 3/7, rare materials 2/8,
// epic/legendary equipment slots ≤ skin slot count, keeping equipment as jackpot (DRAFT [adjustable]).
export const GACHA_POOLS: GachaPoolDef[] = [
  {
    id: 'standard',
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: {
      // common: 4 skins + 3 material slots → material drop rate 43%
      common: ['skin_c1', 'skin_c2', 'skin_c3', 'skin_c4', 'mat_scrap', 'mat_scrap', 'mat_scrap'],
      // rare: 3 skins + 2 material slots + 3 fine equipment → material drop rate 25%, fine equipment 38%
      rare: ['skin_r1', 'skin_r2', 'skin_r3', 'mat_lead', 'mat_lead', 'wp_pen', 'ar_cardstock', 'tk_bookmark'],
      // epic: 2 skins + 1 material slot + 3 rare equipment → equipment jackpot 50%
      epic: ['skin_e1', 'skin_e2', 'mat_binding', 'wp_marker', 'ar_leather', 'tk_sticker'],
      // legendary: 1 skin + 3 epic equipment → equipment jackpot 75% (extremely rare tier, ~2% per pull)
      legendary: ['skin_l1', 'wp_highlighter', 'ar_foil', 'tk_seal'],
    },
  },
  // Unit card pool (S12-C, progression ≠ cosmetics, separate pool): item = cardKey (infantry:1 …), rarity-to-card-level mapping see
  // unitCards.GACHA_RARITY_TO_CARD_LEVEL (common→T1 … legendary→T4). Delivery side by poolId credits unit cards
  // (cardInventory + recalculate unitLevels), **bypasses skin dupe refund** (cards naturally duplicate, all credited).
  // Pricing/pity reuses skin pool placeholder `[adjustable]` (§3.2); dupePolicy is only an openapi top-level compatibility field, not read by unit card delivery.
  {
    id: UNIT_CARD_POOL_ID,
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: unitCardPoolItems(),
  },
];

export interface ShopItemDef {
  id: string;
  cost: number;
  kind: string; // skin | item …
  grants: string; // itemId written into inventory at delivery
  rarity: Rarity;
}

// Direct shop purchase pricing (§3.1, legendary items only available through gacha, not direct sale).
// protect_enhance: enhancement protection item (E7 §6.2), preserves materials on failure without consuming them, consumable for big spenders.
// kind='item' → delivery writes save.inventory.items[grants], not skins (see metaserver/economy.ts deliverOrder).
export const SHOP_ITEMS: ShopItemDef[] = [
  { id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1', rarity: 'common' },
  { id: 'skin_shop_r1', cost: 800, kind: 'skin', grants: 'skin_shop_r1', rarity: 'rare' },
  { id: 'skin_shop_e1', cost: 1800, kind: 'skin', grants: 'skin_shop_e1', rarity: 'epic' },
  { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance', rarity: 'rare' },
];

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

/** Rewarded ads (§2.1). 10 coins per ad (decided 2026-06-27, original 50 was too high; revisit after launch based on performance). */
export const ADS_REWARD_COINS = 10;
export const ADS_DAILY_CAP = 5;
export const ADS_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30min minimum interval between two ads (C2)

/** Rename cost (coins). Deducted once per display-name change (commercial wallet deducts → meta renames). */
export const RENAME_COST = 500;

/** IAP tiers → coins credited (§2.2, hooks like first-purchase double-coins to be layered on later). */
export const IAP_TIERS: Record<string, number> = {
  small: 600,
  mid: 3300,
  large: 11800,
};

/**
 * Tiered per-match victory coins (§2.3b, ongoing faucet). Higher ranks earn more; paired with daily cap to prevent inflation.
 * Awarded only for ranked wins (includes disconnect/surrender judged wins and honest winners determined by peer-judge).
 */
export const VICTORY_COINS_BY_RANK: Record<RankId, number> = {
  bronze: 5,
  silver: 5,
  gold: 5,
  platinum: 8,
  diamond: 8,
  star: 12,
  master: 12,
  grandmaster: 18,
  king: 18,
};

/** Daily win cap for victory coins (wins beyond this still count for ranking/record, no coins awarded, §2.3b). */
export const VICTORY_DAILY_WIN_CAP = 10;

/** Rank → per-match victory coins (unknown rank falls back to minimum tier). */
export function victoryCoinsForRank(rank: string): number {
  return VICTORY_COINS_BY_RANK[rank as RankId] ?? VICTORY_COINS_BY_RANK.bronze;
}

export function findGachaPool(id: string): GachaPoolDef | undefined {
  return GACHA_POOLS.find((p) => p.id === id);
}

export function findShopItem(id: string): ShopItemDef | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

export function gachaCost(pool: GachaPoolDef, count: number): number {
  return count === 10 ? pool.costTen : pool.costSingle * count;
}

/** Expand into openapi GachaPool.entries (for client display, weight evenly distributed within each tier). */
export function poolEntries(
  pool: GachaPoolDef,
): { itemId: string; weight: number; rarity: Rarity }[] {
  const out: { itemId: string; weight: number; rarity: Rarity }[] = [];
  for (const rarity of RARITY_ORDER) {
    const items = pool.itemsByRarity[rarity];
    if (items.length === 0) continue;
    const perItem = Math.round(RARITY_WEIGHTS[rarity] / items.length);
    for (const itemId of items) out.push({ itemId, weight: perItem, rarity });
  }
  return out;
}
