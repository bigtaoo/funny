// Pure layer for the custom gacha pool page (GACHA_DESIGN §12; ADR-070 Phase 4e).
//
// The draft is the interesting part: an operator builds a two-level weight tree (category weight, then
// item weight inside it) and the form shows the NORMALIZED probability live, because relative weights
// are unreadable on their own — "3" means nothing until you know the others. Both normalizations plus
// the draft/config round trip live here; pages/gachaPools.ts owns the inputs that mutate the draft.
import type { AdminGachaPool, CustomPoolCategory, GachaCatalogItem, GachaCategory } from '../types';
import { localInputToMs } from './shared';

// Category taxonomy mirrors @nw/shared economy.GachaCategory (§11.2; equipment split by tier).
export const GACHA_CATEGORY_ORDER: GachaCategory[] = ['material', 'card', 'equip_t1', 'equip_t2', 'equip_t3', 'skin'];
export const GACHA_CATEGORY_LABEL: Record<GachaCategory, string> = {
  material: 'Materials',
  card: 'Character Cards',
  equip_t1: 'Equipment T1 (fine)',
  equip_t2: 'Equipment T2 (rare)',
  equip_t3: 'Equipment T3 (epic)',
  skin: 'Skins',
};

/** Default active window for a new pool: two weeks. */
export const DEFAULT_POOL_WINDOW_MS = 14 * 86400_000;
/** Default single-pull price the form starts at. */
export const DEFAULT_COST_SINGLE = '150';

export interface DraftItem {
  itemId: string;
  weight: number;
}
export interface DraftCat {
  enabled: boolean;
  weight: number;
  items: DraftItem[];
}
export type Draft = Record<GachaCategory, DraftCat>;

export function emptyDraft(): Draft {
  return Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, { enabled: false, weight: 1, items: [] as DraftItem[] }]),
  ) as Draft;
}

/** Rebuild a draft from a stored custom pool (for editing). */
export function draftFromPool(pool: AdminGachaPool): Draft {
  const d = emptyDraft();
  for (const cat of pool.categories ?? []) {
    d[cat.category] = { enabled: true, weight: cat.weight, items: cat.items.map((it) => ({ ...it })) };
  }
  return d;
}

/** An empty catalogue, used until the real one loads (and if it never does). */
export function emptyCatalog(): Record<GachaCategory, GachaCatalogItem[]> {
  return Object.fromEntries(
    GACHA_CATEGORY_ORDER.map((c) => [c, [] as GachaCatalogItem[]]),
  ) as Record<GachaCategory, GachaCatalogItem[]>;
}

/**
 * Total weight across enabled categories, which is the denominator of every category percentage. A
 * category with weight ≤ 0 contributes nothing even while enabled — that is how an operator parks a
 * category without deleting its items.
 */
export function enabledCatWeight(draft: Draft): number {
  return GACHA_CATEGORY_ORDER.reduce((s, c) => s + (draft[c].enabled && draft[c].weight > 0 ? draft[c].weight : 0), 0);
}

/** A category's share of all pulls, as the string the form prints (one decimal, or '0'). */
export function catPctText(draft: Draft, cat: GachaCategory): string {
  const dc = draft[cat];
  const total = enabledCatWeight(draft);
  return dc.enabled && total > 0 ? ((dc.weight / total) * 100).toFixed(1) : '0';
}

/**
 * One item's chance across the WHOLE pool (category share × its share inside the category), which is
 * the number an operator actually wants to see — two decimals, since these get small.
 */
export function itemPctText(draft: Draft, cat: GachaCategory, item: DraftItem): string {
  const dc = draft[cat];
  const catTotal = enabledCatWeight(draft);
  const itemTotal = dc.items.reduce((s, it) => s + Math.max(0, it.weight), 0);
  return dc.enabled && catTotal > 0 && itemTotal > 0
    ? (((dc.weight / catTotal) * (item.weight / itemTotal)) * 100).toFixed(2)
    : '0';
}

/** Catalogued items in this category that the draft has not placed yet — the add-item dropdown. */
export function availableItems(
  catalog: Record<GachaCategory, GachaCatalogItem[]>,
  draft: Draft,
  cat: GachaCategory,
): GachaCatalogItem[] {
  const added = new Set(draft[cat].items.map((it) => it.itemId));
  return catalog[cat].filter((c) => !added.has(c.itemId));
}

/** Catalogue metadata for a placed item, if the catalogue still lists it. */
export function itemMeta(
  catalog: Record<GachaCategory, GachaCatalogItem[]>,
  cat: GachaCategory,
  itemId: string,
): GachaCatalogItem | undefined {
  return catalog[cat].find((c) => c.itemId === itemId);
}

export interface PoolConfig {
  id: string;
  name: string;
  costSingle: number;
  costTen?: number;
  startAt: number;
  endAt: number;
  categories: CustomPoolCategory[];
}

/** The POST body: only enabled categories, with their items flattened to {itemId, weight}. */
export function collectPoolConfig(draft: Draft, fields: {
  id: string;
  name: string;
  costSingle: string;
  costTen: string;
  start: string;
  end: string;
}): PoolConfig {
  const costTen = fields.costTen.trim();
  return {
    id: fields.id.trim(),
    name: fields.name.trim(),
    costSingle: Number(fields.costSingle) || 0,
    ...(costTen ? { costTen: Number(costTen) } : {}),
    startAt: localInputToMs(fields.start),
    endAt: localInputToMs(fields.end),
    categories: GACHA_CATEGORY_ORDER.filter((c) => draft[c].enabled).map((c) => ({
      category: c,
      weight: draft[c].weight,
      items: draft[c].items.map((it) => ({ itemId: it.itemId, weight: it.weight })),
    })),
  };
}

/**
 * Light client-side guard (the server re-validates authoritatively). The empty-category check is the
 * one worth having: an enabled category with no items would divide by zero in the operator's own
 * probability readout and roll nothing at all in game.
 */
export function validatePoolConfig(cfg: PoolConfig): string | null {
  if (!cfg.id || !cfg.name) return 'id and name are required';
  if (!(cfg.endAt > cfg.startAt)) return 'end time must be after start time';
  if (cfg.categories.length === 0) return 'enable at least one category';
  for (const c of cfg.categories) {
    if (c.items.length === 0) return `category "${GACHA_CATEGORY_LABEL[c.category]}" needs at least one item`;
  }
  return null;
}

/** Closed early or simply over — both mean the pool no longer rolls, so both read "Ended". */
export function poolStatus(
  pool: { startAt: number; endAt: number; closedAt?: number },
  now: number = Date.now(),
): { label: string; cls: string } {
  if (pool.closedAt || now >= pool.endAt) return { label: 'Ended', cls: '' };
  if (now < pool.startAt) return { label: 'Not started', cls: 'info' };
  return { label: 'Active', cls: 'ok' };
}

/** Nothing to close on a pool that is already closed or already past its window. */
export function canCloseEarly(pool: { endAt: number; closedAt?: number }, now: number = Date.now()): boolean {
  return !pool.closedAt && now < pool.endAt;
}

/**
 * The list card's summary line. `costTen` falls back to ten singles because that is what the roll path
 * charges when no explicit ten-pull price is stored — printing "?" there would misreport a real price.
 */
export function poolSummary(pool: AdminGachaPool): string {
  const cats = pool.categories ?? [];
  const items = cats.reduce((s, c) => s + c.items.length, 0);
  const ten = pool.costTen ?? (pool.costSingle != null ? pool.costSingle * 10 : '?');
  return `${cats.length} categories · ${items} items · single ${pool.costSingle ?? '?'} / ten ${ten} coins`;
}

export function closeConfirm(name: string): string {
  return `Close pool "${name}" now?`;
}

/** Form values for editing an existing pool; `costTen` blank means "keep using ×10". */
export function poolFormValues(pool: AdminGachaPool): {
  name: string;
  id: string;
  costSingle: string;
  costTen: string;
} {
  return {
    name: pool.name,
    id: pool.id,
    costSingle: String(pool.costSingle ?? 150),
    costTen: pool.costTen != null ? String(pool.costTen) : '',
  };
}
