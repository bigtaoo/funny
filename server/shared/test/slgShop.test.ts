// SLG shop price override unit tests (SLG_DESIGN §8/G7): merge semantics + sanitisation + cache degradation,
// mirroring featureFlags.test.ts's structure for the analogous admin-configurable-pricing mechanism.
import { describe, it, expect } from 'vitest';
import {
  SLG_SHOP_ITEMS,
  isSlgShopItemId,
  resolveSlgShopItem,
  sanitizeSlgShopItemOverrideDoc,
  slgShopItemDefault,
  SlgShopPriceCache,
  type SlgShopItemOverrideDoc,
} from '../src/slg/shop';

const ID = 'slg_speedup_1h';

function overrideDoc(partial: Partial<SlgShopItemOverrideDoc>): SlgShopItemOverrideDoc {
  return { _id: ID, updatedAt: 1, updatedBy: 'admin', ...partial };
}

describe('SLG_SHOP_ITEMS catalog', () => {
  it('has exactly 9 items', () => {
    expect(SLG_SHOP_ITEMS.length).toBe(9);
  });
});

describe('isSlgShopItemId', () => {
  it('returns true only for catalog ids', () => {
    expect(isSlgShopItemId(ID)).toBe(true);
    expect(isSlgShopItemId('made_up')).toBe(false);
    expect(isSlgShopItemId(42)).toBe(false);
  });
});

describe('resolveSlgShopItem', () => {
  it('no doc → returns the base item unchanged', () => {
    const base = slgShopItemDefault(ID);
    expect(resolveSlgShopItem(base, null)).toEqual(base);
    expect(resolveSlgShopItem(base, undefined)).toEqual(base);
  });

  it('doc.cost overrides base.cost; effect is left untouched when doc.effect absent', () => {
    const base = slgShopItemDefault(ID);
    const resolved = resolveSlgShopItem(base, overrideDoc({ cost: 999 }));
    expect(resolved.cost).toBe(999);
    expect(resolved.effect).toEqual(base.effect);
  });

  it('doc.effect merges onto base.effect (partial override, other keys retained)', () => {
    const base = slgShopItemDefault(ID);
    const resolved = resolveSlgShopItem(base, overrideDoc({ effect: { duration_sec: 7200 } }));
    expect(resolved.effect.duration_sec).toBe(7200);
    expect(resolved.cost).toBe(base.cost); // cost untouched
  });
});

describe('sanitizeSlgShopItemOverrideDoc', () => {
  it('drops non-catalog ids / non-objects', () => {
    expect(sanitizeSlgShopItemOverrideDoc(null)).toBeNull();
    expect(sanitizeSlgShopItemOverrideDoc({ _id: 'nope' })).toBeNull();
  });

  it('drops non-positive/non-finite cost, keeps a valid positive cost (floored)', () => {
    expect(sanitizeSlgShopItemOverrideDoc({ _id: ID, cost: -5 })!.cost).toBeUndefined();
    expect(sanitizeSlgShopItemOverrideDoc({ _id: ID, cost: 0 })!.cost).toBeUndefined();
    expect(sanitizeSlgShopItemOverrideDoc({ _id: ID, cost: 'nope' })!.cost).toBeUndefined();
    expect(sanitizeSlgShopItemOverrideDoc({ _id: ID, cost: 150.9 })!.cost).toBe(150);
  });

  it('effect: keeps numeric/string values, drops everything else; omits key when empty', () => {
    const d = sanitizeSlgShopItemOverrideDoc({
      _id: ID,
      effect: { duration_sec: 3600, note: 'ok', bogus: { nested: true }, dropped: null },
    });
    expect(d!.effect).toEqual({ duration_sec: 3600, note: 'ok' });

    const empty = sanitizeSlgShopItemOverrideDoc({ _id: ID, effect: { bogus: null } });
    expect(empty!.effect).toBeUndefined();
  });

  it('defaults missing updatedAt/updatedBy tolerantly', () => {
    const d = sanitizeSlgShopItemOverrideDoc({ _id: ID });
    expect(d).toEqual({ _id: ID, updatedAt: 0, updatedBy: '' });
  });
});

describe('SlgShopPriceCache', () => {
  it('cold start (never fetched) → resolveItem/resolveItems fall back to code defaults', () => {
    const cache = new SlgShopPriceCache({ fetchAll: async () => [] });
    expect(cache.hasLoaded).toBe(false);
    expect(cache.resolveItem(ID)).toEqual(slgShopItemDefault(ID));
    expect(cache.resolveItems()).toEqual(SLG_SHOP_ITEMS);
  });

  it('after refresh, resolves the overridden cost; fetch failure retains stale cache', async () => {
    let payload: unknown[] = [{ _id: ID, cost: 500, updatedAt: 1, updatedBy: 'admin' }];
    let fail = false;
    const cache = new SlgShopPriceCache({
      fetchAll: async () => {
        if (fail) throw new Error('admin down');
        return payload;
      },
    });
    await cache.refresh();
    expect(cache.hasLoaded).toBe(true);
    expect(cache.resolveItem(ID).cost).toBe(500);

    // admin is down: stale cache is retained
    fail = true;
    await cache.refresh();
    expect(cache.resolveItem(ID).cost).toBe(500);
  });

  it('resolveItems preserves SLG_SHOP_ITEMS order and only overrides the matching item', async () => {
    const cache = new SlgShopPriceCache({
      fetchAll: async () => [{ _id: ID, cost: 1, updatedAt: 1, updatedBy: 'admin' }],
    });
    await cache.refresh();
    const items = cache.resolveItems();
    expect(items.map((i) => i.id)).toEqual(SLG_SHOP_ITEMS.map((i) => i.id));
    expect(items.find((i) => i.id === ID)!.cost).toBe(1);
    expect(items.find((i) => i.id !== ID)!.cost).toBe(
      SLG_SHOP_ITEMS.find((i) => i.id !== ID)!.cost,
    );
  });
});
