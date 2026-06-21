// 盲盒 RNG + 保底单测（S5-3）。注入确定随机源复现：权重映射、大保底命中、十连保底、出货清零。
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

/** 固定返回 0 的随机源 → rollRarity 落第一个权重区间(common)，pickItem 取首个。 */
const zero: RandInt = () => 0;

/** 喂一串预设值的随机源（用尽后回 0）。 */
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
    expect(pityAfter).toBe(1); // common 不清零
  });

  it('大保底：prevPity = threshold-1 的下一抽必出 legendary 且清零', () => {
    const { results, pityAfter } = rollGacha(pool, 1, pool.pityThreshold - 1, zero);
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('权重落点：roll 命中 legendary 区间 → legendary 且 pity 清零', () => {
    // 总权重 1000；common700 rare230 epic60 legendary10。
    // rollRarity 用 rng(total) 后逐段相减，rng 返回 995 落进最后 10 的 legendary 段。
    const { results, pityAfter } = rollGacha(pool, 1, 5, seq([995, 0]));
    expect(results[0]!.rarity).toBe('legendary');
    expect(pityAfter).toBe(0);
  });

  it('十连保底：全程无 epic+（rng=0 全 common）→ 末抽提到 epic', () => {
    const { results } = rollGacha(pool, 10, 0, zero);
    expect(results).toHaveLength(10);
    expect(results.slice(0, 9).every((r) => r.rarity === 'common')).toBe(true);
    expect(results[9]!.rarity).toBe('epic'); // tenFloor
  });

  it('十连已含 epic+ 时不触发保底提升', () => {
    // 第一抽 rng 落 epic 段（roll 960：700→260→30<0 命中 epic），其余 common。
    const { results } = rollGacha(pool, 10, 0, seq([960, 0]));
    expect(results[0]!.rarity).toBe('epic');
    expect(results[9]!.rarity).toBe('common'); // 末抽不被提升
  });
});

// 单位卡池（S12-C）：item = 合法 cardKey，稀有度按 GACHA_RARITY_TO_CARD_LEVEL 映射卡级。
describe('rollGacha 单位卡池', () => {
  const units = findGachaPool(UNIT_CARD_POOL_ID)!;

  it('池内每个 item 都是合法 cardKey，且卡级匹配稀有度映射', () => {
    for (const rarity of ['common', 'rare', 'epic', 'legendary'] as const) {
      const expectLevel = GACHA_RARITY_TO_CARD_LEVEL[rarity]!;
      for (const itemId of units.itemsByRarity[rarity]) {
        const parsed = parseCardKey(itemId);
        expect(parsed).not.toBeNull();
        expect(parsed!.level).toBe(expectLevel);
      }
    }
  });

  it('rng=0 → common 首卡 = infantry:1（T1）', () => {
    const { results } = rollGacha(units, 1, 0, zero);
    expect(results[0]!.rarity).toBe('common');
    expect(parseCardKey(results[0]!.itemId)!.level).toBe(1);
  });

  it('legendary 落点 → T4 卡', () => {
    const { results } = rollGacha(units, 1, units.pityThreshold - 1, zero); // 大保底必出 legendary
    expect(results[0]!.rarity).toBe('legendary');
    expect(parseCardKey(results[0]!.itemId)!.level).toBe(4);
  });
});
