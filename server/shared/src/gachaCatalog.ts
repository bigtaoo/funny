// Gacha item catalogue + ops-authored custom pool model (GACHA_DESIGN §12).
//
// Two distinct concerns live here, both pure data / pure functions (no DB, no PIXI):
//   1. GACHA_CATALOG — the set of items an operator may place in a custom pool, grouped by
//      "category" (item kind: skin / card / equipment / material). Sourced from the existing
//      registries (EQUIPMENT_DEFS, CARD_DEFS) plus the skin/material tables that only exist inline
//      in the pool/shop definitions, so it stays in sync with the rest of the economy.
//   2. CustomPoolConfig — a festival pool whose contents and probabilities are authored entirely in
//      ops. Unlike the derived limited pool (economy.buildLimitedPool), a custom pool has NO pity,
//      NO soft-pity and NO featured-legendary / Fate-Point FOMO. Its draw is a plain two-stage
//      weighted roll: pick a category by weight, then an item within that category by weight.
import type { Rarity } from './types';
import { EQUIPMENT_DEFS, type EquipRarity } from './equipment';
import { CARD_DEFS } from './cards';
import { GACHA_CATEGORY_ORDER, type GachaCategory } from './economy';

// Category (item kind) is the canonical taxonomy shared with the standard-pool two-stage draw
// (economy.GachaCategory, GACHA_DESIGN §2.1a): material / card / equip_t1 / equip_t2 / equip_t3 / skin.
// Custom pools (§12) reuse it so a single category vocabulary spans both pool families.

export interface GachaCatalogItem {
  itemId: string;
  category: GachaCategory;
  /** Display rarity: drives the client card-back tint + odds-popup grouping. See mapping notes below. */
  rarity: Rarity;
  /** Human label for the ops picker (the client localizes by itemId, not this). */
  name: string;
}

// Equipment carries its own EquipRarity (common/fine/rare/epic, no legendary). Two mappings, both matching
// how the standard pool treats the same gear (economy.GACHA_POOLS categories + itemsByRarity):
//   · category tier — fine→equip_t1, rare→equip_t2, epic→equip_t3 (common gear folds into t1).
//   · display rarity — fine→rare, rare→epic, epic→legendary (common→common), so tints match the standard pool.
const EQUIP_RARITY_TO_CATEGORY: Record<EquipRarity, GachaCategory> = {
  common: 'equip_t1',
  fine: 'equip_t1',
  rare: 'equip_t2',
  epic: 'equip_t3',
};
const EQUIP_RARITY_TO_DISPLAY: Record<EquipRarity, Rarity> = {
  common: 'common',
  fine: 'rare',
  rare: 'epic',
  epic: 'legendary',
};

// Skins have no shared registry (enumerated only inline in the pool/shop tables); list the launch
// catalogue here (GACHA_DESIGN §9.5): 3 Anna gacha skins + 3 Tao shop skins.
const SKIN_CATALOG: readonly GachaCatalogItem[] = [
  { itemId: 'skin_e1', category: 'skin', rarity: 'epic', name: 'Lena Skin' },
  { itemId: 'skin_e2', category: 'skin', rarity: 'epic', name: 'Mara Skin' },
  { itemId: 'skin_l1', category: 'skin', rarity: 'legendary', name: 'Max Skin' },
  { itemId: 'skin_shop_c1', category: 'skin', rarity: 'common', name: 'Lichuang Skin' },
  { itemId: 'skin_shop_r1', category: 'skin', rarity: 'rare', name: 'Suyuan Skin' },
  { itemId: 'skin_shop_e1', category: 'skin', rarity: 'epic', name: 'Chenshou Skin' },
];

// Gacha-grantable materials (economy.GACHA_MATERIAL_GRANTS keys; delivery routes mat_* → save.materials).
const MATERIAL_CATALOG: readonly GachaCatalogItem[] = [
  { itemId: 'mat_scrap', category: 'material', rarity: 'common', name: 'Scrap' },
  { itemId: 'mat_lead', category: 'material', rarity: 'rare', name: 'Lead' },
  { itemId: 'mat_binding', category: 'material', rarity: 'epic', name: 'Binding' },
];

function equipmentCatalog(): GachaCatalogItem[] {
  return Object.values(EQUIPMENT_DEFS).map((d) => ({
    itemId: d.defId,
    category: EQUIP_RARITY_TO_CATEGORY[d.rarity],
    rarity: EQUIP_RARITY_TO_DISPLAY[d.rarity],
    name: d.media,
  }));
}

function cardCatalog(): GachaCatalogItem[] {
  // Cards carry no intrinsic display rarity; the standard pool places Anna cards at legendary, Tao at epic.
  return Object.values(CARD_DEFS).map((c) => ({
    itemId: c.id,
    category: 'card' as const,
    rarity: c.faction === 'anna' ? ('legendary' as const) : ('epic' as const),
    name: c.id,
  }));
}

/** Full item catalogue an operator may place in a custom pool. */
export const GACHA_CATALOG: readonly GachaCatalogItem[] = [
  ...SKIN_CATALOG,
  ...cardCatalog(),
  ...equipmentCatalog(),
  ...MATERIAL_CATALOG,
];

const CATALOG_INDEX: ReadonlyMap<string, GachaCatalogItem> = new Map(GACHA_CATALOG.map((i) => [i.itemId, i]));

export function catalogItem(itemId: string): GachaCatalogItem | undefined {
  return CATALOG_INDEX.get(itemId);
}

/**
 * Uniform random pick within one catalogue category (checkin card/equipment milestone draws,
 * RETENTION_DESIGN §2.1). Deliberately simpler than the two-stage weighted custom-pool roll
 * (commercial/gacha.ts rollCustomGacha) — checkin has no ops-authored weights to reuse, and metaserver
 * does not depend on @nw/commercial, so this stays a pure @nw/shared pick over the same catalogue
 * instead of crossing the service boundary. `rng` is injectable for deterministic tests.
 */
export function pickRandomCatalogItem(
  category: GachaCategory,
  rng: (max: number) => number = (max) => Math.floor(Math.random() * max),
): GachaCatalogItem | undefined {
  const pool = GACHA_CATALOG.filter((i) => i.category === category);
  if (!pool.length) return undefined;
  return pool[rng(pool.length)];
}

/** Catalogue grouped by category (all GACHA_CATEGORY_ORDER keys present, possibly empty), for the ops picker. */
export function catalogByCategory(): Record<GachaCategory, GachaCatalogItem[]> {
  const out = Object.fromEntries(GACHA_CATEGORY_ORDER.map((c) => [c, [] as GachaCatalogItem[]])) as Record<
    GachaCategory,
    GachaCatalogItem[]
  >;
  for (const it of GACHA_CATALOG) out[it.category].push(it);
  return out;
}

// ── Custom (ops-authored, free-form) pool model ──────────────────────────────
// Stage 1: pick a category by `CustomPoolCategory.weight`. Stage 2: pick an item within that category
// by `CustomPoolItem.weight`. Weights are relative (not required to sum to any total) — the ops UI shows
// the normalized percentages live, but the authoritative model is raw weights, normalized at roll/display.

export interface CustomPoolItem {
  itemId: string;
  weight: number; // relative weight within its category (> 0)
}

export interface CustomPoolCategory {
  category: GachaCategory;
  weight: number; // relative weight of this category in stage 1 (> 0)
  items: CustomPoolItem[];
}

export interface CustomPoolConfig {
  id: string; // unique pool id; must not shadow a static pool id
  name: string; // banner title
  costSingle: number; // coins per single pull
  costTen?: number; // coins per 10-pull; defaults to costSingle * 10
  startAt: number; // open timestamp (ms)
  endAt: number; // close timestamp (ms)
  categories: CustomPoolCategory[];
}

export function customPoolCostTen(cfg: Pick<CustomPoolConfig, 'costSingle' | 'costTen'>): number {
  return cfg.costTen ?? cfg.costSingle * 10;
}

export function customPoolCost(cfg: Pick<CustomPoolConfig, 'costSingle' | 'costTen'>, count: number): number {
  return count === 10 ? customPoolCostTen(cfg) : cfg.costSingle * count;
}

// Entry weights are emitted at this integer resolution so the meta-side normalization
// (weight / Σweight) reproduces the true per-item probability, including fractional percentages.
const ENTRY_WEIGHT_SCALE = 1_000_000;

/**
 * Expand a custom pool into openapi GachaPool.entries for client display. Each item's probability is
 * P(category) × P(item | category); the emitted `weight` is that probability scaled to an integer so the
 * existing meta normalization (probability = weight / Σweight) yields the exact same probability.
 */
export function customPoolEntries(cfg: CustomPoolConfig): { itemId: string; weight: number; rarity: Rarity }[] {
  const out: { itemId: string; weight: number; rarity: Rarity }[] = [];
  const catTotal = cfg.categories.reduce((s, c) => s + Math.max(0, c.weight), 0);
  if (catTotal <= 0) return out;
  for (const cat of cfg.categories) {
    if (cat.weight <= 0) continue;
    const itemTotal = cat.items.reduce((s, it) => s + Math.max(0, it.weight), 0);
    if (itemTotal <= 0) continue;
    const catShare = cat.weight / catTotal;
    for (const it of cat.items) {
      if (it.weight <= 0) continue;
      const prob = catShare * (it.weight / itemTotal);
      const rarity = catalogItem(it.itemId)?.rarity ?? 'common';
      out.push({ itemId: it.itemId, weight: Math.round(prob * ENTRY_WEIGHT_SCALE), rarity });
    }
  }
  return out;
}

/**
 * Validate an ops-authored custom pool config. Returns null when valid, otherwise a short human-readable
 * reason (surfaced to the operator). Enforces: id shape, non-empty name, positive costs, a valid time
 * window, ≥1 category with a positive weight and ≥1 catalogued item each, and per-item positive weights.
 */
export function validateCustomPool(cfg: {
  id?: string;
  name?: string;
  costSingle?: number;
  costTen?: number;
  startAt?: number;
  endAt?: number;
  categories?: CustomPoolCategory[];
}): string | null {
  if (!cfg.id || !/^[a-z0-9_]+$/i.test(cfg.id)) return 'invalid pool id (use letters, digits, underscore)';
  if (!cfg.name || !cfg.name.trim()) return 'name is required';
  if (!(typeof cfg.costSingle === 'number' && cfg.costSingle > 0)) return 'costSingle must be > 0';
  if (cfg.costTen != null && !(cfg.costTen > 0)) return 'costTen must be > 0';
  if (!(typeof cfg.startAt === 'number' && typeof cfg.endAt === 'number' && cfg.endAt > cfg.startAt))
    return 'endAt must be after startAt';
  const cats = cfg.categories ?? [];
  if (cats.length === 0) return 'at least one category is required';
  const seenCat = new Set<GachaCategory>();
  for (const cat of cats) {
    if (!GACHA_CATEGORY_ORDER.includes(cat.category)) return `unknown category: ${cat.category}`;
    if (seenCat.has(cat.category)) return `duplicate category: ${cat.category}`;
    seenCat.add(cat.category);
    if (!(cat.weight > 0)) return `category ${cat.category}: weight must be > 0`;
    if (!cat.items || cat.items.length === 0) return `category ${cat.category}: needs at least one item`;
    const seenItem = new Set<string>();
    for (const it of cat.items) {
      const meta = catalogItem(it.itemId);
      if (!meta) return `unknown item: ${it.itemId}`;
      if (meta.category !== cat.category) return `item ${it.itemId} is not a ${cat.category}`;
      if (seenItem.has(it.itemId)) return `duplicate item: ${it.itemId}`;
      seenItem.add(it.itemId);
      if (!(it.weight > 0)) return `item ${it.itemId}: weight must be > 0`;
    }
  }
  return null;
}
