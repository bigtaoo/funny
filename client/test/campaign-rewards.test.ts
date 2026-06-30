import { describe, it, expect } from 'vitest';
import { computeStars, remainingHpPct } from '../src/game/meta/campaignRewards';

// From PVE_INTEGRITY_PLAN §8, clear settlement (progress/stars/materials) is server-authoritative;
// the old local applyCampaignClear was removed (flows through SaveManager.recordClear → POST /pve/clear).
// This file only retains the client-side star-rating pure function (result is reported to server for verification).

describe('computeStars', () => {
  it('counts non-decreasing thresholds met, upgrading to 2★/3★', () => {
    expect(computeStars([50, 80, 100], 100)).toBe(3);
    expect(computeStars([50, 80, 100], 85)).toBe(2);
    expect(computeStars([50, 80, 100], 50)).toBe(1);
  });
  it('floors any clear (base alive) to 1★ even below the first threshold', () => {
    // Victory floor 1★: base surviving = clear + unlock next level; thresholds only upgrade to 2★/3★.
    expect(computeStars([50, 80, 100], 49)).toBe(1);
    expect(computeStars([50, 80, 100], 1)).toBe(1);
  });
  it('returns 0★ only when the base was destroyed (HP ≤ 0)', () => {
    expect(computeStars([50, 80, 100], 0)).toBe(0);
    expect(computeStars(undefined, 0)).toBe(0);
  });
  it('falls back to 1★ on clear when no thresholds given', () => {
    expect(computeStars(undefined, 1)).toBe(1);
  });
});

describe('remainingHpPct', () => {
  it('is 100 minus base damage, clamped 0..100', () => {
    expect(remainingHpPct(0)).toBe(100);
    expect(remainingHpPct(30)).toBe(70);
    expect(remainingHpPct(140)).toBe(0);
  });
});
