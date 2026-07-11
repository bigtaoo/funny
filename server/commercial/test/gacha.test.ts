// Gacha RNG + pity system unit tests (S5-3). Inject deterministic random sources to reproduce: weight mapping, hard pity hit, ten-pull floor, pity counter reset.
import { describe, it, expect } from 'vitest';
import { GACHA_POOLS, poolEntries } from '@nw/shared';
import { buildLimitedPool } from '@nw/shared';
import { rollGacha, rollStarterPack, softPityLegendaryProb, type RandInt } from '../src/gacha';

const pool = GACHA_POOLS[0]!; // standard: single 150 / ten 1350 / pity 90 / tenFloor epic, soft pity 70@+5%, two-stage categories

/** Random source that always returns 0 → category 'material', first item (mat_scrap, common). */
const zero: RandInt = () => 0;

/** Random source that feeds a preset sequence of values (returns 0 when exhausted). */
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe('rollGacha', () => {
  it('rng=0 → material category, first item (mat_scrap, common)', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, zero);
    expect(results).toHaveLength(1);
    expect(results[0]!.rarity).toBe('common');
    expect(results[0]!.itemId).toBe('mat_scrap'); // category material, rarity-weighted → scrap (common) first
    expect(pityAfter).toBe(1); // common does not reset pity
  });

  it('hard pity: prevPity = threshold-1, next pull guaranteed legendary and counter reset', () => {
    const { results, pityAfter } = rollGacha(pool, 1, pool.pityThreshold - 1, zero);
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('ten-pull floor: no epic+ throughout (rng=0 all common material) → last pull promoted to epic', () => {
    const { results } = rollGacha(pool, 10, 0, zero);
    expect(results).toHaveLength(10);
    expect(results.slice(0, 9).every((r) => r.rarity === 'common')).toBe(true);
    expect(results[9]!.rarity).toBe('epic'); // tenFloor (rarity axis, picks from itemsByRarity.epic)
  });

  it('ten-pull already contains epic+: floor promotion not triggered', () => {
    // First pull: category roll 990 lands in the skin segment [989,1000); within-skin roll 0 → skin_e1 (epic).
    // Remaining pulls rng=0 → material/common. An epic is already present, so no floor promotion.
    const { results } = rollGacha(pool, 10, 0, seq([990, 0]));
    expect(results[0]!.rarity).toBe('epic');
    expect(results[0]!.itemId).toBe('skin_e1');
    expect(results[9]!.rarity).toBe('common'); // last pull is not promoted
  });
});

// Two-stage base roll (GACHA_DESIGN §2.1a): category picked by CATEGORY_WEIGHTS (sum 1000), then an item within it
// weighted by display rarity. Category segments: material[0,701) card[701,851) equip_t1[851,951) equip_t2[951,981) equip_t3[981,989) skin[989,1000).
describe('two-stage base roll', () => {
  it('category roll picks the skin bucket, then the within-skin tier ladder', () => {
    // Category roll 990 → skin. Within-skin weights [skin_e1:5, skin_e2:5, skin_l1:1] (SKIN_TIER_WEIGHTS), total 11.
    // Within roll 0 → skin_e1 (epic); roll 10 → skin_l1 (legendary, and pity resets).
    const epicSkin = rollGacha(pool, 1, 0, seq([990, 0]));
    expect(epicSkin.results[0]).toEqual({ itemId: 'skin_e1', rarity: 'epic' });
    expect(epicSkin.pityAfter).toBe(1); // epic does not reset pity

    const legSkin = rollGacha(pool, 1, 0, seq([990, 10]));
    expect(legSkin.results[0]).toEqual({ itemId: 'skin_l1', rarity: 'legendary' });
    expect(legSkin.pityAfter).toBe(0); // legendary skin resets pity
  });

  it('a legendary character card from the card category resets pity', () => {
    // Category roll 800 → card [701,851). Within-card weights [lichuang/chenshou/suyuan:150(epic), max/lena/mara:1(legendary)]
    // (CARD_TIER_WEIGHTS, legendary down-weighted 150:1), total 453. Within roll 450 → index 3 (max, legendary).
    const { results, pityAfter } = rollGacha(pool, 1, 5, seq([800, 450]));
    expect(results[0]).toEqual({ itemId: 'max', rarity: 'legendary' });
    expect(pityAfter).toBe(0);
  });

  it('equipment tiers map to gear rarities (t1=fine→rare display, t3=epic→legendary display)', () => {
    // t1 [851,951): first fine weapon wp_pen, displayed as rare.
    const t1 = rollGacha(pool, 1, 0, seq([851, 0]));
    expect(t1.results[0]).toEqual({ itemId: 'wp_pen', rarity: 'rare' });
    // t3 [981,989): first epic gear wp_highlighter, displayed as legendary → resets pity.
    const t3 = rollGacha(pool, 1, 0, seq([981, 0]));
    expect(t3.results[0]).toEqual({ itemId: 'wp_highlighter', rarity: 'legendary' });
    expect(t3.pityAfter).toBe(0);
  });
});

// Odds panel expansion (Apple 3.1.1): two-stage per-item probabilities must sum to ~1 and carry display rarity.
describe('poolEntries (two-stage)', () => {
  it('per-item probabilities sum to 1 and match the two-stage math', () => {
    const entries = poolEntries(pool);
    const total = entries.reduce((s, e) => s + e.weight, 0);
    // skin_l1 = P(skin 11/1000) · P(l1 | skin = 1/11) = 1/1000 ; the flagship legendary skin is ~0.10%.
    const l1 = entries.find((e) => e.itemId === 'skin_l1')!;
    expect(l1.rarity).toBe('legendary');
    expect(l1.weight / total).toBeCloseTo((11 / 1000) * (1 / 11), 4);
    // mat_scrap = P(material 701/1000) · P(scrap | material = 700/990) ≈ 49.6%.
    const scrap = entries.find((e) => e.itemId === 'mat_scrap')!;
    expect(scrap.weight / total).toBeCloseTo((701 / 1000) * (700 / 990), 3);
    // Effective legendary rate is tuned to ~1%.
    const legShare = entries.filter((e) => e.rarity === 'legendary').reduce((s, e) => s + e.weight / total, 0);
    expect(legShare).toBeGreaterThan(0.009);
    expect(legShare).toBeLessThan(0.011);
    // Probabilities normalize to 1.
    expect(entries.reduce((s, e) => s + e.weight / total, 0)).toBeCloseTo(1, 5);
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

  it('below the soft-pity start the base roll is the two-stage category draw, not the flat table', () => {
    // pity 5 (< 70): no soft-pity boost → category roll. Category 800 → card, within 450 → max (legendary card).
    const { results } = rollGacha(pool, 1, 5, seq([800, 450]));
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
describe('buildLimitedPool', () => {
  const cfg = { id: 'limited_01', name: 'Test Banner', featuredLegendary: 'skin_limited_01', startAt: 0, endAt: 100 };

  it('marks the pool limited, carries the featured legendary, copies non-legendary tiers', () => {
    const p = buildLimitedPool(cfg);
    expect(p.limited).toBe(true);
    expect(p.featuredLegendary).toBe('skin_limited_01');
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
