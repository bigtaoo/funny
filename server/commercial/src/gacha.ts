// Gacha RNG + pity system (S5-3, ECONOMY_BALANCE §4). Pure functions with an injected random
// source so unit tests can reproduce pity hits deterministically.
//
// Base (non-pity) rolls: fixed-odds on pools that declare `fixedOdds`/`remainderItemId` (standard,
// GACHA_DESIGN §2.1b) — a single flat weighted pick across every item in the pool's odds table. Pools
// without fixed odds (limited, starter) keep the flat rarity-tier-then-uniform roll.
// Pity is rarity-based: the hard pity counter guarantees a legendary at pityThreshold cumulative pulls;
// the soft-pity ramp raises legendary probability; the 10-pull pity floor upgrades the last pull to
// tenFloor when count===10 and no epic+ appeared in the set. All three then pick a specific item from
// itemsByRarity — weighted by the pool's fixedOdds table when present (§2.1b: this keeps the displayed
// odds equal to the true long-run odds even though pity forces extra legendaries), else uniformly.
import {
  RARITY_ORDER,
  RARITY_WEIGHTS,
  fixedOddsTable,
  itemRarityMap,
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

/**
 * Pick a specific item of the given (already-decided) rarity. When the pool declares fixed odds
 * (GACHA_DESIGN §2.1b), the pick is weighted by each item's share of the odds table (deduped — some
 * itemsByRarity lists carry intentional duplicate slots for the *uniform* fallback below, which would
 * double-count if left in) so that pity/soft-pity/ten-pull-floor picks match the same relative odds as
 * the base roll instead of being uniform. Otherwise (limited pools, starter pack) falls back to uniform.
 */
function pickItem(pool: GachaPoolDef, rarity: Rarity, rng: RandInt): string {
  const items = pool.itemsByRarity[rarity];
  if (items.length === 0) {
    // No items of this rarity in the pool (should not happen in theory) → fall back to the first common item.
    const fallback = pool.itemsByRarity.common;
    return fallback[0] ?? `${pool.id}_${rarity}`;
  }
  if (pool.fixedOdds && pool.remainderItemId) {
    const table = fixedOddsTable(pool);
    const uniqueItems = Array.from(new Set(items));
    const weights = uniqueItems.map((id) => Math.max(0, Math.round((table[id] ?? 0) * 1000)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let roll = rng(total);
      for (let i = 0; i < uniqueItems.length; i++) {
        roll -= weights[i]!;
        if (roll < 0) return uniqueItems[i]!;
      }
      return uniqueItems[uniqueItems.length - 1]!;
    }
  }
  return items[rng(items.length)]!;
}

/**
 * Fixed-odds base roll (GACHA_DESIGN §2.1b): a single flat weighted pick across every item in the pool's
 * odds table (owner-specified percentages + the remainder item). The returned rarity is the item's display
 * rarity, which still drives dupe refund + the legendary pity reset.
 */
function rollFixedOddsItem(
  pool: GachaPoolDef,
  rarityOf: Map<string, Rarity>,
  rng: RandInt,
): GachaResultEntry {
  const table = fixedOddsTable(pool);
  const ids = Object.keys(table);
  const weights = ids.map((id) => Math.max(0, Math.round(table[id]! * 1000)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = total > 0 ? rng(total) : 0;
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return { itemId: ids[i]!, rarity: rarityOf.get(ids[i]!) ?? 'common' };
  }
  const last = ids.length - 1;
  return { itemId: ids[last]!, rarity: rarityOf.get(ids[last]!) ?? 'common' };
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
  // Fixed-odds pools carry a display-rarity index for their base rolls; flat pools stay on rollRarity.
  const rarityOf = pool.fixedOdds && pool.remainderItemId ? itemRarityMap(pool) : null;

  for (let i = 0; i < count; i++) {
    pity += 1;
    if (pity >= pool.pityThreshold) {
      // Hard pity → guaranteed legendary (rarity axis, pick from itemsByRarity — weighted by fixedOdds when present).
      results.push({ itemId: pickItem(pool, 'legendary', rng), rarity: 'legendary' });
      pity = 0;
      continue;
    }
    const legProb = softPityLegendaryProb(pool, pity);
    if (legProb != null) {
      // Soft-pity ramp active → boosted rarity roll (unchanged behavior, overrides the fixed-odds roll).
      const rarity = rollRarityBoosted(rng, legProb);
      if (rarity === 'legendary') pity = 0;
      results.push({ itemId: pickItem(pool, rarity, rng), rarity });
      continue;
    }
    // Base roll: fixed-odds flat draw where configured, else the rarity-tier-then-uniform table.
    const entry = rarityOf
      ? rollFixedOddsItem(pool, rarityOf, rng)
      : ((): GachaResultEntry => {
          const rarity = rollRarity(rng);
          return { itemId: pickItem(pool, rarity, rng), rarity };
        })();
    if (entry.rarity === 'legendary') pity = 0; // reset pity on legendary (either roll path)
    results.push(entry);
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
