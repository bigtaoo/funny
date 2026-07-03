// Unit tests for gachaCatalog.ts: catalogue integrity, custom-pool cost math, entry probability
// expansion, and config validation (GACHA_DESIGN §12). Pure data + pure functions.
import { describe, it, expect } from 'vitest';
import {
  GACHA_CATALOG,
  GACHA_CATEGORIES,
  catalogItem,
  catalogByCategory,
  customPoolCost,
  customPoolCostTen,
  customPoolEntries,
  validateCustomPool,
  type CustomPoolConfig,
} from '../src/gachaCatalog';

const baseCfg: CustomPoolConfig = {
  id: 'festival_test',
  name: 'Test Festival',
  costSingle: 200,
  startAt: 1000,
  endAt: 2000,
  categories: [
    { category: 'skin', weight: 30, items: [{ itemId: 'skin_l1', weight: 1 }] },
    {
      category: 'material',
      weight: 70,
      items: [
        { itemId: 'mat_scrap', weight: 3 },
        { itemId: 'mat_lead', weight: 1 },
      ],
    },
  ],
};

// ── Catalogue integrity ───────────────────────────────────────────────────────
describe('GACHA_CATALOG', () => {
  it('every item has a known category and a rarity', () => {
    for (const it of GACHA_CATALOG) {
      expect(GACHA_CATEGORIES).toContain(it.category);
      expect(['common', 'rare', 'epic', 'legendary']).toContain(it.rarity);
      expect(it.itemId).toBeTruthy();
    }
  });

  it('itemIds are unique', () => {
    const ids = GACHA_CATALOG.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sources equipment + cards from their registries', () => {
    expect(catalogItem('wp_pen')?.category).toBe('equipment');
    expect(catalogItem('max')?.category).toBe('card');
    expect(catalogItem('max')?.rarity).toBe('legendary'); // Anna card → legendary tint
    expect(catalogItem('lichuang')?.rarity).toBe('epic'); // Tao card → epic tint
    expect(catalogItem('wp_pen')?.rarity).toBe('rare'); // fine equipment → rare display
  });

  it('catalogByCategory partitions the catalogue with no loss', () => {
    const grouped = catalogByCategory();
    const total = GACHA_CATEGORIES.reduce((s, c) => s + grouped[c].length, 0);
    expect(total).toBe(GACHA_CATALOG.length);
  });
});

// ── Cost math ────────────────────────────────────────────────────────────────
describe('customPoolCost', () => {
  it('single pull = costSingle × count', () => {
    expect(customPoolCost(baseCfg, 1)).toBe(200);
  });
  it('ten-pull defaults to costSingle × 10', () => {
    expect(customPoolCostTen(baseCfg)).toBe(2000);
    expect(customPoolCost(baseCfg, 10)).toBe(2000);
  });
  it('explicit costTen overrides the default', () => {
    expect(customPoolCost({ ...baseCfg, costTen: 1800 }, 10)).toBe(1800);
  });
});

// ── Entry probability expansion ────────────────────────────────────────────────
describe('customPoolEntries', () => {
  it('probability = P(category) × P(item | category)', () => {
    const entries = customPoolEntries(baseCfg);
    const total = entries.reduce((s, e) => s + e.weight, 0);
    const prob = (id: string) => {
      const e = entries.find((x) => x.itemId === id)!;
      return e.weight / total;
    };
    // skin: cat 30/100, single item → 0.30
    expect(prob('skin_l1')).toBeCloseTo(0.3, 5);
    // material: cat 70/100, items 3:1 → scrap 0.70*0.75=0.525, lead 0.70*0.25=0.175
    expect(prob('mat_scrap')).toBeCloseTo(0.525, 4);
    expect(prob('mat_lead')).toBeCloseTo(0.175, 4);
  });

  it('carries the display rarity from the catalogue', () => {
    const entries = customPoolEntries(baseCfg);
    expect(entries.find((e) => e.itemId === 'skin_l1')?.rarity).toBe('legendary');
    expect(entries.find((e) => e.itemId === 'mat_scrap')?.rarity).toBe('common');
  });

  it('skips zero/negative-weight categories and items', () => {
    const cfg: CustomPoolConfig = {
      ...baseCfg,
      categories: [
        { category: 'skin', weight: 0, items: [{ itemId: 'skin_l1', weight: 1 }] },
        { category: 'material', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }, { itemId: 'mat_lead', weight: 0 }] },
      ],
    };
    const entries = customPoolEntries(cfg);
    expect(entries.map((e) => e.itemId)).toEqual(['mat_scrap']);
  });
});

// ── Validation ─────────────────────────────────────────────────────────────────
describe('validateCustomPool', () => {
  it('accepts a well-formed config', () => {
    expect(validateCustomPool(baseCfg)).toBeNull();
  });
  it('rejects a bad id', () => {
    expect(validateCustomPool({ ...baseCfg, id: 'bad id!' })).toMatch(/id/);
  });
  it('rejects endAt <= startAt', () => {
    expect(validateCustomPool({ ...baseCfg, endAt: 1000 })).toMatch(/endAt/);
  });
  it('rejects non-positive cost', () => {
    expect(validateCustomPool({ ...baseCfg, costSingle: 0 })).toMatch(/costSingle/);
  });
  it('rejects an empty category list', () => {
    expect(validateCustomPool({ ...baseCfg, categories: [] })).toMatch(/category/);
  });
  it('rejects an unknown item', () => {
    expect(
      validateCustomPool({ ...baseCfg, categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'nope', weight: 1 }] }] }),
    ).toMatch(/unknown item/);
  });
  it('rejects an item placed under the wrong category', () => {
    expect(
      validateCustomPool({ ...baseCfg, categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }] }),
    ).toMatch(/not a skin/);
  });
  it('rejects a duplicate category', () => {
    expect(
      validateCustomPool({
        ...baseCfg,
        categories: [
          { category: 'skin', weight: 1, items: [{ itemId: 'skin_l1', weight: 1 }] },
          { category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] },
        ],
      }),
    ).toMatch(/duplicate category/);
  });
});
