// Single source of truth for economy values (ECONOMY_BALANCE.md §2~4). Pure data, no DB / no PIXI.
// meta uses it to list shop items/gacha pools + compute dupe refunds; commercial uses it to run gacha RNG. Same source on both ends avoids drift.
import type { Rarity } from './types';
import type { RankId } from './ladder';

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Rarity-tier weights (§4.1). Used as the soft-pity boosted-roll rarity split and by limited/starter pools'
 *  flat rarity-tier roll; the standard pool's own base roll uses STANDARD_POOL_FIXED_ODDS instead (§2.1b). */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 700,
  rare: 230,
  epic: 60,
  legendary: 10,
};

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
 * skins were repriced 2026-07-15.
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
  skin_e1: 0.1, // Lena skin (epic)
  skin_e2: 0.1, // Mara skin (epic)
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

export interface ShopItemDef {
  id: string;
  cost: number;
  kind: string; // skin | item …
  grants: string; // itemId written into inventory at delivery
  rarity: Rarity;
}

// Direct shop purchase pricing (§3.1, legendary items only available through gacha, not direct sale).
// The 3 Tao-faction skins (one per Tao character) are shop-only at launch (owner decision 2026-07-02, GACHA_DESIGN §9.5),
// full-.tao like the Anna gacha skins. Tiered pricing retained (300/800/1800). Mapping (skin restyles that unit type):
//   skin_shop_c1 → Infantry / Lichuang (common),  skin_shop_r1 → Archer / Suyuan (rare),  skin_shop_e1 → ShieldBearer / Chenshou (epic).
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
export const ADS_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10min minimum interval between two ads (2026-07-21, was 30min — DailyScene "Ads" tab)

/** Rename cost (coins). Deducted once per display-name change (commercial wallet deducts → meta renames). */
export const RENAME_COST = 500;

/**
 * IAP tiers → coins credited (§2.2 USD, ECONOMY_BALANCE.md §2.2).
 * Keys are tier IDs used in NW_IAP_PRODUCT_MAP / NW_PADDLE_PRICE_IDS.
 * iOS/Android: t099 / t199 also available; web (Paddle) starts at t499.
 */
export const IAP_TIERS: Record<string, number> = {
  t099:  100,
  t199:  210,
  t499:  550,
  t999:  1150,
  t1999: 2400,
  t4999: 6500,
  t9999: 13500,
};

/** Ordered list of tiers for UI display. Omitting `mobileOnly` means the tier is sold everywhere (web + iOS/Android). */
export interface IapTierDef {
  id: string;
  usdCents: number;   // price in cents for display ($4.99 → 499)
  coins: number;      // total coins including bonus
  base: number;       // base coins (without bonus)
  bestValue?: boolean;
  mobileOnly?: boolean;  // true = iOS/Android app stores only, NOT sold on Paddle web (fixed per-txn fee makes small tiers uneconomic)
}

export const IAP_TIERS_LIST: IapTierDef[] = [
  { id: 't099',  usdCents:  99,  base: 100,   coins: 100,   mobileOnly: true },
  { id: 't199',  usdCents: 199,  base: 200,   coins: 210,   mobileOnly: true },
  { id: 't499',  usdCents: 499,  base: 500,   coins: 550   },
  { id: 't999',  usdCents: 999,  base: 1000,  coins: 1150  },
  { id: 't1999', usdCents: 1999, base: 2000,  coins: 2400,  bestValue: true },
  { id: 't4999', usdCents: 4999, base: 5000,  coins: 6500  },
  { id: 't9999', usdCents: 9999, base: 10000, coins: 13500 },
];

/** First-purchase coin multiplier (applied once per account lifetime). */
export const FIRST_PURCHASE_BONUS_MULTIPLIER = 2;

/**
 * Fallback tier for the dev IAP stub when a receipt has no `tier:` prefix
 * (e.g. E2E `topup_<uid>` receipts). Must be a key of IAP_TIERS; the standard
 * web entry tier (t499 = 550 coins, > RENAME_COST) so dev top-ups are useful.
 */
export const DEV_STUB_DEFAULT_TIER = 't499';

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

// ─────────────────────────────────────────────────────────────────────────────
// Limited pool (GACHA_DESIGN §2.2/§7). Config lives in commercial DB (admin-created);
// the pool content is *derived* here (pure) from the standard pool so there is no drift.
// ─────────────────────────────────────────────────────────────────────────────

/** Admin-authored limited-pool config (stored in commercial `gachaPools`). Content derives from the standard pool. */
export interface LimitedPoolConfig {
  id: string; // unique pool id (e.g. 'limited_01'); pity is tracked independently under this id
  name: string; // display name (banner title)
  featuredLegendary: string; // banner legendary itemId (delivered as a skin); off-banner legendary → Fate Point (§7)
  startAt: number; // open timestamp (ms)
  endAt: number; // close timestamp (ms)
  /** Off-banner legendary fillers (default = standard pool's cosmetic/equipment legendaries; excludes character cards). */
  fillerLegendaries?: string[];
}

/** Standard-pool legendary items used as limited-pool off-banner filler (cosmetics + equipment; character cards excluded so limited pools never dilute progression). */
export const DEFAULT_LIMITED_FILLER_LEGENDARIES = ['skin_l1', 'wp_highlighter', 'ar_foil', 'tk_seal'];

/**
 * Build a full GachaPoolDef from a limited-pool config (pure). Common/rare/epic tiers copy the standard pool;
 * the legendary tier is the featured banner (weighted to ~50% via slot repetition) plus off-banner fillers.
 * Hitting an off-banner legendary is the "off-target" pull that awards a Fate Point (commercial.gachaDraw §7).
 */
export function buildLimitedPool(cfg: LimitedPoolConfig): GachaPoolDef {
  const std = GACHA_POOLS[0]!; // standard pool = content template
  const fillers = cfg.fillerLegendaries ?? DEFAULT_LIMITED_FILLER_LEGENDARIES;
  // Featured occupies as many slots as there are fillers → featured ≈ 50% of legendary rolls.
  const featuredSlots = Math.max(1, fillers.length);
  const legendary = [...Array(featuredSlots).fill(cfg.featuredLegendary), ...fillers];
  return {
    id: cfg.id,
    costSingle: std.costSingle,
    costTen: std.costTen,
    pityThreshold: std.pityThreshold,
    tenFloor: std.tenFloor,
    softPityStart: std.softPityStart,
    softPityStep: std.softPityStep,
    dupePolicy: 'coins',
    limited: true,
    featuredLegendary: cfg.featuredLegendary,
    startAt: cfg.startAt,
    endAt: cfg.endAt,
    itemsByRarity: {
      common: std.itemsByRarity.common,
      rare: std.itemsByRarity.rare,
      epic: std.itemsByRarity.epic,
      legendary,
    },
  };
}

/** A limited pool is open when now ∈ [startAt, endAt). */
export function isLimitedPoolActive(cfg: { startAt: number; endAt: number }, now: number): boolean {
  return now >= cfg.startAt && now < cfg.endAt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fate points (GACHA_DESIGN §7) + subscription/starter products (§5/§6).
// ─────────────────────────────────────────────────────────────────────────────

/** Fate points redeemed for one self-chosen past-featured limited legendary (§7.1). */
export const FATE_POINT_REDEEM_COST = 30;

/** Monthly card (§5): 30-day subscription, 120 coins/day, 600 coins granted immediately on purchase. */
export const MONTHLY_CARD_DAYS = 30;
export const MONTHLY_CARD_DAILY_COINS = 120;
export const MONTHLY_CARD_IMMEDIATE_COINS = 600;

/**
 * Year card (§5): 365-day subscription, same 120 coins/day + 600 immediate as the monthly card — only the
 * duration is ×12. The daily claim reuses MONTHLY_CARD_DAILY_COINS (subscription is one field; claim is card-agnostic).
 * Both cards are globally single-slot: buying either is refused while any subscription is still active (buy → use up → rebuy).
 */
export const YEAR_CARD_DAYS = 365;
export const YEAR_CARD_IMMEDIATE_COINS = 600;

/**
 * Display prices only (real IAP charge is treated as already-authorized upstream; no coins are debited here).
 * Year card is a ~10%-off take on 12 monthly cards (12×¥30 = ¥360 → ¥298), surfaced in the shop as a strike-through + savings badge.
 */
export const MONTHLY_CARD_PRICE_YUAN = 30;
export const YEAR_CARD_PRICE_YUAN = 298;
export const YEAR_CARD_LIST_PRICE_YUAN = 360;

/** Starter growth pack (§6.2): 3,300 coins + a 7-day monthly card; buyable once, within the first 7 days of the account. */
export const GROWTH_PACK_COINS = 3300;
export const GROWTH_PACK_CARD_DAYS = 7;
export const GROWTH_PACK_WINDOW_DAYS = 7;

/** Starter first-draw pack (§6.1): a rare+ floored 10-pull, buyable once, independent of normal pity. */
export const STARTER_DRAW_COUNT = 10;
export const STARTER_DRAW_FLOOR: Rarity = 'rare';

/** Product ids for the one-off / subscription IAP-style products (marked in wallet.starterUsed / subscription). */
export const PRODUCT_MONTHLY_CARD = 'monthly_card';
export const PRODUCT_YEAR_CARD = 'year_card';
export const PRODUCT_STARTER_DRAW = 'starter_draw';
export const PRODUCT_STARTER_GROWTH = 'starter_growth';
