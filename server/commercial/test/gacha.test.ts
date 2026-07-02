// Gacha RNG + pity system unit tests (S5-3). Inject deterministic random sources to reproduce: weight mapping, hard pity hit, ten-pull floor, pity counter reset.
import { describe, it, expect } from 'vitest';
import {
  GACHA_POOLS,
  UNIT_CARD_POOL_ID,
  GACHA_RARITY_TO_CARD_LEVEL,
  findGachaPool,
  parseCardKey,
} from '@nw/shared';
import { buildLimitedPool } from '@nw/shared';
import { rollGacha, rollStarterPack, softPityLegendaryProb, type RandInt } from '../src/gacha';

const pool = GACHA_POOLS[0]!; // standard: single 150 / ten 1350 / pity 90 / tenFloor epic, soft pity 70@+5%

/** Random source that always returns 0 → rollRarity lands in the first weight interval (common), pickItem selects the first item. */
const zero: RandInt = () => 0;

/** Random source that feeds a preset sequence of values (returns 0 when exhausted). */
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe('rollGacha', () => {
  it('rng=0 → all common, first item', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, zero);
    expect(results).toHaveLength(1);
    expect(results[0]!.rarity).toBe('common');
    expect(results[0]!.itemId).toBe('mat_scrap'); // common tier is materials-only at launch (no skins; GACHA_DESIGN §9.5)
    expect(pityAfter).toBe(1); // common does not reset pity
  });

  it('hard pity: prevPity = threshold-1, next pull guaranteed legendary and counter reset', () => {
    const { results, pityAfter } = rollGacha(pool, 1, pool.pityThreshold - 1, zero);
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('weight hit point: roll lands in legendary interval → legendary and pity reset', () => {
    // Total weight 1000: common700 rare230 epic60 legendary10.
    // rollRarity calls rng(total) then subtracts segment by segment; rng returning 995 falls in the last 10 (legendary segment).
    const { results, pityAfter } = rollGacha(pool, 1, 5, seq([995, 0]));
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('ten-pull floor: no epic+ throughout (rng=0 all common) → last pull promoted to epic', () => {
    const { results } = rollGacha(pool, 10, 0, zero);
    expect(results).toHaveLength(10);
    expect(results.slice(0, 9).every((r) => r.rarity === 'common')).toBe(true);
    expect(results[9]!.rarity).toBe('epic'); // tenFloor
  });

  it('ten-pull already contains epic+: floor promotion not triggered', () => {
    // First pull rng lands in epic segment (roll 960: 700→260→30<0 hits epic), rest are common.
    const { results } = rollGacha(pool, 10, 0, seq([960, 0]));
    expect(results[0]!.rarity).toBe('epic');
    expect(results[9]!.rarity).toBe('common'); // last pull is not promoted
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

  it('the flat weight table is unchanged below the soft-pity start', () => {
    // pity 5 (< 70): identical to the historical behavior (roll 995 in the legendary segment).
    const { results } = rollGacha(pool, 1, 5, seq([995, 0]));
    expect(results[0]!.rarity).toBe('legendary');
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

  it('a legendary hit that is not the featured banner is a 歪 (off-banner)', () => {
    const p = buildLimitedPool(cfg);
    // Featured occupies half the legendary slots; the fillers are the other half.
    const featuredSlots = p.itemsByRarity.legendary.filter((x) => x === 'skin_limited_01').length;
    expect(featuredSlots).toBeGreaterThanOrEqual(1);
    expect(p.itemsByRarity.legendary.some((x) => x !== 'skin_limited_01')).toBe(true);
  });
});

// Unit card pool (S12-C): item = valid cardKey, rarity mapped to card level via GACHA_RARITY_TO_CARD_LEVEL.
describe('rollGacha unit card pool', () => {
  const units = findGachaPool(UNIT_CARD_POOL_ID)!;

  it('every item in the pool is a valid cardKey, and card level matches rarity mapping', () => {
    for (const rarity of ['common', 'rare', 'epic', 'legendary'] as const) {
      const expectLevel = GACHA_RARITY_TO_CARD_LEVEL[rarity]!;
      for (const itemId of units.itemsByRarity[rarity]) {
        const parsed = parseCardKey(itemId);
        expect(parsed).not.toBeNull();
        expect(parsed!.level).toBe(expectLevel);
      }
    }
  });

  it('rng=0 → first common card = infantry:1 (T1)', () => {
    const { results } = rollGacha(units, 1, 0, zero);
    expect(results[0]!.rarity).toBe('common');
    expect(parseCardKey(results[0]!.itemId)!.level).toBe(1);
  });

  it('legendary hit → T4 card', () => {
    const { results } = rollGacha(units, 1, units.pityThreshold - 1, zero); // hard pity guarantees legendary
    expect(results[0]!.rarity).toBe('legendary');
    expect(parseCardKey(results[0]!.itemId)!.level).toBe(4);
  });
});
