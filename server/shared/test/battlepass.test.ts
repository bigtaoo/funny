// Unit tests for battlepass.ts: level table invariants, xp↔level math, claim validation, cross-season catch-up
// (SEASON_DESIGN.md §C). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  BATTLEPASS_MAX_LEVEL,
  BP_XP_PER_LEVEL,
  BATTLEPASS_DEFS,
  xpToLevel,
  xpToNextLevel,
  makeFreshBattlePass,
  claimBpReward,
  pendingBpRewards,
  type BattlePassData,
} from '../src/battlepass';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function bp(overrides: Partial<BattlePassData> = {}): BattlePassData {
  return { ...makeFreshBattlePass(1), ...overrides };
}

// ── BATTLEPASS_DEFS table invariants ──────────────────────────────────────────────

describe('BATTLEPASS_DEFS', () => {
  it('has exactly MAX_LEVEL entries', () => {
    expect(BATTLEPASS_DEFS).toHaveLength(BATTLEPASS_MAX_LEVEL);
  });

  it('levels are 1..MAX in order', () => {
    BATTLEPASS_DEFS.forEach((d, i) => expect(d.level).toBe(i + 1));
  });

  it('xpRequired is strictly increasing', () => {
    for (let i = 1; i < BATTLEPASS_DEFS.length; i++) {
      expect(BATTLEPASS_DEFS[i]!.xpRequired).toBeGreaterThan(BATTLEPASS_DEFS[i - 1]!.xpRequired);
    }
  });

  it('xpRequired = level * BP_XP_PER_LEVEL', () => {
    for (const d of BATTLEPASS_DEFS) {
      expect(d.xpRequired).toBe(d.level * BP_XP_PER_LEVEL);
    }
  });

  it('every level has both a free and a paid reward', () => {
    for (const d of BATTLEPASS_DEFS) {
      expect(d.free).toBeDefined();
      expect(d.paid).toBeDefined();
    }
  });

  it('every reward has a positive count', () => {
    for (const d of BATTLEPASS_DEFS) {
      expect(d.free!.count).toBeGreaterThan(0);
      expect(d.paid!.count).toBeGreaterThan(0);
    }
  });

  it('material rewards carry an id; coin rewards do not require one', () => {
    for (const d of BATTLEPASS_DEFS) {
      for (const r of [d.free!, d.paid!]) {
        if (r.kind === 'material' || r.kind === 'skin') expect(r.id).toBeTruthy();
      }
    }
  });

  it('milestone levels 10/20/30 award coins on both tracks', () => {
    for (const lvl of [10, 20, 30]) {
      const d = BATTLEPASS_DEFS[lvl - 1]!;
      expect(d.free!.kind).toBe('coins');
      expect(d.paid!.kind).toBe('coins');
    }
  });

  it('level 30 is the biggest paid payout', () => {
    const l30 = BATTLEPASS_DEFS[29]!;
    expect(l30.paid!.kind).toBe('coins');
    expect(l30.paid!.count).toBe(520);
    const others = BATTLEPASS_DEFS.slice(0, 29).map((d) => d.paid!.count);
    expect(Math.max(...others)).toBeLessThan(l30.paid!.count);
  });

  it('free-track coin total stays under one 10-pull (1,350 coins, §13.3 cap)', () => {
    const freeCoins = BATTLEPASS_DEFS
      .filter((d) => d.free!.kind === 'coins')
      .reduce((s, d) => s + d.free!.count, 0);
    expect(freeCoins).toBe(960);
    expect(freeCoins).toBeLessThan(1350);
  });
});

// ── xpToLevel ─────────────────────────────────────────────────────────────────────

describe('xpToLevel', () => {
  it('0 xp is level 1', () => {
    expect(xpToLevel(0)).toBe(1);
  });

  it('just below one level worth of xp is still level 1', () => {
    expect(xpToLevel(BP_XP_PER_LEVEL - 1)).toBe(1);
  });

  it('exactly one level worth of xp is level 2', () => {
    expect(xpToLevel(BP_XP_PER_LEVEL)).toBe(2);
  });

  it('caps at MAX_LEVEL even with huge xp', () => {
    expect(xpToLevel(BP_XP_PER_LEVEL * 999)).toBe(BATTLEPASS_MAX_LEVEL);
  });

  it('never returns below 1 for negative xp', () => {
    expect(xpToLevel(-100)).toBe(1);
  });
});

// ── xpToNextLevel ─────────────────────────────────────────────────────────────────

describe('xpToNextLevel', () => {
  it('at 0 xp needs a full level to advance', () => {
    expect(xpToNextLevel(0)).toBe(BP_XP_PER_LEVEL);
  });

  it('mid-level returns the remaining amount', () => {
    expect(xpToNextLevel(BP_XP_PER_LEVEL + 100)).toBe(BP_XP_PER_LEVEL - 100);
  });

  it('returns 0 once max level xp is reached', () => {
    expect(xpToNextLevel(BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL)).toBe(0);
    expect(xpToNextLevel(BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL + 5000)).toBe(0);
  });
});

// ── makeFreshBattlePass ───────────────────────────────────────────────────────────

describe('makeFreshBattlePass', () => {
  it('starts empty at the given season', () => {
    const fresh = makeFreshBattlePass(7);
    expect(fresh).toEqual({ seasonNo: 7, xp: 0, level: 1, hasPass: false, claimedFree: [], claimedPaid: [] });
  });
});

// ── claimBpReward ─────────────────────────────────────────────────────────────────

describe('claimBpReward', () => {
  it('rejects out-of-range levels', () => {
    expect(claimBpReward(bp({ level: 5 }), 'free', 0)).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(claimBpReward(bp({ level: 5 }), 'free', BATTLEPASS_MAX_LEVEL + 1)).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
  });

  it('rejects a level not yet reached', () => {
    expect(claimBpReward(bp({ level: 3 }), 'free', 4)).toEqual({ ok: false, error: 'NOT_REACHED' });
  });

  it('claims a free reward and records the level', () => {
    const res = claimBpReward(bp({ level: 5 }), 'free', 3);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reward).toEqual(BATTLEPASS_DEFS[2]!.free);
      expect(res.bp.claimedFree).toEqual([3]);
    }
  });

  it('does not mutate the input battlePass', () => {
    const original = bp({ level: 5 });
    claimBpReward(original, 'free', 3);
    expect(original.claimedFree).toEqual([]);
  });

  it('rejects double claim of the same free level', () => {
    const res = claimBpReward(bp({ level: 5, claimedFree: [3] }), 'free', 3);
    expect(res).toEqual({ ok: false, error: 'ALREADY_CLAIMED' });
  });

  it('rejects paid claim without a pass', () => {
    const res = claimBpReward(bp({ level: 5, hasPass: false }), 'paid', 3);
    expect(res).toEqual({ ok: false, error: 'PASS_REQUIRED' });
  });

  it('claims a paid reward when a pass is owned', () => {
    const res = claimBpReward(bp({ level: 5, hasPass: true }), 'paid', 3);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bp.claimedPaid).toEqual([3]);
  });

  it('free and paid claims are tracked independently', () => {
    let state = bp({ level: 10, hasPass: true });
    const free = claimBpReward(state, 'free', 5);
    expect(free.ok).toBe(true);
    if (free.ok) state = free.bp;
    const paid = claimBpReward(state, 'paid', 5);
    expect(paid.ok).toBe(true);
    if (paid.ok) {
      expect(paid.bp.claimedFree).toEqual([5]);
      expect(paid.bp.claimedPaid).toEqual([5]);
    }
  });
});

// ── pendingBpRewards (cross-season catch-up) ──────────────────────────────────────

describe('pendingBpRewards', () => {
  it('returns nothing for a fresh pass at level 1 that already claimed level 1 free', () => {
    // level 1 is reached, its free reward is still unclaimed → one pending entry
    const pending = pendingBpRewards(bp({ level: 1 }));
    expect(pending).toEqual([{ track: 'free', level: 1, reward: BATTLEPASS_DEFS[0]!.free }]);
  });

  it('excludes levels above the reached level', () => {
    const pending = pendingBpRewards(bp({ level: 3 }));
    expect(pending.every((p) => p.level <= 3)).toBe(true);
  });

  it('omits paid rewards without a pass', () => {
    const pending = pendingBpRewards(bp({ level: 5, hasPass: false }));
    expect(pending.every((p) => p.track === 'free')).toBe(true);
  });

  it('includes paid rewards when a pass is owned', () => {
    const pending = pendingBpRewards(bp({ level: 5, hasPass: true }));
    expect(pending.some((p) => p.track === 'paid')).toBe(true);
  });

  it('skips already-claimed levels', () => {
    const pending = pendingBpRewards(bp({ level: 3, claimedFree: [1, 2] }));
    expect(pending.filter((p) => p.track === 'free').map((p) => p.level)).toEqual([3]);
  });

  it('returns empty when everything reached is already claimed', () => {
    const pending = pendingBpRewards(bp({ level: 2, claimedFree: [1, 2] }));
    expect(pending).toEqual([]);
  });
});
