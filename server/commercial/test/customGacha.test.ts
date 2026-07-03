// Unit tests for rollCustomGacha (GACHA_DESIGN §12): deterministic two-stage weighted roll,
// no pity/no fate. Inject a preset random sequence to pin category → item selection.
import { describe, it, expect } from 'vitest';
import type { CustomPoolConfig } from '@nw/shared';
import { rollCustomGacha, type RandInt } from '../src/gacha';

const cfg: CustomPoolConfig = {
  id: 'festival_test',
  name: 'Test',
  costSingle: 200,
  startAt: 0,
  endAt: 10,
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

const zero: RandInt = () => 0;
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe('rollCustomGacha', () => {
  it('rng=0 → first category, first item (with its catalogue rarity)', () => {
    const results = rollCustomGacha(cfg, 1, zero);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ itemId: 'skin_l1', rarity: 'legendary' });
  });

  it('honors category then item weights (2 rng calls per pull)', () => {
    // First pull: category roll 30e6 → lands in material (skin segment is [0,30e6)); item roll 3e6 → lands in lead.
    // Second pull: category roll 30e6 → material; item roll 0 → scrap.
    const results = rollCustomGacha(cfg, 2, seq([30_000_000, 3_000_000, 30_000_000, 0]));
    expect(results[0]).toEqual({ itemId: 'mat_lead', rarity: 'rare' });
    expect(results[1]).toEqual({ itemId: 'mat_scrap', rarity: 'common' });
  });

  it('produces exactly count results, all drawn from the pool', () => {
    const results = rollCustomGacha(cfg, 10);
    expect(results).toHaveLength(10);
    const ids = new Set(['skin_l1', 'mat_scrap', 'mat_lead']);
    for (const r of results) expect(ids.has(r.itemId)).toBe(true);
  });

  it('rough distribution matches configured weights over many pulls', () => {
    // Deterministic RNG cycling category rolls across the [0,100e6) space uniformly-ish is complex;
    // instead assert the skin (30%) vs material (70%) split direction with a coarse crypto-random sample.
    const results = rollCustomGacha(cfg, 4000);
    const skins = results.filter((r) => r.itemId === 'skin_l1').length;
    // 30% expected ⇒ well within [20%, 40%] for n=4000.
    expect(skins / results.length).toBeGreaterThan(0.2);
    expect(skins / results.length).toBeLessThan(0.4);
  });
});
