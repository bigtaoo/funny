// suspicions.ts's fmtStats — renders a statKey→count map as compact text for the anti-cheat
// review table's pvp_overclaim detail column. pageSuspicions() itself builds DOM, untested.
import { describe, it, expect } from 'vitest';
import { fmtStats } from '../src/pages/suspicions';

describe('fmtStats', () => {
  it('returns an em dash for undefined', () => {
    expect(fmtStats(undefined)).toBe('—');
  });

  it('returns an em dash for an empty map', () => {
    expect(fmtStats({})).toBe('—');
  });

  it('formats a single entry as key:count', () => {
    expect(fmtStats({ kills: 3 })).toBe('kills:3');
  });

  it('joins multiple entries with ", " in key insertion order', () => {
    expect(fmtStats({ kills: 3, deaths: 1, assists: 0 })).toBe('kills:3, deaths:1, assists:0');
  });
});
