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
describe('RankId coverage', () => {
  it('RANK_TIERS covers every RankId used elsewhere', () => {
    const ids = RANK_TIERS.map((t) => t.id);
    const expected: RankId[] = [
      'bronze', 'silver', 'gold', 'platinum', 'diamond', 'star', 'master', 'grandmaster', 'king',
    ];
    expect(ids).toEqual(expected);
  });
});
