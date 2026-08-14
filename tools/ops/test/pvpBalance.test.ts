// pvpBalance.ts's win-rate calc (deck-composition win rate, see file header for the pipeline's
// known limits) — row()/pagePvpBalance build DOM (`h()`) and stay untested, see vitest.config.ts.
import { describe, it, expect } from 'vitest';
import { winRate } from '../src/pages/pvpBalance';

describe('winRate', () => {
  it('divides wins by games', () => {
    expect(winRate({ cardId: 'c1', games: 20, wins: 5 })).toBe(0.25);
  });

  it('returns 0 for zero games instead of NaN/Infinity', () => {
    expect(winRate({ cardId: 'c1', games: 0, wins: 0 })).toBe(0);
  });

  it('handles a 100% win rate', () => {
    expect(winRate({ cardId: 'c1', games: 4, wins: 4 })).toBe(1);
  });
});
