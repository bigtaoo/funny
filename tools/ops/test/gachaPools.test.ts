// src/logic/gachaPools.ts — the draft state helpers (custom festival pool editor, GACHA_DESIGN §12) + the
// active/not-started/ended status classifier. pageGachaPools() itself builds DOM, untested.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  availableItems, canCloseEarly, catPctText, closeConfirm, collectPoolConfig, DEFAULT_COST_SINGLE,
  DEFAULT_POOL_WINDOW_MS, draftFromPool, emptyCatalog, emptyDraft, GACHA_CATEGORY_LABEL,
  GACHA_CATEGORY_ORDER, itemMeta, itemPctText, poolFormValues, poolStatus, poolSummary,
  validatePoolConfig,
} from '../src/logic/gachaPools';
import type { AdminGachaPool, GachaCatalogItem, GachaCategory } from '../src/types';

describe('emptyDraft', () => {
  it('has one entry per gacha category, all disabled with weight 1 and no items', () => {
    const d = emptyDraft();
    expect(Object.keys(d).sort()).toEqual(
      ['card', 'equip_t1', 'equip_t2', 'equip_t3', 'material', 'skin'].sort(),
    );
    for (const cat of Object.values(d)) {
      expect(cat).toEqual({ enabled: false, weight: 1, items: [] });
    }
  });

  it('returns independent item arrays across calls (no shared mutable state)', () => {
    const d1 = emptyDraft();
    d1.material.items.push({ itemId: 'wood', weight: 1 });
    const d2 = emptyDraft();
    expect(d2.material.items).toEqual([]);
  });
});

describe('draftFromPool', () => {
  const basePool: AdminGachaPool = {
    id: 'p1',
    name: 'Festival',
    startAt: 0,
    endAt: 1,
    createdBy: 'admin',
    createdAt: 0,
    categories: [
      { category: 'material', weight: 3, items: [{ itemId: 'wood', weight: 2 }] },
      { category: 'skin', weight: 1, items: [] },
    ],
  };

  it('marks only the pool\'s stored categories as enabled, carrying over their weight/items', () => {
    const d = draftFromPool(basePool);
    expect(d.material).toEqual({ enabled: true, weight: 3, items: [{ itemId: 'wood', weight: 2 }] });
    expect(d.skin).toEqual({ enabled: true, weight: 1, items: [] });
  });

  it('leaves categories absent from the pool disabled at defaults', () => {
    const d = draftFromPool(basePool);
    expect(d.card).toEqual({ enabled: false, weight: 1, items: [] });
    expect(d.equip_t1).toEqual({ enabled: false, weight: 1, items: [] });
  });

  it('deep-copies item arrays instead of aliasing the source pool', () => {
    const d = draftFromPool(basePool);
    d.material.items[0]!.weight = 999;
    expect(basePool.categories![0]!.items[0]!.weight).toBe(2);
  });

  it('handles a pool with no categories field as fully empty/disabled', () => {
    const d = draftFromPool({ ...basePool, categories: undefined });
    expect(d).toEqual(emptyDraft());
  });
});

describe('poolStatus', () => {
  const NOW = new Date(2026, 7, 13, 12, 0).getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is "Not started" before startAt', () => {
    expect(poolStatus({ startAt: NOW + 1000, endAt: NOW + 2000 })).toEqual({ label: 'Not started', cls: 'info' });
  });

  it('is "Active" between startAt and endAt', () => {
    expect(poolStatus({ startAt: NOW - 1000, endAt: NOW + 1000 })).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('is "Ended" once past endAt even without an explicit closedAt', () => {
    expect(poolStatus({ startAt: NOW - 2000, endAt: NOW - 1000 })).toEqual({ label: 'Ended', cls: '' });
  });

  it('is "Ended" when closedAt is set, even if still inside the start/end window', () => {
    expect(poolStatus({ startAt: NOW - 1000, endAt: NOW + 1000, closedAt: NOW - 500 })).toEqual({ label: 'Ended', cls: '' });
  });
});

describe('GACHA_CATEGORY_ORDER / LABEL', () => {
  it('labels every category it orders', () => {
    expect(GACHA_CATEGORY_ORDER.filter((c) => !GACHA_CATEGORY_LABEL[c])).toEqual([]);
  });

  it('splits equipment by tier, which is why there are six categories and not four', () => {
    expect(GACHA_CATEGORY_ORDER.filter((c) => c.startsWith('equip_'))).toEqual(['equip_t1', 'equip_t2', 'equip_t3']);
  });
});

describe('emptyCatalog', () => {
  it('has an empty list per category, so a failed catalogue fetch cannot crash the pickers', () => {
    const c = emptyCatalog();
    expect(Object.keys(c).sort()).toEqual([...GACHA_CATEGORY_ORDER].sort());
    expect(Object.values(c).every((list) => list.length === 0)).toBe(true);
  });
});

describe('weight normalization', () => {
  const draftWith = (): ReturnType<typeof emptyDraft> => {
    const d = emptyDraft();
    d.material = { enabled: true, weight: 3, items: [{ itemId: 'wood', weight: 1 }, { itemId: 'ink', weight: 3 }] };
    d.card = { enabled: true, weight: 1, items: [{ itemId: 'c1', weight: 1 }] };
    d.skin = { enabled: false, weight: 10, items: [{ itemId: 's1', weight: 1 }] };
    return d;
  };

  it('shares each enabled category against the enabled total, ignoring disabled ones', () => {
    const d = draftWith();
    expect(catPctText(d, 'material')).toBe('75.0');
    expect(catPctText(d, 'card')).toBe('25.0');
  });

  it('reads a disabled category as 0% even when it carries a weight', () => {
    expect(catPctText(draftWith(), 'skin')).toBe('0');
  });

  it('reads a category as 0% when every enabled weight is zero', () => {
    const d = emptyDraft();
    d.material = { enabled: true, weight: 0, items: [] };
    expect(catPctText(d, 'material')).toBe('0');
  });

  it('multiplies category share by in-category share for an item overall chance', () => {
    const d = draftWith();
    // material is 75% of pulls; ink is 3 of 4 inside it -> 56.25%
    expect(itemPctText(d, 'material', d.material.items[1]!)).toBe('56.25');
    expect(itemPctText(d, 'material', d.material.items[0]!)).toBe('18.75');
    expect(itemPctText(d, 'card', d.card.items[0]!)).toBe('25.00');
  });

  it('reads an item in a disabled category as 0%', () => {
    const d = draftWith();
    expect(itemPctText(d, 'skin', d.skin.items[0]!)).toBe('0');
  });

  it('reads an item as 0% when every item weight in its category is zero', () => {
    const d = emptyDraft();
    d.material = { enabled: true, weight: 1, items: [{ itemId: 'wood', weight: 0 }] };
    expect(itemPctText(d, 'material', d.material.items[0]!)).toBe('0');
  });
});

describe('availableItems / itemMeta', () => {
  const catalog = {
    ...emptyCatalog(),
    material: [
      { itemId: 'wood', name: 'Wood', rarity: 'common' },
      { itemId: 'ink', name: 'Ink', rarity: 'rare' },
    ] as GachaCatalogItem[],
  } as Record<GachaCategory, GachaCatalogItem[]>;

  it('offers everything catalogued while the draft is empty', () => {
    expect(availableItems(catalog, emptyDraft(), 'material').map((c) => c.itemId)).toEqual(['wood', 'ink']);
  });

  it('hides what the draft already placed, so an item cannot be added twice', () => {
    const d = emptyDraft();
    d.material.items.push({ itemId: 'wood', weight: 1 });
    expect(availableItems(catalog, d, 'material').map((c) => c.itemId)).toEqual(['ink']);
  });

  it('finds a placed item catalogue metadata, and nothing for one the catalogue dropped', () => {
    expect(itemMeta(catalog, 'material', 'ink')).toMatchObject({ name: 'Ink', rarity: 'rare' });
    expect(itemMeta(catalog, 'material', 'retired_item')).toBeUndefined();
  });
});

describe('collectPoolConfig', () => {
  const fields = {
    id: '  festival_2026  ', name: '  Summer  ', costSingle: '150', costTen: '',
    start: '2026-08-13T09:00', end: '2026-08-27T09:00',
  };
  const draftWithOne = (): ReturnType<typeof emptyDraft> => {
    const d = emptyDraft();
    d.material = { enabled: true, weight: 2, items: [{ itemId: 'wood', weight: 1 }] };
    return d;
  };

  it('trims the ids and includes only enabled categories', () => {
    const cfg = collectPoolConfig(draftWithOne(), fields);
    expect(cfg.id).toBe('festival_2026');
    expect(cfg.name).toBe('Summer');
    expect(cfg.categories).toEqual([{ category: 'material', weight: 2, items: [{ itemId: 'wood', weight: 1 }] }]);
  });

  it('omits a blank ten-pull price, letting the roll path charge ten singles', () => {
    expect(collectPoolConfig(draftWithOne(), fields)).not.toHaveProperty('costTen');
    expect(collectPoolConfig(draftWithOne(), { ...fields, costTen: ' 1200 ' }).costTen).toBe(1200);
  });

  it('reads an unparseable single price as 0, which validation then rejects downstream', () => {
    expect(collectPoolConfig(draftWithOne(), { ...fields, costSingle: 'free' }).costSingle).toBe(0);
  });

  it('keeps categories in GACHA_CATEGORY_ORDER, not in the order they were enabled', () => {
    const d = emptyDraft();
    d.skin = { enabled: true, weight: 1, items: [] };
    d.material = { enabled: true, weight: 1, items: [] };
    expect(collectPoolConfig(d, fields).categories.map((c) => c.category)).toEqual(['material', 'skin']);
  });
});

describe('validatePoolConfig', () => {
  const good = {
    id: 'p', name: 'P', costSingle: 150, startAt: 1000, endAt: 2000,
    categories: [{ category: 'material' as GachaCategory, weight: 1, items: [{ itemId: 'wood', weight: 1 }] }],
  };

  it('accepts a complete config', () => {
    expect(validatePoolConfig(good)).toBeNull();
  });

  it('requires both id and name', () => {
    expect(validatePoolConfig({ ...good, id: '' })).toBe('id and name are required');
    expect(validatePoolConfig({ ...good, name: '' })).toBe('id and name are required');
  });

  it('requires the window to be non-empty and forward', () => {
    expect(validatePoolConfig({ ...good, endAt: 1000 })).toBe('end time must be after start time');
    expect(validatePoolConfig({ ...good, endAt: 500 })).toBe('end time must be after start time');
  });

  it('rejects an unparseable date, which arrives as NaN and fails the same comparison', () => {
    expect(validatePoolConfig({ ...good, endAt: Number.NaN })).toBe('end time must be after start time');
  });

  it('requires at least one category', () => {
    expect(validatePoolConfig({ ...good, categories: [] })).toBe('enable at least one category');
  });

  it('names the offending category when one has no items — that would roll nothing at all', () => {
    const cfg = { ...good, categories: [{ category: 'skin' as GachaCategory, weight: 1, items: [] }] };
    expect(validatePoolConfig(cfg)).toBe('category "Skins" needs at least one item');
  });
});

describe('list card', () => {
  const pool = (over: Partial<AdminGachaPool> = {}): AdminGachaPool => ({
    id: 'p1', name: 'Festival', startAt: 0, endAt: 10, createdBy: 'root', createdAt: 0, ...over,
  } as AdminGachaPool);

  it('summarizes categories, items and both prices', () => {
    const p = pool({
      costSingle: 150,
      categories: [
        { category: 'material', weight: 1, items: [{ itemId: 'wood', weight: 1 }, { itemId: 'ink', weight: 1 }] },
        { category: 'skin', weight: 1, items: [{ itemId: 's1', weight: 1 }] },
      ],
    });
    expect(poolSummary(p)).toBe('2 categories · 3 items · single 150 / ten 1500 coins');
  });

  it('derives the ten-pull price as ten singles when none is stored', () => {
    expect(poolSummary(pool({ costSingle: 90 }))).toContain('ten 900 coins');
    expect(poolSummary(pool({ costSingle: 90, costTen: 800 }))).toContain('ten 800 coins');
  });

  it('shows question marks rather than NaN for a pool with no stored price', () => {
    expect(poolSummary(pool())).toBe('0 categories · 0 items · single ? / ten ? coins');
  });

  it('offers Close early only inside an open window', () => {
    expect(canCloseEarly({ endAt: 100 }, 50)).toBe(true);
    expect(canCloseEarly({ endAt: 100 }, 100)).toBe(false);
    expect(canCloseEarly({ endAt: 100, closedAt: 60 }, 50)).toBe(false);
  });

  it('names the pool in the close prompt', () => {
    expect(closeConfirm('Festival')).toBe('Close pool "Festival" now?');
  });
});

describe('poolFormValues', () => {
  it('loads a stored pool back into the form', () => {
    expect(poolFormValues({ id: 'p1', name: 'Festival', costSingle: 200, costTen: 1800 } as AdminGachaPool))
      .toEqual({ name: 'Festival', id: 'p1', costSingle: '200', costTen: '1800' });
  });

  it('leaves the ten-pull field blank when nothing is stored, and falls back to the default single price', () => {
    expect(poolFormValues({ id: 'p1', name: 'F' } as AdminGachaPool))
      .toEqual({ name: 'F', id: 'p1', costSingle: '150', costTen: '' });
  });

  it('starts a new pool at the documented defaults', () => {
    expect(DEFAULT_COST_SINGLE).toBe('150');
    expect(DEFAULT_POOL_WINDOW_MS).toBe(14 * 86400_000);
  });
});
