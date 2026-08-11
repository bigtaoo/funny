// Economy config — gacha pools (GACHA_DESIGN §2~4). 2026-08-11 split (independent function modules
// form, see ../economy.ts's header). Depends on rarity.ts (RARITY_ORDER/RARITY_WEIGHTS); zero other
// cross-file dependency within economy/*.
import type { Rarity } from '../types';
import { RARITY_ORDER, RARITY_WEIGHTS } from './rarity';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed-odds draw (GACHA_DESIGN §2.1b, owner decision 2026-07-15; retires the §2.1a two-stage
// category×tier weighted draw below). The standard pool only has 21 items total — few enough that every
// item carries an owner-specified fixed percentage (0..100) directly, with `mat_scrap` absorbing whatever's
// left over (100 − Σ others) as the "remainder pool". The rarity axis is *retained*: each item still carries
// a display rarity (looked up from itemsByRarity) that drives result-card colour and dupe refund — and the
// pity/soft-pity/ten-pull picks now ALSO draw weighted by this same fixed-odds table (restricted to the
// forced rarity tier) instead of uniformly, so the displayed odds equal the true long-run odds regardless of
// pity (see gacha.ts pickItem). Only the standard pool opts in (sets `fixedOdds`/`remainderItemId`); limited
// pools (buildLimitedPool) and the starter pack keep the flat uniform rarity roll.
// ─────────────────────────────────────────────────────────────────────────────

/** Item categories — used by the gacha catalogue/admin tooling grouping (gachaCatalog.ts), independent of the roll mechanism above. */
export type GachaCategory = 'material' | 'card' | 'equip_t1' | 'equip_t2' | 'equip_t3' | 'skin';
export const GACHA_CATEGORY_ORDER: GachaCategory[] = [
  'material',
  'card',
  'equip_t1',
  'equip_t2',
  'equip_t3',
  'skin',
];

/**
 * Standard-pool base-roll odds (owner decision 2026-07-15, GACHA_DESIGN §2.1b). Percent 0..100 per itemId;
 * `mat_scrap` is deliberately absent — it is the remainder pool (see STANDARD_POOL_REMAINDER_ITEM /
 * fixedOddsTable), computed as 100 − Σ(this table) rather than hand-specified. Values below carry over the
 * §2.1a-derived percentages for anything the owner hasn't re-specified yet; max/lena/mara + the three
 * skins were repriced 2026-07-15; skin_e1/skin_e2 repriced again 2026-08-09.
 */
export const STANDARD_POOL_FIXED_ODDS: Record<string, number> = {
  mat_lead: 16.29,
  mat_binding: 4.25,
  lichuang: 4.97,
  chenshou: 4.97,
  suyuan: 4.97,
  max: 0.8,
  lena: 0.8,
  mara: 0.8,
  wp_pen: 3.33,
  ar_cardstock: 3.33,
  tk_bookmark: 3.33,
  wp_marker: 1.0,
  ar_leather: 1.0,
  tk_sticker: 1.0,
  wp_highlighter: 0.27,
  ar_foil: 0.27,
  tk_seal: 0.27,
  skin_e1: 0.05, // Lena skin (epic), repriced 0.10%→0.05% (2026-08-09)
  skin_e2: 0.03, // Mara skin (epic), repriced 0.10%→0.03% (2026-08-09)
  skin_l1: 0.01, // Max skin (legendary, flagship)
};

/** The item that absorbs 100 − Σ(STANDARD_POOL_FIXED_ODDS) — the "remainder pool" (GACHA_DESIGN §2.1b). */
export const STANDARD_POOL_REMAINDER_ITEM = 'mat_scrap';

/**
 * Full odds table for a fixed-odds pool: the explicit entries plus the remainder item filling whatever's
 * left (percent 0..100, summing to ~100). Returns {} for pools that don't opt into fixed odds.
 */
export function fixedOddsTable(pool: GachaPoolDef): Record<string, number> {
  if (!pool.fixedOdds || !pool.remainderItemId) return {};
  const sum = Object.values(pool.fixedOdds).reduce((a, b) => a + b, 0);
  return { ...pool.fixedOdds, [pool.remainderItemId]: Math.max(0, 100 - sum) };
}

export interface GachaPoolDef {
  id: string;
  costSingle: number; // §3.2 single pull cost
  costTen: number; // §3.2 ten-pull cost
  pityThreshold: number; // hard pity: guaranteed legendary after N cumulative pulls (§4.2)
  tenFloor: Rarity; // ten-pull guaranteed minimum rarity (§4.2, at least 1 epic+ per 10 pulls)
  dupePolicy: 'shards' | 'coins'; // openapi top-level compatibility field; per-rarity breakdown see DUPE_*
  itemsByRarity: Record<Rarity, string[]>;
  // ── Fixed-odds draw (GACHA_DESIGN §2.1b). When present, base (non-pity) rolls AND the rarity-conditioned
  //    pity/soft-pity/ten-pull picks all draw from this single explicit odds table (percent 0..100 per
  //    itemId; see fixedOddsTable()). `remainderItemId` absorbs 100 − Σ(fixedOdds) and MUST NOT appear as a
  //    key in fixedOdds itself. Every key (plus remainderItemId) MUST also appear in itemsByRarity (that map
  //    remains the display-rarity / dupe-refund source). Absent → flat uniform rarity roll. ──
  fixedOdds?: Record<string, number>;
  remainderItemId?: string;
  // ── Soft pity (GACHA_DESIGN §3): starting at softPityStart cumulative pulls, legendary probability climbs
  //    each pull by softPityStep until the hard pity guarantees it. Absent = hard-cliff only. ──
  softPityStart?: number; // pity count at which the ramp begins (e.g. 70)
  softPityStep?: number; // probability points added per pull past softPityStart (e.g. 0.05 = +5%/pull)
  // ── Limited pool metadata (GACHA_DESIGN §2.2/§7). Only set on dynamically-built limited pools. ──
  limited?: boolean; // true = time-boxed limited pool (independent pity, FOMO)
  featuredLegendary?: string; // banner legendary itemId; legendary rolls that are NOT this award a Fate Point (§7)
  startAt?: number; // pool open timestamp (ms); enforced by commercial.gachaDraw
  endAt?: number; // pool close timestamp (ms)
}

/** Soft-pity defaults for the standard/limited pools (GACHA_DESIGN §3). */
export const SOFT_PITY_START = 70;
export const SOFT_PITY_STEP = 0.05;

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

// Standard pool; RNG first rolls by rarity tier, then picks uniformly within tier.
// E7: standard pool adds material slots (mat_*, delivery routes to materials) + equipment slots (defId, delivery routes to equipment).
// "Materials primary + equipment as low-chance jackpot" (ADR-017): common materials, rare materials + fine equipment,
// epic/legendary equipment + character cards + the premium Anna skins (DRAFT [adjustable]).
//
// SKIN CATALOGUE (owner decision 2026-07-02, GACHA_DESIGN §9.5): launch ships ONE skin per character (6 total),
// all full-.tao (no procedural recolor — art-direction §9.1 note). The 3 Anna skins are gacha-only premium cosmetics:
//   skin_e1 → Lena skin (epic),  skin_e2 → Mara skin (epic),  skin_l1 → Max skin (legendary, flagship).
// The 3 Tao skins are direct-shop only (see SHOP_ITEMS). Common/rare tiers carry NO skins at launch — skins are a
// premium (epic+) or paid (shop) reward. Extra skins deferred post-launch until their .tao assets are authored.
export const GACHA_POOLS: GachaPoolDef[] = [
  {
    id: 'standard',
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    softPityStart: SOFT_PITY_START,
    softPityStep: SOFT_PITY_STEP,
    dupePolicy: 'coins',
    itemsByRarity: {
      // common: materials only (no skins at launch) → all-material tier
      common: ['mat_scrap', 'mat_scrap', 'mat_scrap'],
      // rare: 2 material slots + 3 fine equipment (no skins at launch)
      rare: ['mat_lead', 'mat_lead', 'wp_pen', 'ar_cardstock', 'tk_bookmark'],
      // epic: 2 Anna skins (Lena/Mara) + 1 material slot + 3 rare equipment + 3 Tao character cards (DRAFT [adjustable] → ECONOMY_NUMBERS §6)
      epic: ['skin_e1', 'skin_e2', 'mat_binding', 'wp_marker', 'ar_leather', 'tk_sticker', 'lichuang', 'chenshou', 'suyuan'],
      // legendary: 1 Anna skin (Max, flagship) + 3 epic equipment + 3 Anna character cards (DRAFT [adjustable] → ECONOMY_NUMBERS §6)
      legendary: ['skin_l1', 'wp_highlighter', 'ar_foil', 'tk_seal', 'max', 'lena', 'mara'],
    },
    // Fixed-odds draw (GACHA_DESIGN §2.1b, owner decision 2026-07-15): every item's exact percentage,
    // mat_scrap absorbing the remainder. See STANDARD_POOL_FIXED_ODDS for the per-item breakdown/history.
    fixedOdds: STANDARD_POOL_FIXED_ODDS,
    remainderItemId: STANDARD_POOL_REMAINDER_ITEM,
  },
  // NOTE: the separate unit-card gacha pool (`units`/UNIT_CARD_POOL_ID, S12-C) was removed on 2026-07-03 — it surfaced as a
  // duplicate second "standard" pool tab in the client. Unit-card progression now comes only from PvE level drops
  // (unitCards.levelCardReward → cardInventory → deriveUnitLevels); character cards are granted from the standard pool above.
];

export function findGachaPool(id: string): GachaPoolDef | undefined {
  return GACHA_POOLS.find((p) => p.id === id);
}

export function gachaCost(pool: GachaPoolDef, count: number): number {
  return count === 10 ? pool.costTen : pool.costSingle * count;
}

/** Reverse index itemId → display rarity, derived from itemsByRarity (the rarity source of truth for
 *  display / dupe refund / pity picks). First tier an item appears in wins (items are unique across tiers). */
export function itemRarityMap(pool: GachaPoolDef): Map<string, Rarity> {
  const m = new Map<string, Rarity>();
  for (const rarity of RARITY_ORDER) {
    for (const id of pool.itemsByRarity[rarity]) if (!m.has(id)) m.set(id, rarity);
  }
  return m;
}

/** Expand into openapi GachaPool.entries (per-item display probability, for the odds panel — Apple 3.1.1).
 *  Fixed-odds pools (standard) reflect the owner-specified percentages verbatim (GACHA_DESIGN §2.1b); flat
 *  pools (limited) keep the old rarity-tier even split. Weights are scaled probabilities (÷ their sum by the
 *  caller = true probability) — and, because pity/soft-pity/ten-pull picks are ALSO weighted by this same
 *  table (gacha.ts pickItem), these displayed odds equal the true long-run odds, not just the base-roll odds. */
export function poolEntries(
  pool: GachaPoolDef,
): { itemId: string; weight: number; rarity: Rarity }[] {
  if (pool.fixedOdds && pool.remainderItemId) return fixedOddsPoolEntries(pool);
  const out: { itemId: string; weight: number; rarity: Rarity }[] = [];
  for (const rarity of RARITY_ORDER) {
    const items = pool.itemsByRarity[rarity];
    if (items.length === 0) continue;
    const perSlot = RARITY_WEIGHTS[rarity] / items.length;
    const byItem = new Map<string, number>();
    for (const itemId of items) byItem.set(itemId, (byItem.get(itemId) ?? 0) + perSlot);
    for (const [itemId, w] of byItem) out.push({ itemId, weight: Math.round(w), rarity });
  }
  return out;
}

/** Odds expansion for a fixed-odds pool: weight = percent × 1000 (0.001%-resolution integers). */
function fixedOddsPoolEntries(
  pool: GachaPoolDef,
): { itemId: string; weight: number; rarity: Rarity }[] {
  const rarityOf = itemRarityMap(pool);
  const table = fixedOddsTable(pool);
  return Object.entries(table).map(([itemId, pct]) => ({
    itemId,
    weight: Math.round(pct * 1000),
    rarity: rarityOf.get(itemId) ?? 'common',
  }));
}
