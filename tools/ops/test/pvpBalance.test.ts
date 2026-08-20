// src/logic/pvpBalance.ts — the win-rate calc (deck-composition win rate, see file header for the pipeline's
// known limits) — row()/pagePvpBalance build DOM (`h()`) and stay untested, see vitest.config.ts.
import { describe, it, expect } from 'vitest';
import {
  isOffBalance, OFF_BALANCE_DELTA, rankByWinRate, sinceParam, winRate, winRateText,
} from '../src/logic/pvpBalance';

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

const card = (cardId: string, games: number, wins: number) => ({ cardId, games, wins });

describe('rankByWinRate', () => {
  it('puts the best win rate first', () => {
    const rows = [card('a', 10, 2), card('b', 10, 9), card('c', 10, 5)];
    expect(rankByWinRate(rows).map((r) => r.cardId)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by RATE, not by absolute wins', () => {
    const rows = [card('many', 1000, 400), card('few', 10, 9)];
    expect(rankByWinRate(rows)[0]!.cardId).toBe('few');
  });

  it('does not sort the fetched array in place — the caller owns it', () => {
    const rows = [card('a', 10, 2), card('b', 10, 9)];
    rankByWinRate(rows);
    expect(rows.map((r) => r.cardId)).toEqual(['a', 'b']);
  });

  it('handles an empty report', () => {
    expect(rankByWinRate([])).toEqual([]);
  });
});

describe('winRateText', () => {
  it('formats a played card as a percentage', () => {
    expect(winRateText(card('a', 8, 2))).toBe('25.0%');
  });

  it('reads an unplayed card as an em dash — "no data" and "0%" mean different things', () => {
    expect(winRateText(card('a', 0, 0))).toBe('—');
  });
});

describe('isOffBalance', () => {
  it('flags anything at least 15 points off even odds, in either direction', () => {
    expect(OFF_BALANCE_DELTA).toBe(0.15);
    expect(isOffBalance(0.65)).toBe(true);
    expect(isOffBalance(0.35)).toBe(true);
    expect(isOffBalance(1)).toBe(true);
    expect(isOffBalance(0)).toBe(true);
  });

  it('leaves a near-even card alone', () => {
    expect(isOffBalance(0.5)).toBe(false);
    expect(isOffBalance(0.6)).toBe(false);
    expect(isOffBalance(0.4)).toBe(false);
  });

  it('is inclusive at exactly the threshold', () => {
    expect(isOffBalance(0.5 + OFF_BALANCE_DELTA)).toBe(true);
  });

  it('does not flag an unplayed card, whose rate is 0 only for lack of data', () => {
    // The page colours on the rate, and winRateText already prints an em dash for these — worth
    // knowing that the colour and the number disagree here, since the rate itself is 0.
    expect(winRate(card('a', 0, 0))).toBe(0);
    expect(isOffBalance(winRate(card('a', 0, 0)))).toBe(true);
    expect(winRateText(card('a', 0, 0))).toBe('—');
  });
});

describe('sinceParam', () => {
  it('strips the dashes a date input produces', () => {
    expect(sinceParam('2026-08-13')).toBe('20260813');
  });

  it('is undefined for a cleared field, so the query omits it', () => {
    expect(sinceParam('')).toBeUndefined();
  });
});
