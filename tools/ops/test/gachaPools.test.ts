// gachaPools.ts's draft state helpers (custom festival pool editor, GACHA_DESIGN §12) + the
// active/not-started/ended status classifier. pageGachaPools() itself builds DOM, untested.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emptyDraft, draftFromPool, poolStatus } from '../src/pages/gachaPools';
import type { AdminGachaPool } from '../src/types';

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
