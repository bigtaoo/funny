// Gacha RNG + pity system unit tests (S5-3). Inject deterministic random sources to reproduce: weight mapping, hard pity hit, ten-pull floor, pity counter reset.
import { describe, it, expect } from 'vitest';
import { GACHA_POOLS, poolEntries, STANDARD_POOL_FIXED_ODDS } from '@nw/shared';
import { buildLimitedPool } from '@nw/shared';
import { rollGacha, rollStarterPack, softPityLegendaryProb, type RandInt } from '../src/gacha';

const pool = GACHA_POOLS[0]!; // standard: single 150 / ten 1350 / pity 90 / tenFloor epic, soft pity 70@+5%, fixed-odds base roll (§2.1b)

/** Random source that always returns 0 → the first item in whatever weight table is being rolled. */
const zero: RandInt = () => 0;

/** Random source that feeds a preset sequence of values (returns 0 when exhausted). */
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

// Fixed-odds base roll (GACHA_DESIGN §2.1b): a single flat weighted pick across the pool's odds table
// (STANDARD_POOL_FIXED_ODDS + mat_scrap absorbing the remainder), scaled ×1000 into integer cumulative
// buckets by rollGacha/pickItem. These thresholds are derived straight from the odds table so the tests
// stay correct if individual percentages move (only the boundary numbers below would need updating).
describe('fixed-odds base roll', () => {
  it('rng=0 → material category is gone; first table entry (mat_lead, rare) wins the [0, 16290) bucket', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, zero);
    expect(results).toHaveLength(1);
    expect(results[0]!.itemId).toBe('mat_lead');
    expect(results[0]!.rarity).toBe('rare');
    expect(pityAfter).toBe(1); // rare does not reset pity
  });

  it('a roll landing in the remainder bucket picks mat_scrap (common)', () => {
    // mat_scrap's bucket starts once every explicit odds entry is exhausted (Σ others × 1000 = 51860).
    const { results } = rollGacha(pool, 1, 0, seq([99999]));
    expect(results[0]).toEqual({ itemId: 'mat_scrap', rarity: 'common' });
  });

  it('max/lena/mara each occupy an 800-wide bucket (0.8% each, owner decision 2026-07-15)', () => {
    const max = rollGacha(pool, 1, 0, seq([35500]));
    expect(max.results[0]).toEqual({ itemId: 'max', rarity: 'legendary' });
    expect(max.pityAfter).toBe(0); // legendary resets pity

    const lena = rollGacha(pool, 1, 0, seq([36300]));
    expect(lena.results[0]).toEqual({ itemId: 'lena', rarity: 'legendary' });

    const mara = rollGacha(pool, 1, 0, seq([37100]));
    expect(mara.results[0]).toEqual({ itemId: 'mara', rarity: 'legendary' });
  });

  it('skin_l1 (Max skin, flagship legendary) sits in a narrow 10-wide bucket (0.01%)', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, seq([51855]));
    expect(results[0]).toEqual({ itemId: 'skin_l1', rarity: 'legendary' });
    expect(pityAfter).toBe(0);
  });

  it('equip_t3 gear (wp_highlighter) displays as legendary and resets pity', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, seq([50900]));
    expect(results[0]).toEqual({ itemId: 'wp_highlighter', rarity: 'legendary' });
    expect(pityAfter).toBe(0);
  });

  it('a non-legendary hit (wp_pen, rare) does not reset pity', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 5, seq([38000]));
    expect(results[0]).toEqual({ itemId: 'wp_pen', rarity: 'rare' });
    expect(pityAfter).toBe(6);
  });

  it('hard pity: prevPity = threshold-1, next pull guaranteed legendary and counter reset', () => {
    const { results, pityAfter } = rollGacha(pool, 1, pool.pityThreshold - 1, zero);
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('ten-pull floor: no epic+ throughout (rng always in the mat_scrap bucket) → last pull promoted to epic', () => {
    const { results } = rollGacha(pool, 10, 0, seq(Array(10).fill(99999)));
    expect(results).toHaveLength(10);
    expect(results.slice(0, 9).every((r) => r.rarity === 'common')).toBe(true);
    expect(results[9]!.rarity).toBe('epic'); // tenFloor (rarity axis, weighted pick from itemsByRarity.epic)
  });

  it('ten-pull already contains epic+: floor promotion not triggered', () => {
    // First pull rolls 20600 → lands in the lichuang bucket [20540, 25510) (epic). Remaining pulls land in
    // the mat_scrap remainder bucket (common). An epic is already present, so no floor promotion.
    const { results } = rollGacha(pool, 10, 0, seq([20600, ...Array(9).fill(99999)]));
    expect(results[0]!.rarity).toBe('epic');
    expect(results[0]!.itemId).toBe('lichuang');
    expect(results[9]!.rarity).toBe('common'); // last pull is not promoted
  });
});

// Pity-path weighting fix (GACHA_DESIGN §2.1b): before this fix, a hard/soft-pity legendary hit picked
// uniformly from the 7 legendary items (1/7 each), completely ignoring the odds table — so a card set to
// 0.03% base odds actually landed ~5x more often in the long run than displayed. pickItem now weights the
// forced-rarity pick by the SAME fixedOdds table, so these boundaries (within the legendary tier only —
// skin_l1[0,10) wp_highlighter[10,280) ar_foil[280,550) tk_seal[550,820) max[820,1620) lena[1620,2420)
// mara[2420,3220), total 3220) mirror the exact ratios of skin_l1/wp_highlighter/ar_foil/tk_seal/max/lena/mara
// in STANDARD_POOL_FIXED_ODDS (0.01/0.27/0.27/0.27/0.8/0.8/0.8), not a uniform 1/7 split.
describe('pity-path weighting (§2.1b fix: pity is no longer uniform among legendaries)', () => {
  const hardPity = (roll: number) => rollGacha(pool, 1, pool.pityThreshold - 1, seq([roll])).results[0]!;

  it('hard pity respects the odds-table ratio between legendary items, not a uniform 1/7', () => {
    expect(hardPity(0)).toEqual({ itemId: 'skin_l1', rarity: 'legendary' }); // 0.01% → tiny [0,10) bucket
    expect(hardPity(9)).toEqual({ itemId: 'skin_l1', rarity: 'legendary' });
    expect(hardPity(10)).toEqual({ itemId: 'wp_highlighter', rarity: 'legendary' }); // 0.27% → [10,280)
    expect(hardPity(279)).toEqual({ itemId: 'wp_highlighter', rarity: 'legendary' });
    expect(hardPity(280)).toEqual({ itemId: 'ar_foil', rarity: 'legendary' }); // [280,550)
    expect(hardPity(550)).toEqual({ itemId: 'tk_seal', rarity: 'legendary' }); // [550,820)
    expect(hardPity(820)).toEqual({ itemId: 'max', rarity: 'legendary' }); // 0.8% → [820,1620), 80x wider than skin_l1's
    expect(hardPity(1619)).toEqual({ itemId: 'max', rarity: 'legendary' });
    expect(hardPity(1620)).toEqual({ itemId: 'lena', rarity: 'legendary' }); // [1620,2420)
    expect(hardPity(2420)).toEqual({ itemId: 'mara', rarity: 'legendary' }); // [2420,3220)
    expect(hardPity(3219)).toEqual({ itemId: 'mara', rarity: 'legendary' });
  });

  it('ten-pull epic floor promotion respects the odds-table ratio between epic items', () => {
    // 9 base rolls in the mat_scrap bucket (common, no epic+) force the tenFloor promotion on pull 10,
    // which consumes an 11th rng call weighted across itemsByRarity.epic. skin_e1[0,100) skin_e2[100,200)
    // mat_binding[200,4450) wp_marker[4450,5450) ar_leather[5450,6450) tk_sticker[6450,7450)
    // lichuang[7450,12420) chenshou[12420,17390) suyuan[17390,22360).
    const floorItem = (roll: number) =>
      rollGacha(pool, 10, 0, seq([...Array(10).fill(99999), roll])).results[9]!;
    expect(floorItem(50)).toEqual({ itemId: 'skin_e1', rarity: 'epic' });
    expect(floorItem(150)).toEqual({ itemId: 'skin_e2', rarity: 'epic' });
    expect(floorItem(300)).toEqual({ itemId: 'mat_binding', rarity: 'epic' }); // 4.25% → by far the widest epic bucket
    expect(floorItem(8000)).toEqual({ itemId: 'lichuang', rarity: 'epic' });
  });
});

// Odds panel expansion (Apple 3.1.1): fixed-odds percentages must match the owner-specified table exactly,
// mat_scrap absorbs the remainder, and pity/soft-pity picks are weighted by this SAME table (gacha.ts
// pickItem) so the displayed odds equal the true long-run odds, not just the base-roll odds.
describe('poolEntries (fixed odds)', () => {
  it('per-item probabilities match STANDARD_POOL_FIXED_ODDS exactly, and mat_scrap absorbs the rest', () => {
    const entries = poolEntries(pool);
    const total = entries.reduce((s, e) => s + e.weight, 0);
    const prob = (id: string) => entries.find((e) => e.itemId === id)!.weight / total;

    expect(prob('max')).toBeCloseTo(0.008, 4);
    expect(prob('lena')).toBeCloseTo(0.008, 4);
    expect(prob('mara')).toBeCloseTo(0.008, 4);
    expect(prob('skin_e1')).toBeCloseTo(0.001, 4); // Lena skin, repriced 0.50%→0.10% (2026-07-15)
    expect(prob('skin_e2')).toBeCloseTo(0.001, 4); // Mara skin
    expect(prob('skin_l1')).toBeCloseTo(0.0001, 4); // Max skin (flagship), repriced 0.10%→0.01%

    const explicitSum = Object.values(STANDARD_POOL_FIXED_ODDS).reduce((a, b) => a + b, 0);
    expect(prob('mat_scrap')).toBeCloseTo((100 - explicitSum) / 100, 4);

    // Probabilities normalize to 1.
    expect(entries.reduce((s, e) => s + e.weight / total, 0)).toBeCloseTo(1, 5);
  });

  it('legendary share is now ~3.22% (up from the old ~1% target — three 0.8% cards dominate it)', () => {
    const entries = poolEntries(pool);
    const total = entries.reduce((s, e) => s + e.weight, 0);
    const legShare = entries.filter((e) => e.rarity === 'legendary').reduce((s, e) => s + e.weight / total, 0);
    expect(legShare).toBeGreaterThan(0.03);
    expect(legShare).toBeLessThan(0.035);
  });

  it('tags every entry with its rarity', () => {
    const entries = poolEntries(pool);
    for (const e of entries) expect(['common', 'rare', 'epic', 'legendary']).toContain(e.rarity);
  });
});

// Soft pity (GACHA_DESIGN §3): legendary probability ramps from softPityStart to the hard pity.
describe('soft pity', () => {
  it('probability is base below the start, then ramps by step, capped at 1', () => {
    expect(softPityLegendaryProb(pool, 69)).toBeNull(); // below start → flat table
    // At pity 70 (start): base 1% + 1 step (5%) = 6%.
    expect(softPityLegendaryProb(pool, 70)).toBeCloseTo(0.06, 5);
    // At pity 71: base + 2 steps = 11%.
    expect(softPityLegendaryProb(pool, 71)).toBeCloseTo(0.11, 5);
    // Deep into the ramp it saturates at 1.
    expect(softPityLegendaryProb(pool, 89)).toBe(1);
  });

  it('boosted roll: high rng in the soft-pity band still misses legendary at low band', () => {
    // pity ramps to 70 (6% legendary). rng(1000) below legW(≈60) → legendary; above → not.
    const hit = rollGacha(pool, 1, 69, () => 0); // pity 70, roll 0 < legW → legendary
    expect(hit.results[0]!.rarity).toBe('legendary');
    const miss = rollGacha(pool, 1, 69, () => 999); // pity 70, roll 999 → not legendary
    expect(miss.results[0]!.rarity).not.toBe('legendary');
  });

  it('below the soft-pity start the base roll is the fixed-odds draw, not the flat table', () => {
    // pity 5 (< 70): no soft-pity boost → fixed-odds draw. Roll 35500 lands in the max bucket.
    const { results } = rollGacha(pool, 1, 5, seq([35500]));
    expect(results[0]).toEqual({ itemId: 'max', rarity: 'legendary' });
  });
});

// Starter first-draw pack (GACHA_DESIGN §6.1): a rare+ floored 10-pull independent of pity.
describe('rollStarterPack', () => {
  it('rng=0 (all common) → last pull floored to rare', () => {
    const results = rollStarterPack(pool, 10, 'rare', () => 0);
    expect(results).toHaveLength(10);
    expect(results.slice(0, 9).every((r) => r.rarity === 'common')).toBe(true);
    expect(results[9]!.rarity).toBe('rare');
  });

  it('already contains rare+ → no floor promotion', () => {
    const results = rollStarterPack(pool, 10, 'rare', seq([960, 0])); // first pull epic
    expect(results[0]!.rarity).toBe('epic');
    expect(results[9]!.rarity).toBe('common');
  });
});

// Limited pool (GACHA_DESIGN §2.2): built from the standard pool with a featured banner legendary.
// Limited pools do NOT carry fixedOdds/remainderItemId — they keep the flat uniform rarity roll.
describe('buildLimitedPool', () => {
  const cfg = { id: 'limited_01', name: 'Test Banner', featuredLegendary: 'skin_limited_01', startAt: 0, endAt: 100 };

  it('marks the pool limited, carries the featured legendary, copies non-legendary tiers', () => {
    const p = buildLimitedPool(cfg);
    expect(p.limited).toBe(true);
    expect(p.featuredLegendary).toBe('skin_limited_01');
    expect(p.fixedOdds).toBeUndefined();
    expect(p.itemsByRarity.common).toEqual(pool.itemsByRarity.common);
    expect(p.itemsByRarity.legendary).toContain('skin_limited_01');
  });

  it('a legendary hit that is not the featured banner is an off-banner miss', () => {
    const p = buildLimitedPool(cfg);
    // Featured occupies half the legendary slots; the fillers are the other half.
    const featuredSlots = p.itemsByRarity.legendary.filter((x) => x === 'skin_limited_01').length;
    expect(featuredSlots).toBeGreaterThanOrEqual(1);
    expect(p.itemsByRarity.legendary.some((x) => x !== 'skin_limited_01')).toBe(true);
  });
});
