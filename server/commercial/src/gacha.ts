// Gacha RNG + pity system (S5-3, ECONOMY_BALANCE §4). Pure functions with an injected random
// source so unit tests can reproduce pity hits deterministically. Rolls a rarity tier by
// weight first, then picks an item uniformly within that tier. Pity: the hard pity counter
// guarantees a legendary at pityThreshold cumulative pulls; the 10-pull pity floor upgrades
// the last pull to tenFloor when count===10 and no epic+ appeared in the set.
import {
  RARITY_ORDER,
  RARITY_WEIGHTS,
  type GachaPoolDef,
  type Rarity,
} from '@nw/shared';
import { randomInt } from 'crypto';
import type { GachaResultEntry } from './db';

/** Random source: returns an integer in [0, n). Defaults to crypto true-random; tests can inject a deterministic sequence. */
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
    // No items of this rarity in the pool (should not happen in theory) → fall back to the first common item.
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
 * Roll count pulls. prevPity = cumulative pulls since the last legendary in this pool.
 * Returns the per-pull results and the updated pity counter after the rolls.
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
      rarity = 'legendary'; // hard pity triggered
    } else {
      rarity = rollRarity(rng);
    }
    if (rarity === 'legendary') pity = 0; // reset pity on legendary
    results.push({ itemId: pickItem(pool, rarity, rng), rarity });
  }

  // 10-pull pity floor: count===10 and no epic+ in the set → upgrade the last pull to tenFloor.
  if (count === 10 && !results.some((r) => rarityRank(r.rarity) >= epicRank)) {
    const floor = pool.tenFloor;
    const last = results.length - 1;
    results[last] = { itemId: pickItem(pool, floor, rng), rarity: floor };
    if (floor === 'legendary') pity = 0;
  }

  return { results, pityAfter: pity };
}
