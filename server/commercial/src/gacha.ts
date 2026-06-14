// 盲盒 RNG + 保底（S5-3，ECONOMY_BALANCE §4）。纯函数，注入随机源便于单测复现保底命中。
// 先按稀有度权重滚 tier，再 tier 内均匀挑 item。保底：大保底累计 pityThreshold 必出 legendary；
// 十连保底 count===10 时若全程无 epic+，把最后一抽提到 tenFloor。
import {
  RARITY_ORDER,
  RARITY_WEIGHTS,
  type GachaPoolDef,
  type Rarity,
} from '@nw/shared';
import { randomInt } from 'crypto';
import type { GachaResultEntry } from './db';

/** 随机源：返回 [0, n) 的整数。默认 crypto 真随机；测试可注入确定序列。 */
export type RandInt = (n: number) => number;

const cryptoRand: RandInt = (n) => (n <= 1 ? 0 : randomInt(n));

const rarityRank = (r: Rarity): number => RARITY_ORDER.indexOf(r);

function rollRarity(rng: RandInt): Rarity {
  const total = RARITY_ORDER.reduce((s, r) => s + RARITY_WEIGHTS[r], 0);
  let roll = rng(total);
  for (const r of RARITY_ORDER) {
    roll -= RARITY_WEIGHTS[r];
    if (roll < 0) return r;
  }
  return 'common';
}

function pickItem(pool: GachaPoolDef, rarity: Rarity, rng: RandInt): string {
  const items = pool.itemsByRarity[rarity];
  if (items.length === 0) {
    // 池内该稀有度无物品（理论不该发生）→ 退到 common 首个。
    const fallback = pool.itemsByRarity.common;
    return fallback[0] ?? `${pool.id}_${rarity}`;
  }
  return items[rng(items.length)]!;
}

export interface RollOutcome {
  results: GachaResultEntry[];
  pityAfter: number;
}

/**
 * 滚 count 抽。prevPity = 该池距上次 legendary 的累计抽数。
 * 返回逐抽结果 + 滚完后的新 pity 计数。
 */
export function rollGacha(
  pool: GachaPoolDef,
  count: number,
  prevPity: number,
  rng: RandInt = cryptoRand,
): RollOutcome {
  const results: GachaResultEntry[] = [];
  let pity = prevPity;
  const epicRank = rarityRank('epic');

  for (let i = 0; i < count; i++) {
    pity += 1;
    let rarity: Rarity;
    if (pity >= pool.pityThreshold) {
      rarity = 'legendary'; // 大保底命中
    } else {
      rarity = rollRarity(rng);
    }
    if (rarity === 'legendary') pity = 0; // 出货清零
    results.push({ itemId: pickItem(pool, rarity, rng), rarity });
  }

  // 十连保底：count===10 且全程无 epic+ → 把最后一抽提到 tenFloor。
  if (count === 10 && !results.some((r) => rarityRank(r.rarity) >= epicRank)) {
    const floor = pool.tenFloor;
    const last = results.length - 1;
    results[last] = { itemId: pickItem(pool, floor, rng), rarity: floor };
    if (floor === 'legendary') pity = 0;
  }

  return { results, pityAfter: pity };
}
