// Ladder rank + ELO pure-function unit tests (S1-R). Numeric values: ECONOMY_BALANCE.md §2.3.
import { describe, it, expect } from 'vitest';
import {
  eloToRank,
  computeEloDelta,
  nextStreak,
  INITIAL_ELO,
  RANK_TIERS,
} from '@nw/shared';

describe('ladder', () => {
  it('9 rank tiers + eloToRank boundaries', () => {
    expect(RANK_TIERS).toHaveLength(9);
    expect(eloToRank(0)).toBe('bronze');
    expect(eloToRank(INITIAL_ELO)).toBe('bronze'); // initial 1000 < silver 1100
    expect(eloToRank(1099)).toBe('bronze');
    expect(eloToRank(1100)).toBe('silver');
    expect(eloToRank(2399)).toBe('grandmaster');
    expect(eloToRank(2400)).toBe('king');
    expect(eloToRank(99999)).toBe('king');
  });

  it('computeEloDelta equal rating ±16 (K=32), zero-sum', () => {
    const d = computeEloDelta(1000, 1000);
    expect(d.winner).toBe(16);
    expect(d.loser).toBe(-16);
    expect(d.winner + d.loser).toBe(0);
  });

  it('upset (low rating beats high rating) earns more points', () => {
    const upset = computeEloDelta(1000, 1400);
    const expected = computeEloDelta(1400, 1000);
    expect(upset.winner).toBeGreaterThan(expected.winner);
    expect(upset.winner + upset.loser).toBe(0);
  });

  it('nextStreak win/loss streaks', () => {
    expect(nextStreak(0, true)).toBe(1);
    expect(nextStreak(3, true)).toBe(4);
    expect(nextStreak(-2, true)).toBe(1); // win during a losing streak → reset to +1
    expect(nextStreak(0, false)).toBe(-1);
    expect(nextStreak(-2, false)).toBe(-3);
    expect(nextStreak(3, false)).toBe(-1); // loss during a winning streak → reset to -1
  });
});
