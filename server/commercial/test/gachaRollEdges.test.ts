// gacha.ts's edge branches — the ones the standard pool's own shape can never produce.
//
// gacha.test.ts / customGacha.test.ts drive the real pools (standard + a well-formed ops config), which
// covers the arithmetic but leaves every "the pool config isn't what we assumed" guard unexecuted (80.51%
// branches, claudedocs/server-testing-coverage.md). Those guards matter because a pool definition is not
// a constant: limited pools are BUILT at draw time from an admin-authored doc (base.ts's resolvePool →
// buildLimitedPool), custom pools are authored entry by entry in the ops console, and the item catalogue
// they name items from evolves independently of pools already stored in Mongo. Every case below is a
// config a running deployment can actually hand to these functions — an empty rarity tier, an odds-table
// item that isn't in itemsByRarity (or vice versa), a weight so small it scales to nothing, an item the
// catalogue no longer knows. A draw must degrade to a defined item, because the caller (gachaDraw) has
// already charged the player by the time these run.
//
// The two tests marked "off-contract" feed an rng that returns `n` for `rng(n)` — outside the RandInt
// contract, unreachable from cryptoRand — solely to prove the post-loop fallthroughs return a real item
// instead of `undefined!`. They are pinned rather than left dead because those `!` non-null assertions
// are what stops a bad rng from putting `undefined` into a wallet-charged draw result.
import { describe, expect, it } from 'vitest';
import type { CustomPoolConfig, GachaPoolDef } from '@nw/shared';
import { rollCustomGacha, rollGacha, softPityLegendaryProb, type RandInt } from '../src/gacha';

/** Feeds a preset sequence; 0 once exhausted (same helper shape as gacha.test.ts). */
function seq(values: number[]): RandInt {
  let i = 0;
  return () => values[i++] ?? 0;
}

/** A flat (non-fixed-odds) pool with exactly one item per tier, so item picks are unambiguous. */
function flatPool(over: Partial<GachaPoolDef> = {}): GachaPoolDef {
  return {
    id: 'edge_pool',
    costSingle: 100,
    costTen: 900,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: ['l1'] },
    ...over,
  };
}

describe('softPityLegendaryProb — half-configured soft pity', () => {
  // buildLimitedPool always sets both, but a pool def is plain data: a hand-authored/older one carrying
  // only the start must fall back to the flat table rather than ramp with `undefined` as the step.
  it('returns null when the start is set but the step is missing', () => {
    expect(softPityLegendaryProb(flatPool({ softPityStart: 70 }), 80)).toBeNull();
  });

  it('returns null when the step is set but the start is missing', () => {
    expect(softPityLegendaryProb(flatPool({ softPityStep: 0.05 }), 80)).toBeNull();
  });
});

describe('rollRarityBoosted — the non-legendary remainder of a soft-pity pull', () => {
  // legProb exactly 0.5 (base 0.01 + one 0.49 step) ⇒ legendary [0,500), then the 1-legProb remainder
  // splits 700:230:60 → common [500,854), rare [854,970), epic [970,1000).
  const soft = flatPool({ softPityStart: 1, softPityStep: 0.49 });

  it('a soft-pity pull can still land on common (and does not reset pity)', () => {
    const { results, pityAfter } = rollGacha(soft, 1, 0, seq([500, 0]));
    expect(results[0]).toEqual({ itemId: 'c1', rarity: 'common' });
    expect(pityAfter).toBe(1);
  });

  it('a soft-pity pull can land on rare', () => {
    const { results } = rollGacha(soft, 1, 0, seq([854, 0]));
    expect(results[0]).toEqual({ itemId: 'r1', rarity: 'rare' });
  });

  it('a soft-pity pull can land on epic', () => {
    const { results } = rollGacha(soft, 1, 0, seq([999, 0]));
    expect(results[0]).toEqual({ itemId: 'e1', rarity: 'epic' });
  });

  it('legProb 1 (deep in the ramp) guarantees the legendary and resets pity', () => {
    const { results, pityAfter } = rollGacha(soft, 1, 20, seq([999, 0]));
    expect(results[0]).toEqual({ itemId: 'l1', rarity: 'legendary' });
    expect(pityAfter).toBe(0);
  });
});

describe('rollRarity — off-contract rng', () => {
  it('a rarity roll past the end of the weight table falls through to common', () => {
    // The tier weights sum to 1000, so a roll of exactly 1000 exhausts every tier and hits the final
    // `return 'common'`. Only the rarity roll is off-contract here (the item pick still gets 0), so the
    // assertion is about the rarity the fallthrough chose, not about pickItem's own indexing.
    const offContractRarityRoll: RandInt = (n) => (n === 1000 ? 1000 : 0);
    const { results } = rollGacha(flatPool(), 1, 0, offContractRarityRoll);
    expect(results[0]).toEqual({ itemId: 'c1', rarity: 'common' });
  });
});

describe('pickItem — a rarity tier with no items in it', () => {
  // Reachable today: buildLimitedPool derives its tiers from another pool's lists, and an ops-authored
  // limited config whose filler list resolves to nothing leaves a tier empty. Hard pity then demands a
  // legendary from a tier that has none.
  it('falls back to the pool\'s first common item', () => {
    const pool = flatPool({ pityThreshold: 1, itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: [] } });
    const { results } = rollGacha(pool, 1, 0, seq([0]));
    expect(results[0]).toEqual({ itemId: 'c1', rarity: 'legendary' });
  });

  it('falls back to a synthetic `<poolId>_<rarity>` id when even common is empty', () => {
    const pool = flatPool({ pityThreshold: 1, itemsByRarity: { common: [], rare: [], epic: [], legendary: [] } });
    const { results } = rollGacha(pool, 1, 0, seq([0]));
    expect(results[0]).toEqual({ itemId: 'edge_pool_legendary', rarity: 'legendary' });
  });
});

describe('fixed-odds tables that disagree with itemsByRarity', () => {
  // The two maps are maintained separately (see GachaPoolDef's fixedOdds doc), so they can drift apart in
  // both directions. Neither direction may throw or produce an item outside the pool.
  it('a pity pick weights an item absent from the odds table as 0 and picks a listed sibling instead', () => {
    const pool = flatPool({
      pityThreshold: 1,
      itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: ['l1', 'l_unpriced'] },
      fixedOdds: { l1: 1 },
      remainderItemId: 'c1',
    });
    const { results } = rollGacha(pool, 1, 0, seq([0]));
    // l1 carries the whole 1000-wide weight; l_unpriced's `table[id] ?? 0` weight keeps it unpickable.
    expect(results[0]).toEqual({ itemId: 'l1', rarity: 'legendary' });
  });

  it('a base roll on an odds-table item missing from itemsByRarity displays as common', () => {
    const pool = flatPool({
      itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: ['l1'] },
      fixedOdds: { ghost_item: 100 },
      remainderItemId: 'c1',
    });
    const { results } = rollGacha(pool, 1, 0, seq([0]));
    expect(results[0]).toEqual({ itemId: 'ghost_item', rarity: 'common' });
  });

  it('off-contract rng: a base roll past the end of the odds table returns its last entry', () => {
    const pool = flatPool({
      itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: ['l1'] },
      fixedOdds: { l1: 50 },
      remainderItemId: 'c1',
    });
    // rng returns the full total, so no bucket matches; the remainder entry (last key) must still win.
    const { results } = rollGacha(pool, 1, 0, (n) => n);
    expect(results[0]).toEqual({ itemId: 'c1', rarity: 'common' });
  });

  it('off-contract rng: a pity pick past the end of the weight table returns its last unique item', () => {
    const pool = flatPool({
      pityThreshold: 1,
      itemsByRarity: { common: ['c1'], rare: ['r1'], epic: ['e1'], legendary: ['l1', 'l2'] },
      fixedOdds: { l1: 30, l2: 30 },
      remainderItemId: 'c1',
    });
    const { results } = rollGacha(pool, 1, 0, (n) => n);
    expect(results[0]).toEqual({ itemId: 'l2', rarity: 'legendary' });
  });
});

describe('ten-pull floor with a legendary floor', () => {
  // tenFloor is per-pool data; a promo pool floored at legendary must reset pity like any other legendary,
  // otherwise the next pull inherits a pity count the player already cashed in.
  it('promotes the last pull to legendary and resets pity', () => {
    const pool = flatPool({ tenFloor: 'legendary' });
    const { results, pityAfter } = rollGacha(pool, 10, 0, () => 0); // rng 0 → every pull common
    expect(results).toHaveLength(10);
    expect(results[9]).toEqual({ itemId: 'l1', rarity: 'legendary' });
    expect(pityAfter).toBe(0);
  });
});

describe('rollGacha with the default crypto rng', () => {
  // Every production draw uses the default cryptoRand (deps.rng is only ever set by tests), including its
  // `n <= 1 → 0` short-circuit: randomInt(1) is a pointless syscall, and randomInt(0) throws outright.
  it('draws from a one-item-per-tier pool without an injected rng', () => {
    const { results } = rollGacha(flatPool(), 10, 0);
    expect(results).toHaveLength(10);
    for (const r of results) expect(['c1', 'r1', 'e1', 'l1']).toContain(r.itemId);
  });
});

describe('rollCustomGacha — degenerate ops-authored weights', () => {
  function customCfg(categories: CustomPoolConfig['categories']): CustomPoolConfig {
    return { id: 'edge_custom', name: 'Edge', costSingle: 100, startAt: 0, endAt: 1, categories };
  }

  // Weights are scaled ×1e6 and rounded, so any positive weight below 5e-7 collapses to 0. validateCustomPool
  // only requires `weight > 0`, so such a config is storable — the draw must fall back to the first entry
  // rather than dividing by a zero total.
  it('a weight that scales to zero falls back to the first entry instead of crashing', () => {
    const cfg = customCfg([
      { category: 'material', weight: 1e-9, items: [{ itemId: 'mat_scrap', weight: 1e-9 }, { itemId: 'mat_lead', weight: 1e-9 }] },
    ]);
    const results = rollCustomGacha(cfg, 1, seq([0, 0]));
    expect(results[0]).toEqual({ itemId: 'mat_scrap', rarity: 'common' });
  });

  it('off-contract rng: an item roll past the end of the weight table returns the last item', () => {
    const cfg = customCfg([
      { category: 'material', weight: 100, items: [{ itemId: 'mat_scrap', weight: 1 }, { itemId: 'mat_lead', weight: 1 }] },
    ]);
    const results = rollCustomGacha(cfg, 1, (n) => n);
    expect(results[0]).toEqual({ itemId: 'mat_lead', rarity: 'rare' });
  });

  // A stored pool outlives the catalogue it was authored against (validateCustomPool ran at create time,
  // against the catalogue of that day). An item since removed must still resolve to a usable rarity.
  it('an item the catalogue no longer knows is reported as common rather than undefined', () => {
    const cfg = customCfg([{ category: 'material', weight: 100, items: [{ itemId: 'mat_retired', weight: 1 }] }]);
    const results = rollCustomGacha(cfg, 1, seq([0, 0]));
    expect(results[0]).toEqual({ itemId: 'mat_retired', rarity: 'common' });
  });
});
