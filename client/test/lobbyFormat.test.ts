import { describe, it, expect } from 'vitest';
import { fmtCoins } from '../src/scenes/LobbyScene/format';

describe('fmtCoins (LobbyScene header coin chip)', () => {
  it('formats sub-10k values with thousands separators', () => {
    expect(fmtCoins(0)).toBe('0');
    expect(fmtCoins(42)).toBe('42');
    expect(fmtCoins(1234)).toBe('1,234');
    expect(fmtCoins(9999)).toBe('9,999');
  });

  it('formats 10k-99999 as one-decimal "k" (e.g. 23456 -> "23.5k")', () => {
    expect(fmtCoins(10000)).toBe('10.0k');
    expect(fmtCoins(23456)).toBe('23.5k');
    expect(fmtCoins(99999)).toBe('100.0k');
  });

  it('formats >=100k as integer "k"', () => {
    expect(fmtCoins(100000)).toBe('100k');
    expect(fmtCoins(1234567)).toBe('1235k');
  });

  it('clamps negative and fractional input (floors, never negative)', () => {
    expect(fmtCoins(-50)).toBe('0');
    expect(fmtCoins(41.9)).toBe('41');
  });
});
