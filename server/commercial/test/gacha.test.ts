// Gacha RNG + pity system unit tests (S5-3). Inject deterministic random sources to reproduce: weight mapping, hard pity hit, ten-pull floor, pity counter reset.
import { describe, it, expect } from 'vitest';
import {
  GACHA_POOLS,
  UNIT_CARD_POOL_ID,
  GACHA_RARITY_TO_CARD_LEVEL,
  findGachaPool,
  parseCardKey,
} from '@nw/shared';
import { rollGacha, type RandInt } from '../src/gacha';

const pool = GACHA_POOLS[0]!; // standard：single 150 / ten 1350 / pity 90 / tenFloor epic

/** Random source that always returns 0 → rollRarity lands in the first weight interval (common), pickItem selects the first item. */
const zero: RandInt = () => 0;

/** Random source that feeds a preset sequence of values (returns 0 when exhausted). */
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe('rollGacha', () => {
  it('rng=0 → 全 common 首件', () => {
    const { results, pityAfter } = rollGacha(pool, 1, 0, zero);
    expect(results).toHaveLength(1);
    expect(results[0]!.rarity).toBe('common');
    expect(results[0]!.itemId).toBe('skin_c1');
    expect(pityAfter).toBe(1); // common does not reset pity
  });

  it('大保底：prevPity = threshold-1 的下一抽必出 legendary 且清零', () => {
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
