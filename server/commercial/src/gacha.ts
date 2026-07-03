// Gacha RNG + pity system (S5-3, ECONOMY_BALANCE §4). Pure functions with an injected random
// source so unit tests can reproduce pity hits deterministically. Rolls a rarity tier by
// weight first, then picks an item uniformly within that tier. Pity: the hard pity counter
// guarantees a legendary at pityThreshold cumulative pulls; the 10-pull pity floor upgrades
// the last pull to tenFloor when count===10 and no epic+ appeared in the set.
import {
  RARITY_ORDER,
  RARITY_WEIGHTS,
  catalogItem,
  type CustomPoolCategory,
  type CustomPoolConfig,
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

/**
 * Soft-pity legendary probability at a given cumulative pity (GACHA_DESIGN §3).
 * < softPityStart: base rate. ≥ softPityStart: base + step per pull past the start (capped at 1).
 * Returns null when the pool has no soft pity configured (caller falls back to the flat weight table).
 */
export function softPityLegendaryProb(pool: GachaPoolDef, pity: number): number | null {
  if (pool.softPityStart == null || pool.softPityStep == null) return null;
  if (pity < pool.softPityStart) return null;
  const steps = pity - pool.softPityStart + 1;
  const base = RARITY_WEIGHTS.legendary / RARITY_ORDER.reduce((s, r) => s + RARITY_WEIGHTS[r], 0);
  return Math.min(1, base + steps * pool.softPityStep);
}

/**
 * Roll a rarity with an elevated legendary probability `legProb` (soft-pity ramp). The remaining
 * mass (1 - legProb) splits among common/rare/epic by their base weight ratios, so P(legendary)===legProb
 * exactly and legProb=1 guarantees a legendary. Uses a 1000-slot roll to stay on the RandInt(n) contract.
 */
function rollRarityBoosted(rng: RandInt, legProb: number): Rarity {
  const legW = Math.min(1000, Math.max(0, Math.round(legProb * 1000)));
  const rest = 1000 - legW;
  const nonLegTotal = RARITY_WEIGHTS.common + RARITY_WEIGHTS.rare + RARITY_WEIGHTS.epic; // 990
  const commonW = Math.round((rest * RARITY_WEIGHTS.common) / nonLegTotal);
  const rareW = Math.round((rest * RARITY_WEIGHTS.rare) / nonLegTotal);
  const roll = rng(1000);
  if (roll < legW) return 'legendary';
  const r2 = roll - legW;
  if (r2 < commonW) return 'common';
  if (r2 < commonW + rareW) return 'rare';
  return 'epic';
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
      const legProb = softPityLegendaryProb(pool, pity);
      // Soft-pity ramp active → boosted roll; otherwise the flat weight table (unchanged behavior).
      rarity = legProb != null ? rollRarityBoosted(rng, legProb) : rollRarity(rng);
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

// ─────────────────────────────────────────────────────────────────────────────
// Custom (ops-authored) pool roll (GACHA_DESIGN §12). Two-stage weighted pick — a category by weight,
// then an item within it by weight — with NO pity, NO soft-pity and NO featured-legendary / Fate logic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick an index into `weights` proportional to weight. Weights are scaled to integers (1e6 resolution,
 * enough for fractional percentages) so the pick stays on the RandInt(n) integer contract.
 */
function weightedIndex(weights: number[], rng: RandInt): number {
  const scaled = weights.map((w) => Math.max(0, Math.round(w * 1_000_000)));
  const total = scaled.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  let roll = rng(total);
  for (let i = 0; i < scaled.length; i++) {
    roll -= scaled[i]!;
    if (roll < 0) return i;
  }
  return scaled.length - 1;
}

function rollCustomOne(cats: CustomPoolCategory[], rng: RandInt): GachaResultEntry {
  const cat = cats[weightedIndex(cats.map((c) => c.weight), rng)]!;
  const items = cat.items.filter((it) => it.weight > 0);
  const item = items[weightedIndex(items.map((it) => it.weight), rng)]!;
  return { itemId: item.itemId, rarity: catalogItem(item.itemId)?.rarity ?? 'common' };
}

/**
 * Roll `count` pulls on an ops-authored custom pool. Pure probability: each pull independently rolls a
 * category then an item. Categories/items with non-positive weight are ignored. Assumes `cfg` passed
 * validateCustomPool (≥1 usable category), so `cats` is non-empty.
 */
export function rollCustomGacha(
  cfg: CustomPoolConfig,
  count: number,
  rng: RandInt = cryptoRand,
): GachaResultEntry[] {
  const cats = cfg.categories.filter((c) => c.weight > 0 && c.items.some((it) => it.weight > 0));
  const results: GachaResultEntry[] = [];
  for (let i = 0; i < count; i++) results.push(rollCustomOne(cats, rng));
  return results;
}

/**
 * Starter first-draw pack (GACHA_DESIGN §6.1): a `count`-pull on `pool` with a guaranteed `floor`+ result,
 * independent of normal pity (does not read or write the wallet pity counter). Rolls a plain draw, then if
 * no result reaches the floor rarity, upgrades the last pull to a floor-rarity item.
 */
export function rollStarterPack(
  pool: GachaPoolDef,
  count: number,
  floor: Rarity,
  rng: RandInt = cryptoRand,
): GachaResultEntry[] {
  const results: GachaResultEntry[] = [];
  for (let i = 0; i < count; i++) {
    const rarity = rollRarity(rng);
    results.push({ itemId: pickItem(pool, rarity, rng), rarity });
  }
  const floorRank = rarityRank(floor);
  if (!results.some((r) => rarityRank(r.rarity) >= floorRank)) {
    results[results.length - 1] = { itemId: pickItem(pool, floor, rng), rarity: floor };
  }
  return results;
}
