// Unit tests for season.ts: ELO soft reset, first-reach coin grant (lifetime one-time), season peak coins
// (SEASON_DESIGN.md §4). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  SEASON_RESET_BASELINE,
  softReset,
  RANKS_ASCENDING,
  ranksAtOrBelow,
  FIRST_REACH_COINS,
  firstReachCoins,
  computeFirstReachGrant,
  SEASON_PEAK_COINS,
  seasonPeakCoins,
  makePvpSeasonDefaults,
} from '../src/season';
import { INITIAL_ELO, eloToRank, type RankId } from '../src/ladder';

// ── softReset ─────────────────────────────────────────────────────────────────────

describe('softReset', () => {
  it('regresses ELO above baseline halfway toward it', () => {
    expect(softReset(2400)).toBe(1800); // (2400+1200)/2
    expect(softReset(1500)).toBe(1350);
  });

  it('leaves ELO at the baseline unchanged', () => {
    expect(softReset(SEASON_RESET_BASELINE)).toBe(SEASON_RESET_BASELINE);
  });

  it('leaves ELO below the baseline unchanged', () => {
    expect(softReset(1000)).toBe(1000);
  });

  it('rounds to an integer', () => {
    expect(softReset(1201)).toBe(Math.round((1201 + 1200) / 2));
    expect(Number.isInteger(softReset(1333))).toBe(true);
  });

  it('is idempotent-ish: repeated resets converge toward baseline, never below it', () => {
    let elo = 3000;
    for (let i = 0; i < 20; i++) elo = softReset(elo);
    expect(elo).toBeGreaterThanOrEqual(SEASON_RESET_BASELINE);
  });

  it('honors a custom baseline', () => {
    expect(softReset(2000, 1000)).toBe(1500);
    expect(softReset(500, 1000)).toBe(500);
  });
});

// ── RANKS_ASCENDING / ranksAtOrBelow ──────────────────────────────────────────────

describe('RANKS_ASCENDING', () => {
  it('is ordered lowest→highest', () => {
    expect(RANKS_ASCENDING[0]).toBe('bronze');
    expect(RANKS_ASCENDING[RANKS_ASCENDING.length - 1]).toBe('king');
  });
});

describe('ranksAtOrBelow', () => {
  it('returns only the lowest rank for bronze', () => {
    expect(ranksAtOrBelow('bronze')).toEqual(['bronze']);
  });

  it('is inclusive of the target rank', () => {
    const r = ranksAtOrBelow('gold');
    expect(r).toContain('gold');
    expect(r[r.length - 1]).toBe('gold');
  });

  it('returns the full ladder for king', () => {
    expect(ranksAtOrBelow('king')).toEqual(RANKS_ASCENDING);
  });

  it('returns empty for an unknown rank', () => {
    expect(ranksAtOrBelow('unknown' as RankId)).toEqual([]);
  });
});

// ── first-reach coins ─────────────────────────────────────────────────────────────

describe('FIRST_REACH_COINS', () => {
  it('covers every rank', () => {
    for (const rank of RANKS_ASCENDING) {
      expect(FIRST_REACH_COINS[rank]).toBeGreaterThan(0);
    }
  });

  it('rewards ascend with rank', () => {
    for (let i = 1; i < RANKS_ASCENDING.length; i++) {
      expect(FIRST_REACH_COINS[RANKS_ASCENDING[i]!]).toBeGreaterThan(
        FIRST_REACH_COINS[RANKS_ASCENDING[i - 1]!],
      );
    }
  });
});

describe('firstReachCoins', () => {
  it('returns 0 for an unknown rank', () => {
    expect(firstReachCoins('unknown' as RankId)).toBe(0);
  });
});

describe('computeFirstReachGrant', () => {
  it('first-ever bronze grants only bronze', () => {
    const { coins, newly } = computeFirstReachGrant('bronze', []);
    expect(newly).toEqual(['bronze']);
    expect(coins).toBe(FIRST_REACH_COINS.bronze);
  });

  it('reaching gold from scratch grants bronze+silver+gold together', () => {
    const { coins, newly } = computeFirstReachGrant('gold', []);
    expect(newly).toEqual(['bronze', 'silver', 'gold']);
    expect(coins).toBe(
      FIRST_REACH_COINS.bronze + FIRST_REACH_COINS.silver + FIRST_REACH_COINS.gold,
    );
  });

  it('skips ranks already in the ledger (no double grant)', () => {
    const { coins, newly } = computeFirstReachGrant('gold', ['bronze', 'silver']);
    expect(newly).toEqual(['gold']);
    expect(coins).toBe(FIRST_REACH_COINS.gold);
  });

  it('grants nothing when the rank and everything below is already reached', () => {
    const { coins, newly } = computeFirstReachGrant('gold', ['bronze', 'silver', 'gold']);
    expect(newly).toEqual([]);
    expect(coins).toBe(0);
  });

  it('does not re-grant when re-reaching a lower rank than the ledger max', () => {
    const { coins, newly } = computeFirstReachGrant('silver', ['bronze', 'silver', 'gold', 'platinum']);
    expect(newly).toEqual([]);
    expect(coins).toBe(0);
  });
});

// ── season peak coins ─────────────────────────────────────────────────────────────

describe('SEASON_PEAK_COINS', () => {
  it('low ranks (bronze/silver) award nothing', () => {
    expect(SEASON_PEAK_COINS.bronze).toBe(0);
    expect(SEASON_PEAK_COINS.silver).toBe(0);
  });

  it('is non-decreasing with rank', () => {
    for (let i = 1; i < RANKS_ASCENDING.length; i++) {
      expect(SEASON_PEAK_COINS[RANKS_ASCENDING[i]!]).toBeGreaterThanOrEqual(
        SEASON_PEAK_COINS[RANKS_ASCENDING[i - 1]!],
      );
    }
  });

  it('is at most the first-reach amount for the same rank (repeatable < one-time)', () => {
    for (const rank of RANKS_ASCENDING) {
      expect(SEASON_PEAK_COINS[rank]).toBeLessThanOrEqual(FIRST_REACH_COINS[rank]);
    }
  });
});

describe('seasonPeakCoins', () => {
  it('returns 0 for an unknown rank', () => {
    expect(seasonPeakCoins('unknown' as RankId)).toBe(0);
  });
});

// ── makePvpSeasonDefaults ─────────────────────────────────────────────────────────

describe('makePvpSeasonDefaults', () => {
  it('seeds peak fields from the given ELO', () => {
    const d = makePvpSeasonDefaults(3, INITIAL_ELO);
    expect(d.seasonNo).toBe(3);
    expect(d.seasonPeakElo).toBe(INITIAL_ELO);
    expect(d.seasonPeakRank).toBe(eloToRank(INITIAL_ELO));
    expect(d.reachedRanks).toEqual([]);
  });
});
