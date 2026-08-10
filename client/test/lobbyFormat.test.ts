import { describe, it, expect } from 'vitest';
import { fmtCoins } from '../src/scenes/LobbyScene/format';

describe('fmtCoins (LobbyScene header coin chip)', () => {
  it('formats sub-10k values with thousands separators', () => {
    expect(fmtCoins(0)).toBe('0');
    expect(fmtCoins(42)).toBe('42');
    expect(fmtCoins(1234)).toBe('1,234');
    expect(fmtCoins(9999)).toBe('9,999');
  });

  it('formats values above 10k as the full number with thousands separators, never abbreviated', () => {
    expect(fmtCoins(10000)).toBe('10,000');
    expect(fmtCoins(23456)).toBe('23,456');
    expect(fmtCoins(99999)).toBe('99,999');
    expect(fmtCoins(100000)).toBe('100,000');
    expect(fmtCoins(1234567)).toBe('1,234,567');
    expect(fmtCoins(97084000)).toBe('97,084,000');
  });

  it('clamps negative and fractional input (floors, never negative)', () => {
    expect(fmtCoins(-50)).toBe('0');
    expect(fmtCoins(41.9)).toBe('41');
  });
});
