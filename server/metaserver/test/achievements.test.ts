// Pure logic unit tests for achievements (S9-1, always runs — no Mongo required): tierState / validateClaim / hasClaimable.
// Numbers: see ECONOMY_BALANCE.md §2.4; mechanics: see ACHIEVEMENT_DESIGN.md §4.
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS,
  findAchievement,
  tierState,
  hasClaimable,
  validateClaim,
  sanitizePvpReportedStats,
  accrueStats,
  PVP_STAT_MATCH_CAP,
} from '@nw/shared';

describe('achievement definition table', () => {
  it('5 entries, tiers strictly increasing with non-decreasing thresholds', () => {
    expect(ACHIEVEMENTS.length).toBe(5);
    for (const a of ACHIEVEMENTS) {
      expect(a.tiers.length).toBe(3);
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i].threshold).toBeGreaterThanOrEqual(a.tiers[i - 1].threshold);
      }
    }
  });
});

describe('tierState — current tier derivation', () => {
  const def = findAchievement('ach.kill.archer')!; // thresholds 100/500/2000, coins 50/100/200

  it('no tier reached: all reached=false', () => {
    const st = tierState(def, { 'kill.archer': 50 }, []);
    expect(st.map((s) => s.reached)).toEqual([false, false, false]);
    expect(st[0].progress).toBe(50);
  });

  it('tiers I/II reached but not claimed: claimable; tier III not yet reached', () => {
    const st = tierState(def, { 'kill.archer': 600 }, []);
    expect(st[0].claimable).toBe(true);
    expect(st[1].claimable).toBe(true);
    expect(st[2].reached).toBe(false);
    expect(st[0].progress).toBe(100); // capped at threshold
  });

  it('tier I already claimed: reached but not claimable', () => {
    const st = tierState(def, { 'kill.archer': 600 }, [1]);
    expect(st[0].claimed).toBe(true);
    expect(st[0].claimable).toBe(false);
    expect(st[1].claimable).toBe(true);
  });

  it('missing stats treated as 0', () => {
    const st = tierState(def, undefined, []);
    expect(st.every((s) => !s.reached)).toBe(true);
  });
});

describe('hasClaimable — red dot aggregation', () => {
  it('no stats → no red dot', () => {
    expect(hasClaimable(undefined, undefined)).toBe(false);
  });
  it('achievement tier reached but not claimed → red dot present', () => {
    expect(hasClaimable({ 'kill.archer': 100 }, {})).toBe(true);
  });
  it('tier reached and fully claimed → no red dot', () => {
    expect(
      hasClaimable({ 'kill.archer': 100 }, { 'ach.kill.archer': { claimedTiers: [1] } }),
    ).toBe(false);
  });
});

describe('validateClaim — claim validation (server-authoritative, never trusts client)', () => {
  it('unknown achievement / out-of-range tier → BAD_REQUEST', () => {
    expect(validateClaim('nope', 1, {}, [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(validateClaim('ach.kill.archer', 4, { 'kill.archer': 9999 }, [])).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    expect(validateClaim('ach.kill.archer', 0, {}, [])).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
  });

  it('threshold not reached → NOT_REACHED', () => {
    expect(validateClaim('ach.kill.archer', 2, { 'kill.archer': 100 }, [])).toEqual({
      ok: false,
      error: 'NOT_REACHED',
    });
  });

  it('already claimed → ALREADY_CLAIMED', () => {
    expect(validateClaim('ach.kill.archer', 1, { 'kill.archer': 100 }, [1])).toEqual({
      ok: false,
      error: 'ALREADY_CLAIMED',
    });
  });

  it('threshold reached and not yet claimed → ok + tier coins', () => {
    expect(validateClaim('ach.kill.archer', 1, { 'kill.archer': 100 }, [])).toEqual({
      ok: true,
      coins: 50,
      tier: 1,
    });
    expect(validateClaim('ach.kill.archer', 3, { 'kill.archer': 2000 }, [1, 2])).toEqual({
      ok: true,
      coins: 200,
      tier: 3,
    });
  });
});

describe('sanitizePvpReportedStats (S9-6 L1 anomaly review)', () => {
  it('normal report: keeps reportable keys with non-zero values', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 3, 'kill.guard': 1, 'cast.meteor': 2 })).toEqual({
      'kill.archer': 3,
      'kill.guard': 1,
      'cast.meteor': 2,
    });
  });

  it('unknown / non-reportable keys dropped (does not reject entire payload): pvp.wins / campaign.* / junk', () => {
    expect(
      sanitizePvpReportedStats({ 'kill.archer': 5, 'pvp.wins': 99, 'campaign.chaptersCleared': 9, junk: 1 }),
    ).toEqual({ 'kill.archer': 5 });
  });

  it('zero values omitted (lazy creation)', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 0, 'cast.meteor': 4 })).toEqual({ 'cast.meteor': 4 });
  });

  it('missing / empty → empty delta', () => {
    expect(sanitizePvpReportedStats(undefined)).toEqual({});
    expect(sanitizePvpReportedStats({})).toEqual({});
  });

  it('L1 out-of-bounds → null (entire payload rejected)', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': PVP_STAT_MATCH_CAP['kill.archer']! + 1 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'cast.meteor': 99999 })).toBeNull();
  });

  it('exactly at hard boundary → accepted', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': PVP_STAT_MATCH_CAP['kill.archer']! })).toEqual({
      'kill.archer': PVP_STAT_MATCH_CAP['kill.archer'],
    });
  });

  it('non-integer / negative → null', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': -1 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'cast.meteor': 1.5 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'kill.guard': NaN })).toBeNull();
  });
});

describe('accrueStats (S9-6 server-side accumulation)', () => {
  it('lazy creation: empty delta → returns prev unchanged (including undefined)', () => {
    expect(accrueStats(undefined, {})).toBeUndefined();
    const prev = { 'kill.archer': 3 };
    expect(accrueStats(prev, {})).toBe(prev); // same reference, no new object instantiated
  });

  it('missing prev + delta → new stats', () => {
    expect(accrueStats(undefined, { 'pvp.wins': 1, 'kill.archer': 2 })).toEqual({
      'pvp.wins': 1,
      'kill.archer': 2,
    });
  });

  it('existing prev → accumulates per key, leaves untouched keys unchanged', () => {
    expect(
      accrueStats({ 'kill.archer': 10, 'pvp.wins': 5 }, { 'kill.archer': 3, 'cast.meteor': 1 }),
    ).toEqual({ 'kill.archer': 13, 'pvp.wins': 5, 'cast.meteor': 1 });
  });

  it('immutable: does not mutate prev', () => {
    const prev = { 'kill.archer': 10 };
    accrueStats(prev, { 'kill.archer': 5 });
    expect(prev['kill.archer']).toBe(10);
  });
});
