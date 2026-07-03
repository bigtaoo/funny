// Unit tests for economy.ts: gacha pool integrity, cost math, odds expansion, IAP tier consistency,
// limited-pool derivation (ECONOMY_BALANCE.md §2~4, GACHA_DESIGN §7). Pure data + pure functions.
import { describe, it, expect } from 'vitest';
import {
  RARITY_ORDER,
  RARITY_WEIGHTS,
  GACHA_POOLS,
  SHOP_ITEMS,
  DUPE_REFUND_COINS,
  IAP_TIERS,
  IAP_TIERS_LIST,
  DEV_STUB_DEFAULT_TIER,
  VICTORY_COINS_BY_RANK,
  victoryCoinsForRank,
  findGachaPool,
  findShopItem,
  gachaCost,
  poolEntries,
  buildLimitedPool,
  isLimitedPoolActive,
  DEFAULT_LIMITED_FILLER_LEGENDARIES,
  RENAME_COST,
  type GachaPoolDef,
} from '../src/economy';
import type { Rarity } from '../src/types';

const standard = GACHA_POOLS[0]!;

// ── RARITY_WEIGHTS / RARITY_ORDER ─────────────────────────────────────────────────

describe('rarity weights', () => {
  it('order is common→legendary (ascending rarity)', () => {
    expect(RARITY_ORDER).toEqual(['common', 'rare', 'epic', 'legendary']);
  });

  it('weights sum to 1000 (a clean total for %-odds display)', () => {
    const sum = RARITY_ORDER.reduce((s, r) => s + RARITY_WEIGHTS[r], 0);
    expect(sum).toBe(1000);
  });

  it('rarer tiers are less likely', () => {
    expect(RARITY_WEIGHTS.common).toBeGreaterThan(RARITY_WEIGHTS.rare);
    expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
    expect(RARITY_WEIGHTS.epic).toBeGreaterThan(RARITY_WEIGHTS.legendary);
  });
});

// ── GACHA_POOLS integrity ─────────────────────────────────────────────────────────

describe('GACHA_POOLS', () => {
  it('have unique ids', () => {
    const ids = GACHA_POOLS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every pool has a non-empty item list per rarity', () => {
    for (const pool of GACHA_POOLS) {
      for (const r of RARITY_ORDER) {
        expect(pool.itemsByRarity[r].length).toBeGreaterThan(0);
      }
    }
  });

  it('ten-pull is cheaper than ten singles (bulk discount)', () => {
    for (const pool of GACHA_POOLS) {
      expect(pool.costTen).toBeLessThan(pool.costSingle * 10);
    }
  });

  it('soft pity starts before the hard pity threshold', () => {
    for (const pool of GACHA_POOLS) {
      if (pool.softPityStart !== undefined) {
        expect(pool.softPityStart).toBeLessThan(pool.pityThreshold);
      }
    }
  });
});

// ── gachaCost ─────────────────────────────────────────────────────────────────────

describe('gachaCost', () => {
  it('a single pull costs costSingle', () => {
    expect(gachaCost(standard, 1)).toBe(standard.costSingle);
  });

  it('a ten-pull uses the discounted bundle price', () => {
    expect(gachaCost(standard, 10)).toBe(standard.costTen);
  });

  it('non-ten multi counts scale linearly by single price', () => {
    expect(gachaCost(standard, 3)).toBe(standard.costSingle * 3);
  });
});

// ── poolEntries (odds display) ────────────────────────────────────────────────────

describe('poolEntries', () => {
  const entries = poolEntries(standard);

  it('aggregates duplicate itemIds within a tier into a single entry', () => {
    // standard common tier is [mat_scrap, mat_scrap, mat_scrap] → one aggregated entry
    const commons = entries.filter((e) => e.rarity === 'common');
    expect(commons).toHaveLength(1);
    expect(commons[0]!.itemId).toBe('mat_scrap');
  });

  it('per-tier weights sum (approximately) to that tier weight', () => {
    for (const r of RARITY_ORDER) {
      const tierSum = entries.filter((e) => e.rarity === r).reduce((s, e) => s + e.weight, 0);
      // rounding of per-slot weights allows small drift
      expect(Math.abs(tierSum - RARITY_WEIGHTS[r])).toBeLessThanOrEqual(entries.filter((e) => e.rarity === r).length);
    }
  });

  it('tags every entry with its rarity', () => {
    for (const e of entries) expect(RARITY_ORDER).toContain(e.rarity);
  });
});

// ── lookups ───────────────────────────────────────────────────────────────────────

describe('lookups', () => {
  it('findGachaPool resolves the standard pool and misses unknowns', () => {
    expect(findGachaPool('standard')?.id).toBe('standard');
    expect(findGachaPool('nope')).toBeUndefined();
  });

  it('findShopItem resolves a known item and misses unknowns', () => {
    expect(findShopItem(SHOP_ITEMS[0]!.id)?.id).toBe(SHOP_ITEMS[0]!.id);
    expect(findShopItem('nope')).toBeUndefined();
  });
});

// ── DUPE_REFUND_COINS ─────────────────────────────────────────────────────────────

describe('DUPE_REFUND_COINS', () => {
  it('refunds rise with rarity', () => {
    for (let i = 1; i < RARITY_ORDER.length; i++) {
      expect(DUPE_REFUND_COINS[RARITY_ORDER[i]!]).toBeGreaterThan(DUPE_REFUND_COINS[RARITY_ORDER[i - 1]!]);
    }
  });
});

// ── IAP tiers ─────────────────────────────────────────────────────────────────────

describe('IAP tiers', () => {
  it('IAP_TIERS and IAP_TIERS_LIST agree on coin totals', () => {
    for (const t of IAP_TIERS_LIST) {
      expect(IAP_TIERS[t.id]).toBe(t.coins);
    }
  });

  it('every list tier id exists in the map and vice versa', () => {
    expect(new Set(IAP_TIERS_LIST.map((t) => t.id))).toEqual(new Set(Object.keys(IAP_TIERS)));
  });

  it('coins are at least the base amount (bonus never negative)', () => {
    for (const t of IAP_TIERS_LIST) expect(t.coins).toBeGreaterThanOrEqual(t.base);
  });

  it('price ascends with tier', () => {
    for (let i = 1; i < IAP_TIERS_LIST.length; i++) {
      expect(IAP_TIERS_LIST[i]!.usdCents).toBeGreaterThan(IAP_TIERS_LIST[i - 1]!.usdCents);
    }
  });

  it('bigger spend gives a better coins-per-cent ratio (whale value)', () => {
    const ratio = (t: (typeof IAP_TIERS_LIST)[number]) => t.coins / t.usdCents;
    for (let i = 1; i < IAP_TIERS_LIST.length; i++) {
      expect(ratio(IAP_TIERS_LIST[i]!)).toBeGreaterThanOrEqual(ratio(IAP_TIERS_LIST[i - 1]!) - 1e-9);
    }
  });

  it('the dev-stub default tier exists and grants more than a rename', () => {
    expect(IAP_TIERS[DEV_STUB_DEFAULT_TIER]).toBeDefined();
    expect(IAP_TIERS[DEV_STUB_DEFAULT_TIER]!).toBeGreaterThan(RENAME_COST);
  });

  it('exactly one tier is flagged bestValue', () => {
    expect(IAP_TIERS_LIST.filter((t) => t.bestValue)).toHaveLength(1);
  });
});

// ── victory coins ─────────────────────────────────────────────────────────────────

describe('victoryCoinsForRank', () => {
  it('is non-decreasing across the rank ladder', () => {
    const ranks = Object.keys(VICTORY_COINS_BY_RANK);
    for (let i = 1; i < ranks.length; i++) {
      expect(VICTORY_COINS_BY_RANK[ranks[i] as keyof typeof VICTORY_COINS_BY_RANK]).toBeGreaterThanOrEqual(
        VICTORY_COINS_BY_RANK[ranks[i - 1] as keyof typeof VICTORY_COINS_BY_RANK],
      );
    }
  });

  it('falls back to the bronze amount for an unknown rank', () => {
    expect(victoryCoinsForRank('mythic_unknown')).toBe(VICTORY_COINS_BY_RANK.bronze);
  });
});

// ── limited pool derivation ───────────────────────────────────────────────────────

describe('buildLimitedPool', () => {
  const cfg = {
    id: 'limited_01',
    name: 'Test Banner',
    featuredLegendary: 'skin_limited_x', // distinct from the default fillers
    startAt: 1000,
    endAt: 2000,
  };
  const pool: GachaPoolDef = buildLimitedPool(cfg);

  it('copies common/rare/epic tiers verbatim from the standard pool', () => {
    expect(pool.itemsByRarity.common).toEqual(standard.itemsByRarity.common);
    expect(pool.itemsByRarity.rare).toEqual(standard.itemsByRarity.rare);
    expect(pool.itemsByRarity.epic).toEqual(standard.itemsByRarity.epic);
  });

  it('marks the pool limited and carries banner metadata', () => {
    expect(pool.limited).toBe(true);
    expect(pool.featuredLegendary).toBe('skin_limited_x');
    expect(pool.id).toBe('limited_01');
    expect(pool.startAt).toBe(1000);
    expect(pool.endAt).toBe(2000);
  });

  it('weights the featured legendary to roughly half the legendary tier', () => {
    const leg = pool.itemsByRarity.legendary;
    const featuredCount = leg.filter((x) => x === cfg.featuredLegendary).length;
    // featured occupies as many slots as there are fillers
    expect(featuredCount).toBe(DEFAULT_LIMITED_FILLER_LEGENDARIES.length);
    expect(featuredCount / leg.length).toBeCloseTo(0.5, 1);
  });

  it('respects custom filler legendaries', () => {
    const custom = buildLimitedPool({ ...cfg, fillerLegendaries: ['skin_l1_alt'] });
    // 1 filler → 1 featured slot
    expect(custom.itemsByRarity.legendary).toEqual(['skin_limited_x', 'skin_l1_alt']);
  });
});

describe('isLimitedPoolActive', () => {
  const cfg = { startAt: 1000, endAt: 2000 };
  it('is inactive before the open time', () => {
    expect(isLimitedPoolActive(cfg, 999)).toBe(false);
  });
  it('is active at the open instant (inclusive start)', () => {
    expect(isLimitedPoolActive(cfg, 1000)).toBe(true);
  });
  it('is active mid-window', () => {
    expect(isLimitedPoolActive(cfg, 1500)).toBe(true);
  });
  it('is inactive at the close instant (exclusive end)', () => {
    expect(isLimitedPoolActive(cfg, 2000)).toBe(false);
  });
});
