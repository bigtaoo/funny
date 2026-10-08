// Unit tests for ladder.ts: rank thresholds, ELO settlement (zero-sum), streak logic
// (ECONOMY_BALANCE.md §2.3). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  RANK_TIERS,
  INITIAL_ELO,
  ELO_K,
  BOT_ELO_K,
  BOT_ELO_THRESHOLD,
  STREAK_K_CAP,
  eloToRank,
  computeEloDelta,
  nextStreak,
  streakMultiplier,
  pickBotDifficulty,
  NEWBIE_PROTECT_GAMES,
  DAILY_PROTECT_GAMES,
  PROTECT_KIND_NEWBIE,
  PROTECT_KIND_DAILY,
  newbieProtectedGame,
  dailyProtectUsed,
  dailyProtectedGame,
  nextProtectSlot,
  consumeDailyProtect,
  protectedGamesLeft,
  applyLossProtection,
  type RankId,
} from '../src/ladder';

// ── RANK_TIERS invariants ─────────────────────────────────────────────────────────

describe('RANK_TIERS', () => {
  it('has 9 tiers', () => {
    expect(RANK_TIERS).toHaveLength(9);
  });

  it('thresholds ascend strictly', () => {
    for (let i = 1; i < RANK_TIERS.length; i++) {
      expect(RANK_TIERS[i]!.minElo).toBeGreaterThan(RANK_TIERS[i - 1]!.minElo);
    }
  });

  it('lowest tier starts at 0 so every ELO maps to a rank', () => {
    expect(RANK_TIERS[0]!.minElo).toBe(0);
  });

  it('has no duplicate rank ids', () => {
    const ids = RANK_TIERS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── eloToRank ─────────────────────────────────────────────────────────────────────

describe('eloToRank', () => {
  it('maps sub-zero / zero ELO to the lowest rank', () => {
    expect(eloToRank(-50)).toBe('bronze');
    expect(eloToRank(0)).toBe('bronze');
  });

  it('the initial ELO sits in bronze', () => {
    expect(eloToRank(INITIAL_ELO)).toBe('bronze');
  });

  it('a threshold value lands exactly on that rank (inclusive lower bound)', () => {
    for (const t of RANK_TIERS) {
      expect(eloToRank(t.minElo)).toBe(t.id);
    }
  });

  it('one below a threshold stays in the tier below', () => {
    expect(eloToRank(1199)).toBe('silver'); // 1200 is gold's floor
    expect(eloToRank(1200)).toBe('gold');
  });

  it('very high ELO maps to king', () => {
    expect(eloToRank(9999)).toBe('king');
  });
});

// ── computeEloDelta ───────────────────────────────────────────────────────────────

describe('computeEloDelta', () => {
  it('is zero-sum: loser delta = -winner delta', () => {
    const { winner, loser } = computeEloDelta(1500, 1400);
    expect(loser).toBe(-winner);
  });

  it('equal ratings split K evenly (±K/2)', () => {
    const { winner, loser } = computeEloDelta(1500, 1500);
    expect(winner).toBe(ELO_K / 2);
    expect(loser).toBe(-ELO_K / 2);
  });

  it('an upset (underdog wins) gains more than half K', () => {
    const { winner } = computeEloDelta(1200, 1800); // low-rated winner
    expect(winner).toBeGreaterThan(ELO_K / 2);
  });

  it('a favorite winning gains less than half K', () => {
    const { winner } = computeEloDelta(1800, 1200); // high-rated winner
    expect(winner).toBeLessThan(ELO_K / 2);
    expect(winner).toBeGreaterThan(0);
  });

  it('gain never exceeds K', () => {
    const { winner } = computeEloDelta(1, 3000);
    expect(winner).toBeLessThanOrEqual(ELO_K);
  });

  it('respects a custom K-factor (both sides)', () => {
    const { winner, loser } = computeEloDelta(1500, 1500, { winnerK: 16, loserK: 16 });
    expect(winner).toBe(8);
    expect(loser).toBe(-8);
  });

  it('respects the bot K-factor for onboarding calibration matches', () => {
    const { winner, loser } = computeEloDelta(1000, 1000, { winnerK: BOT_ELO_K, loserK: BOT_ELO_K });
    expect(winner).toBe(BOT_ELO_K / 2);
    expect(loser).toBe(-BOT_ELO_K / 2);
  });

  it('an asymmetric K (streak bonus on one side only) breaks zero-sum on purpose', () => {
    const { winner, loser } = computeEloDelta(1500, 1500, { winnerK: 48, loserK: 32 });
    expect(winner).toBe(24); // 48 * 0.5
    expect(loser).toBe(-16); // -(32 * 0.5)
    expect(loser).not.toBe(-winner);
  });

  it('returns integers', () => {
    const { winner, loser } = computeEloDelta(1537, 1489);
    expect(Number.isInteger(winner)).toBe(true);
    expect(Number.isInteger(loser)).toBe(true);
  });
});

// ── streakMultiplier ──────────────────────────────────────────────────────────────

describe('streakMultiplier', () => {
  it('no bonus for a fresh streak (0 or 1 consecutive result)', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(1)).toBe(1);
  });

  it('grows by STREAK_K_STEP per extra consecutive result', () => {
    expect(streakMultiplier(2)).toBeCloseTo(1.3);
    expect(streakMultiplier(3)).toBeCloseTo(1.6);
  });

  it('caps at STREAK_K_CAP for long streaks', () => {
    expect(streakMultiplier(20)).toBe(STREAK_K_CAP);
  });

  it('BOT_ELO_THRESHOLD matches the gold-rank floor (RANK_TIERS)', () => {
    expect(RANK_TIERS.find((t) => t.id === 'gold')?.minElo).toBe(BOT_ELO_THRESHOLD);
  });
});

// ── pickBotDifficulty ───────────────────────────────────────────────────────────

describe('pickBotDifficulty', () => {
  it('below BOT_ELO_THRESHOLD always rolls 1–6', () => {
    for (let i = 0; i < 6; i++) {
      expect(pickBotDifficulty(BOT_ELO_THRESHOLD - 1, () => i)).toBe(1 + i);
    }
  });

  it('at/above BOT_ELO_THRESHOLD always rolls 5–10', () => {
    for (let i = 0; i < 6; i++) {
      expect(pickBotDifficulty(BOT_ELO_THRESHOLD, () => i)).toBe(5 + i);
      expect(pickBotDifficulty(BOT_ELO_THRESHOLD + 500, () => i)).toBe(5 + i);
    }
  });

  it('defaults to Math.random-backed rolls within the correct band when randInt is omitted', () => {
    for (let i = 0; i < 50; i++) {
      const lowRoll = pickBotDifficulty(0);
      expect(lowRoll).toBeGreaterThanOrEqual(1);
      expect(lowRoll).toBeLessThanOrEqual(6);
      const highRoll = pickBotDifficulty(3000);
      expect(highRoll).toBeGreaterThanOrEqual(5);
      expect(highRoll).toBeLessThanOrEqual(10);
    }
  });
});

// ── nextStreak ────────────────────────────────────────────────────────────────────

describe('nextStreak', () => {
  it('a win starts a +1 streak from zero', () => {
    expect(nextStreak(0, true)).toBe(1);
  });

  it('a win extends an existing win streak', () => {
    expect(nextStreak(3, true)).toBe(4);
  });

  it('a win breaks a loss streak and resets to +1', () => {
    expect(nextStreak(-3, true)).toBe(1);
  });

  it('a loss starts a -1 streak from zero', () => {
    expect(nextStreak(0, false)).toBe(-1);
  });

  it('a loss extends an existing loss streak', () => {
    expect(nextStreak(-2, false)).toBe(-3);
  });

  it('a loss breaks a win streak and resets to -1', () => {
    expect(nextStreak(5, false)).toBe(-1);
  });
});

// cross-check: RankId union is exhaustively covered by RANK_TIERS
// ── ELO-loss protection: new-player + daily slots (2026-10-07) ─────────────────────

describe('newbieProtectedGame', () => {
  it('protects exactly the first NEWBIE_PROTECT_GAMES settled games, 1-based', () => {
    expect(NEWBIE_PROTECT_GAMES).toBe(3);
    expect(newbieProtectedGame(0)).toBe(1);
    expect(newbieProtectedGame(1)).toBe(2);
    expect(newbieProtectedGame(2)).toBe(3);
    expect(newbieProtectedGame(3)).toBe(0);
    expect(newbieProtectedGame(250)).toBe(0);
  });

  it('treats garbage counts defensively (negative -> fresh, non-finite -> unprotected)', () => {
    expect(newbieProtectedGame(-4)).toBe(1);
    expect(newbieProtectedGame(Number.NaN)).toBe(0);
    expect(newbieProtectedGame(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('daily protection counter', () => {
  const D1 = '2026-10-07';
  const D2 = '2026-10-08';

  it('counts only the stored day; another day (or no state) reads as 0 used', () => {
    expect(DAILY_PROTECT_GAMES).toBe(3);
    expect(dailyProtectUsed(undefined, D1)).toBe(0);
    expect(dailyProtectUsed({ dayKey: D1, used: 2 }, D1)).toBe(2);
    expect(dailyProtectUsed({ dayKey: D1, used: 3 }, D2)).toBe(0);
  });

  it('dailyProtectedGame is 1-based and 0 once the day is used up', () => {
    expect(dailyProtectedGame(undefined, D1)).toBe(1);
    expect(dailyProtectedGame({ dayKey: D1, used: 2 }, D1)).toBe(3);
    expect(dailyProtectedGame({ dayKey: D1, used: 3 }, D1)).toBe(0);
    expect(dailyProtectedGame({ dayKey: D1, used: 3 }, D2)).toBe(1);
  });

  it('treats a corrupt count as used up (never more than the pool)', () => {
    expect(dailyProtectedGame({ dayKey: D1, used: Number.NaN }, D1)).toBe(0);
    expect(dailyProtectedGame({ dayKey: D1, used: -2 }, D1)).toBe(1);
  });
});

describe('nextProtectSlot / consumeDailyProtect', () => {
  const D1 = '2026-10-07';
  const D2 = '2026-10-08';

  it('new-player slots come first and do not touch the daily counter', () => {
    const slot = nextProtectSlot(0, undefined, D1);
    expect(slot).toEqual({ kind: PROTECT_KIND_NEWBIE, game: 1, total: NEWBIE_PROTECT_GAMES });
    expect(consumeDailyProtect(undefined, D1, slot)).toBeUndefined();
    const prev = { dayKey: D1, used: 1 };
    expect(consumeDailyProtect(prev, D1, nextProtectSlot(2, prev, D1))).toBe(prev);
  });

  it('a new account plays 1-3 new-player, 4-6 daily, 7+ unprotected on its first day; day 2 resets the daily pool', () => {
    let daily: { dayKey: string; used: number } | undefined;
    const kinds: Array<string> = [];
    for (let settled = 0; settled < 7; settled++) {
      const slot = nextProtectSlot(settled, daily, D1);
      kinds.push(slot ? `${slot.kind}:${slot.game}/${slot.total}` : 'none');
      daily = consumeDailyProtect(daily, D1, slot);
    }
    expect(kinds).toEqual(['1:1/3', '1:2/3', '1:3/3', '2:1/3', '2:2/3', '2:3/3', 'none']);
    expect(daily).toEqual({ dayKey: D1, used: 3 });
    // Next day: three daily slots again (lazy reset), the new-player pool stays spent.
    const slot = nextProtectSlot(7, daily, D2);
    expect(slot).toEqual({ kind: PROTECT_KIND_DAILY, game: 1, total: DAILY_PROTECT_GAMES });
    expect(consumeDailyProtect(daily, D2, slot)).toEqual({ dayKey: D2, used: 1 });
  });

  it('an unprotected game leaves the counter as it was', () => {
    const spent = { dayKey: D1, used: 3 };
    const slot = nextProtectSlot(40, spent, D1);
    expect(slot).toBeNull();
    expect(consumeDailyProtect(spent, D1, slot)).toBe(spent);
  });
});

describe('protectedGamesLeft', () => {
  const D1 = '2026-10-07';
  it('adds the new-player slots left to the daily slots left', () => {
    expect(protectedGamesLeft(0, undefined, D1)).toBe(6);
    expect(protectedGamesLeft(2, undefined, D1)).toBe(4);
    expect(protectedGamesLeft(3, { dayKey: D1, used: 1 }, D1)).toBe(2);
    expect(protectedGamesLeft(50, { dayKey: D1, used: 3 }, D1)).toBe(0);
    expect(protectedGamesLeft(50, { dayKey: '2026-10-06', used: 3 }, D1)).toBe(3);
  });
});

describe('applyLossProtection', () => {
  it('a protected loss costs nothing and does not start a losing streak', () => {
    expect(applyLossProtection(-16, 0, false, true)).toEqual({ delta: 0, streak: 0 });
  });

  it('a protected loss breaks a win streak but never extends a losing streak', () => {
    expect(applyLossProtection(-16, 2, false, true)).toEqual({ delta: 0, streak: 0 });
    // A pre-existing loss streak (e.g. yesterday's skid) is frozen, not deepened.
    expect(applyLossProtection(-20, -1, false, true)).toEqual({ delta: 0, streak: -1 });
  });

  it('a protected win settles normally (delta + streak)', () => {
    expect(applyLossProtection(16, 0, true, true)).toEqual({ delta: 16, streak: 1 });
    expect(applyLossProtection(21, 2, true, true)).toEqual({ delta: 21, streak: 3 });
  });

  it('an unprotected loss settles exactly like nextStreak / the raw delta', () => {
    expect(applyLossProtection(-16, -2, false, false)).toEqual({ delta: -16, streak: nextStreak(-2, false) });
    expect(applyLossProtection(-16, 3, false, false)).toEqual({ delta: -16, streak: -1 });
  });

  it('never returns -0 for a protected loss', () => {
    expect(Object.is(applyLossProtection(-1, 0, false, true).delta, 0)).toBe(true);
  });
});

describe('RankId coverage', () => {
  it('RANK_TIERS covers every RankId used elsewhere', () => {
    const ids = RANK_TIERS.map((t) => t.id);
    const expected: RankId[] = [
      'bronze', 'silver', 'gold', 'platinum', 'diamond', 'star', 'master', 'grandmaster', 'king',
    ];
    expect(ids).toEqual(expected);
  });
});
