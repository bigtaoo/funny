// Unit tests for achievements.ts: tier-table integrity, tier-state derivation, one-time claim validation,
// PvP stat sanitization / accumulation (ACHIEVEMENT_DESIGN.md §3/§4). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS,
  findAchievement,
  tierState,
  hasClaimable,
  validateClaim,
  sanitizePvpReportedStats,
  accrueStats,
  PVP_REPORTED_STAT_KEYS,
  PVP_STAT_MATCH_CAP,
  type StatKey,
} from '../src/achievements';
import type { SaveData } from '../src/types';

type Stats = SaveData['stats'];
const stats = (o: Record<string, number>): Stats => o as Stats;

// ── table integrity ───────────────────────────────────────────────────────────────

describe('ACHIEVEMENTS table', () => {
  it('has unique ids', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every achievement has at least one tier', () => {
    for (const a of ACHIEVEMENTS) expect(a.tiers.length).toBeGreaterThan(0);
  });

  it('tier thresholds are strictly increasing within each achievement', () => {
    for (const a of ACHIEVEMENTS) {
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i]!.threshold).toBeGreaterThan(a.tiers[i - 1]!.threshold);
      }
    }
  });

  it('tier coin rewards are non-decreasing (later tiers pay at least as much)', () => {
    for (const a of ACHIEVEMENTS) {
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i]!.coins).toBeGreaterThanOrEqual(a.tiers[i - 1]!.coins);
      }
    }
  });

  it('all coin rewards are positive', () => {
    for (const a of ACHIEVEMENTS) for (const t of a.tiers) expect(t.coins).toBeGreaterThan(0);
  });

  it('findAchievement resolves known / misses unknown', () => {
    expect(findAchievement('ach.pvp.wins')?.statKey).toBe('pvp.wins');
    expect(findAchievement('nope')).toBeUndefined();
  });
});

// ── tierState ─────────────────────────────────────────────────────────────────────

describe('tierState', () => {
  const def = findAchievement('ach.kill.archer')!; // thresholds 100/500/2000

  it('marks reached tiers below the current stat', () => {
    const st = tierState(def, stats({ 'kill.archer': 600 }), []);
    expect(st[0]!.reached).toBe(true); // 100
    expect(st[1]!.reached).toBe(true); // 500
    expect(st[2]!.reached).toBe(false); // 2000
  });

  it('claimable = reached and not claimed', () => {
    const st = tierState(def, stats({ 'kill.archer': 600 }), [1]);
    expect(st[0]!.claimable).toBe(false); // reached but claimed
    expect(st[0]!.claimed).toBe(true);
    expect(st[1]!.claimable).toBe(true); // reached, not claimed
  });

  it('progress bar is clamped at the threshold', () => {
    const st = tierState(def, stats({ 'kill.archer': 999999 }), []);
    expect(st[0]!.progress).toBe(100);
    expect(st[2]!.progress).toBe(2000);
  });

  it('treats a missing stat as 0', () => {
    const st = tierState(def, stats({}), []);
    expect(st.every((s) => !s.reached)).toBe(true);
    expect(st[0]!.progress).toBe(0);
  });
});

// ── hasClaimable ──────────────────────────────────────────────────────────────────

describe('hasClaimable', () => {
  it('false when nothing is reached', () => {
    expect(hasClaimable(stats({}), {} as SaveData['achievements'])).toBe(false);
  });

  it('true when a reached tier is unclaimed', () => {
    expect(
      hasClaimable(stats({ 'kill.archer': 150 }), {} as SaveData['achievements']),
    ).toBe(true);
  });

  it('false once the reached tier is claimed', () => {
    const ach = { 'ach.kill.archer': { claimedTiers: [1] } } as unknown as SaveData['achievements'];
    expect(hasClaimable(stats({ 'kill.archer': 150 }), ach)).toBe(false);
  });
});

// ── validateClaim ─────────────────────────────────────────────────────────────────

describe('validateClaim', () => {
  it('rejects an unknown achievement', () => {
    expect(validateClaim('nope', 1, stats({}), [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  it('rejects an out-of-range or non-integer tier', () => {
    expect(validateClaim('ach.kill.archer', 0, stats({}), [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(validateClaim('ach.kill.archer', 99, stats({}), [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(validateClaim('ach.kill.archer', 1.5, stats({}), [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  it('rejects when the threshold is not reached', () => {
    expect(validateClaim('ach.kill.archer', 1, stats({ 'kill.archer': 50 }), [])).toEqual({
      ok: false,
      error: 'NOT_REACHED',
    });
  });

  it('rejects a double claim', () => {
    expect(validateClaim('ach.kill.archer', 1, stats({ 'kill.archer': 150 }), [1])).toEqual({
      ok: false,
      error: 'ALREADY_CLAIMED',
    });
  });

  it('grants the tier coins on a valid claim', () => {
    expect(validateClaim('ach.kill.archer', 1, stats({ 'kill.archer': 150 }), [])).toEqual({
      ok: true,
      coins: 50,
      tier: 1,
    });
  });
});

// ── sanitizePvpReportedStats ──────────────────────────────────────────────────────

describe('sanitizePvpReportedStats', () => {
  it('returns empty object for undefined input', () => {
    expect(sanitizePvpReportedStats(undefined)).toEqual({});
  });

  it('drops unknown keys without rejecting the report', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 5, 'unknown.key': 999 })).toEqual({ 'kill.archer': 5 });
  });

  it('never reports pvp.wins (server-computed) even if supplied', () => {
    expect(sanitizePvpReportedStats({ 'pvp.wins': 3 })).toEqual({});
    expect(PVP_REPORTED_STAT_KEYS).not.toContain('pvp.wins' as StatKey);
  });

  it('omits zero values (lazy creation)', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 0 })).toEqual({});
  });

  it('rejects (null) a negative or non-integer known key', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': -1 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'kill.archer': 1.5 })).toBeNull();
  });

  it('rejects (null) when a known key exceeds the L1 cap', () => {
    const cap = PVP_STAT_MATCH_CAP['kill.archer']!;
    expect(sanitizePvpReportedStats({ 'kill.archer': cap + 1 })).toBeNull();
  });

  it('accepts a value exactly at the cap', () => {
    const cap = PVP_STAT_MATCH_CAP['kill.archer']!;
    expect(sanitizePvpReportedStats({ 'kill.archer': cap })).toEqual({ 'kill.archer': cap });
  });
});

// ── accrueStats ───────────────────────────────────────────────────────────────────

describe('accrueStats', () => {
  it('returns prev unchanged (same reference) for an empty delta', () => {
    const prev = stats({ 'kill.archer': 5 });
    expect(accrueStats(prev, {})).toBe(prev);
  });

  it('adds a delta to an existing key', () => {
    expect(accrueStats(stats({ 'kill.archer': 5 }), { 'kill.archer': 3 })).toEqual({ 'kill.archer': 8 });
  });

  it('creates a key from a missing base', () => {
    expect(accrueStats(stats({}), { 'cast.meteor': 2 })).toEqual({ 'cast.meteor': 2 });
  });

  it('handles an undefined prev', () => {
    expect(accrueStats(undefined as unknown as Stats, { 'pvp.wins': 1 })).toEqual({ 'pvp.wins': 1 });
  });

  it('does not mutate the input', () => {
    const prev = stats({ 'kill.archer': 5 });
    accrueStats(prev, { 'kill.archer': 3 });
    expect(prev).toEqual({ 'kill.archer': 5 });
  });
});
