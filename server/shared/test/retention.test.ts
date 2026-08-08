// Unit tests for retention.ts: UTC time keys, calendar/daily reward tables, lazy stale reset, state derivation,
// idempotent accrual + one-per-day claim logic (RETENTION_DESIGN.md §3/§4). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  makeDayKey,
  makeMonthKey,
  makeWeekKey,
  CHECKIN_REWARDS,
  CHECKIN_TOTAL_DAYS,
  CHECKIN_MILESTONE_DAYS,
  DAILY_TASKS,
  DAILY_POINTS_THRESHOLD,
  DAILY_COINS_REWARD,
  WEEKLY_CHEST_TIERS,
  resetStaleRetention,
  checkinClaimedCount,
  nextCheckinDay,
  dailyTaskPoints,
  isDailyTaskDone,
  dailyRewardClaimable,
  weeklyPoints,
  weeklyClaimableTiers,
  accrueRetentionTask,
  claimCheckinDay,
  claimDailyReward,
  claimWeeklyTier,
  type RetentionSave,
} from '../src/retention';

// Fixed timestamps (UTC). Using explicit epoch ms keeps these deterministic across machines.
const T_JUN22 = Date.parse('2026-06-22T10:00:00Z');
const T_JUN22_LATE = Date.parse('2026-06-22T23:30:00Z');
const T_JUN23 = Date.parse('2026-06-23T01:00:00Z');
const T_JUL01 = Date.parse('2026-07-01T00:00:00Z');
// 2026-06-22 (Mon) / 2026-06-23 (Tue) / 2026-06-28 (Sun) all fall in ISO week 2026-W26;
// 2026-06-29 (Mon) is the first day of the next ISO week (2026-W27).
const T_JUN24 = Date.parse('2026-06-24T01:00:00Z');
const T_JUN25 = Date.parse('2026-06-25T01:00:00Z');
const T_JUN26 = Date.parse('2026-06-26T01:00:00Z');
const T_JUN27 = Date.parse('2026-06-27T01:00:00Z');
const T_JUN28_SAME_WEEK = Date.parse('2026-06-28T23:00:00Z');
const T_JUN29_NEXT_WEEK = Date.parse('2026-06-29T01:00:00Z');
// All 7 days of ISO week 2026-W26 (Mon..Sun) — 7 × 3 = 21 raw points, exactly the top tier.
const WEEK26_ALL_DAYS = [T_JUN22, T_JUN23, T_JUN24, T_JUN25, T_JUN26, T_JUN27, T_JUN28_SAME_WEEK];

// ── time keys ─────────────────────────────────────────────────────────────────────

describe('time keys', () => {
  it('day key is YYYY-MM-DD in UTC', () => {
    expect(makeDayKey(T_JUN22)).toBe('2026-06-22');
    expect(makeDayKey(T_JUN22_LATE)).toBe('2026-06-22'); // same UTC day late in the day
  });

  it('month key is YYYY-MM in UTC', () => {
    expect(makeMonthKey(T_JUN22)).toBe('2026-06');
    expect(makeMonthKey(T_JUL01)).toBe('2026-07');
  });
});

// ── reward tables ─────────────────────────────────────────────────────────────────

describe('CHECKIN_REWARDS', () => {
  it('has exactly CHECKIN_TOTAL_DAYS slots', () => {
    expect(CHECKIN_REWARDS).toHaveLength(CHECKIN_TOTAL_DAYS);
  });

  it('every slot has a positive count', () => {
    for (const r of CHECKIN_REWARDS) expect(r.count).toBeGreaterThan(0);
  });

  it('milestone days are the enriched "big" slots (never plain coins)', () => {
    for (const day of CHECKIN_MILESTONE_DAYS) {
      expect(CHECKIN_REWARDS[day - 1]!.kind).not.toBe('coins');
    }
  });

  it('checkin\'s primary reward never uses the plain "coins" kind (R1: not a new bulk coin faucet)', () => {
    expect(CHECKIN_REWARDS.some((r) => r.kind === 'coins')).toBe(false);
  });

  it('no slot grants stamina (2026-08-01: stamina caps at 120 and regens fast, so a flat grant was routinely wasted overflow, not a felt reward — replaced with materials/bonusCoins)', () => {
    expect(CHECKIN_REWARDS.some((r) => r.kind === 'stamina')).toBe(false);
  });

  it('spreads materials across the whole month, not just milestones', () => {
    const materialDays = CHECKIN_REWARDS.filter((r) => r.kind === 'material');
    expect(materialDays.length).toBeGreaterThanOrEqual(6);
    for (const r of materialDays) expect(r.id).toMatch(/^(scrap|lead|binding)$/);
  });

  it('day 7/14/21/30 are material pack / card pack / material pack / equipment finale', () => {
    expect(CHECKIN_REWARDS[6]!.kind).toBe('material');
    expect(CHECKIN_REWARDS[13]!.kind).toBe('card');
    expect(CHECKIN_REWARDS[20]!.kind).toBe('material');
    expect(CHECKIN_REWARDS[29]!.kind).toBe('equipment');
  });

  it('milestone days each carry a small bonusCoins top-up (R1b, 2026-08-01), summing to 200/month', () => {
    const milestoneRewards = CHECKIN_MILESTONE_DAYS.map((day) => CHECKIN_REWARDS[day - 1]!);
    expect(milestoneRewards.map((r) => r.bonusCoins)).toEqual([30, 40, 50, 80]);
    const total = milestoneRewards.reduce((s, r) => s + (r.bonusCoins ?? 0), 0);
    expect(total).toBe(200);
  });

  it('non-milestone days never carry bonusCoins', () => {
    const milestoneIdx = new Set(CHECKIN_MILESTONE_DAYS.map((d) => d - 1));
    CHECKIN_REWARDS.forEach((r, i) => {
      if (!milestoneIdx.has(i)) expect(r.bonusCoins).toBeUndefined();
    });
  });
});

describe('DAILY_TASKS', () => {
  it('task ids are unique', () => {
    const ids = DAILY_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the sum of task points meets the daily threshold', () => {
    const sum = DAILY_TASKS.reduce((s, t) => s + t.points, 0);
    expect(sum).toBe(DAILY_POINTS_THRESHOLD);
  });
});

// ── resetStaleRetention ───────────────────────────────────────────────────────────

describe('resetStaleRetention', () => {
  it('returns the same reference when nothing is stale', () => {
    const r: RetentionSave = { checkin: { monthKey: '2026-06', claimedDays: [1] } };
    expect(resetStaleRetention(r, T_JUN22)).toBe(r);
  });

  it('drops a checkin block from a previous month', () => {
    const r: RetentionSave = { checkin: { monthKey: '2026-05', claimedDays: [1, 2] } };
    expect(resetStaleRetention(r, T_JUN22).checkin).toBeUndefined();
  });

  it('drops a daily block from a previous day but keeps a current checkin', () => {
    const r: RetentionSave = {
      checkin: { monthKey: '2026-06', claimedDays: [1] },
      daily: { dayKey: '2026-06-21', completedTasks: {}, taskPoints: 0, rewardClaimed: false },
    };
    const out = resetStaleRetention(r, T_JUN22);
    expect(out.daily).toBeUndefined();
    expect(out.checkin).toBeDefined();
  });

  it('handles undefined input', () => {
    expect(resetStaleRetention(undefined, T_JUN22)).toEqual({});
  });
});

// ── checkin derivation ────────────────────────────────────────────────────────────

describe('checkin state', () => {
  it('claimed count is 0 for a stale month', () => {
    const r: RetentionSave = { checkin: { monthKey: '2026-05', claimedDays: [1, 2, 3] } };
    expect(checkinClaimedCount(r, T_JUN22)).toBe(0);
  });

  it('claimed count reflects the current month', () => {
    const r: RetentionSave = { checkin: { monthKey: '2026-06', claimedDays: [1, 2] } };
    expect(checkinClaimedCount(r, T_JUN22)).toBe(2);
  });

  it('nextCheckinDay is slot 1 for a fresh player', () => {
    expect(nextCheckinDay(undefined, T_JUN22)).toBe(1);
  });

  it('nextCheckinDay is null once claimed today', () => {
    const r: RetentionSave = {
      checkin: { monthKey: '2026-06', claimedDays: [1], lastClaimedDayKey: '2026-06-22' },
    };
    expect(nextCheckinDay(r, T_JUN22)).toBeNull();
  });

  it('nextCheckinDay advances the day after a claim (one slot per real day)', () => {
    const r: RetentionSave = {
      checkin: { monthKey: '2026-06', claimedDays: [1], lastClaimedDayKey: '2026-06-22' },
    };
    expect(nextCheckinDay(r, T_JUN23)).toBe(2);
  });

  it('nextCheckinDay is null when the month is full', () => {
    const claimedDays = Array.from({ length: CHECKIN_TOTAL_DAYS }, (_, i) => i + 1);
    const r: RetentionSave = { checkin: { monthKey: '2026-06', claimedDays } };
    expect(nextCheckinDay(r, T_JUN22)).toBeNull();
  });
});

// ── claimCheckinDay ───────────────────────────────────────────────────────────────

describe('claimCheckinDay', () => {
  it('claims slot 1 for a fresh player and records the day', () => {
    const res = claimCheckinDay(undefined, T_JUN22);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.day).toBe(1);
      expect(res.reward).toEqual(CHECKIN_REWARDS[0]);
      expect(res.newCheckin.claimedDays).toEqual([1]);
      expect(res.newCheckin.lastClaimedDayKey).toBe('2026-06-22');
    }
  });

  it('rejects a second claim on the same day', () => {
    const first = claimCheckinDay(undefined, T_JUN22);
    if (!first.ok) throw new Error('setup failed');
    const second = claimCheckinDay({ checkin: first.newCheckin }, T_JUN22);
    expect(second).toEqual({ ok: false, error: 'ALREADY_CLAIMED_TODAY' });
  });

  it('allows the next slot on the following day', () => {
    const first = claimCheckinDay(undefined, T_JUN22);
    if (!first.ok) throw new Error('setup failed');
    const second = claimCheckinDay({ checkin: first.newCheckin }, T_JUN23);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.day).toBe(2);
  });

  it('rejects when the month is full', () => {
    const claimedDays = Array.from({ length: CHECKIN_TOTAL_DAYS }, (_, i) => i + 1);
    const r: RetentionSave = { checkin: { monthKey: '2026-06', claimedDays } };
    expect(claimCheckinDay(r, T_JUN22)).toEqual({ ok: false, error: 'MONTH_FULL' });
  });
});

// ── daily tasks ───────────────────────────────────────────────────────────────────

describe('accrueRetentionTask', () => {
  it('adds points for a valid task', () => {
    const out = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    expect(dailyTaskPoints(out, T_JUN22)).toBe(1);
    expect(isDailyTaskDone(out, 'pve.clear', T_JUN22)).toBe(true);
  });

  it('is idempotent: repeating a task adds nothing and returns the same reference', () => {
    const once = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    const twice = accrueRetentionTask(once, 'pve.clear', T_JUN22);
    expect(twice).toBe(once);
  });

  it('caps accumulated points at the threshold', () => {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = accrueRetentionTask(r, 'pvp.match', T_JUN22);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN22);
    expect(dailyTaskPoints(r, T_JUN22)).toBe(DAILY_POINTS_THRESHOLD);
  });

  it('ignores an unknown task id', () => {
    const r = accrueRetentionTask(undefined, 'nope' as never, T_JUN22);
    expect(r).toBeUndefined();
  });
});

describe('dailyRewardClaimable / claimDailyReward', () => {
  function fullDay(): RetentionSave {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = accrueRetentionTask(r, 'pvp.match', T_JUN22);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN22);
    return r!;
  }

  it('not claimable before the threshold', () => {
    const r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    expect(dailyRewardClaimable(r, T_JUN22)).toBe(false);
    expect(claimDailyReward(r, T_JUN22)).toEqual({ ok: false, error: 'NOT_REACHED' });
  });

  it('claimable once the threshold is reached', () => {
    const r = fullDay();
    expect(dailyRewardClaimable(r, T_JUN22)).toBe(true);
    expect(claimDailyReward(r, T_JUN22)).toEqual({ ok: true, coins: DAILY_COINS_REWARD });
  });

  it('rejects a wrong-day claim', () => {
    const r = fullDay();
    expect(claimDailyReward(r, T_JUN23)).toEqual({ ok: false, error: 'WRONG_DAY' });
  });

  it('rejects a double claim', () => {
    const r = fullDay();
    r.daily!.rewardClaimed = true;
    expect(claimDailyReward(r, T_JUN22)).toEqual({ ok: false, error: 'ALREADY_CLAIMED' });
    expect(dailyRewardClaimable(r, T_JUN22)).toBe(false);
  });
});

// ── weekly active chest (§12.3) ──────────────────────────────────────────────────────────

describe('makeWeekKey', () => {
  it('groups Mon..Sun into the same ISO week', () => {
    expect(makeWeekKey(T_JUN22)).toBe(makeWeekKey(T_JUN23));
    expect(makeWeekKey(T_JUN22)).toBe(makeWeekKey(T_JUN28_SAME_WEEK));
  });

  it('the following Monday is a different ISO week', () => {
    expect(makeWeekKey(T_JUN29_NEXT_WEEK)).not.toBe(makeWeekKey(T_JUN22));
  });
});

describe('accrueRetentionTask — weekly tally alongside the daily one', () => {
  it('one task completion bumps both daily.taskPoints and weekly.points by the same amount', () => {
    const r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    expect(r!.daily!.taskPoints).toBe(1);
    expect(r!.weekly!.points).toBe(1);
    expect(r!.weekly!.weekKey).toBe(makeWeekKey(T_JUN22));
  });

  it('accumulates across multiple days within the same week, unlike the daily bucket which resets', () => {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = accrueRetentionTask(r, 'pvp.match', T_JUN22);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN22); // day 1 full: daily=3, weekly=3
    r = accrueRetentionTask(r, 'pve.clear', T_JUN23);  // day 2: daily resets to 0 then +1, weekly keeps accumulating
    expect(r!.daily!.taskPoints).toBe(1);
    expect(r!.weekly!.points).toBe(4);
  });

  it('a full 7-day week lands exactly on the top chest tier, never over (cap math sanity check)', () => {
    // 7 days × DAILY_TASKS.length tasks is the maximum a real week can ever accrue under the
    // current task economy — this is really a forward-compat guard (topTier currently equals
    // that natural maximum exactly) in case DAILY_TASKS point values change later.
    let r: RetentionSave | undefined;
    const topTier = WEEKLY_CHEST_TIERS[WEEKLY_CHEST_TIERS.length - 1]!.threshold;
    for (const day of WEEK26_ALL_DAYS) {
      for (const task of DAILY_TASKS) {
        r = accrueRetentionTask(r, task.id, day);
      }
    }
    expect(r!.weekly!.points).toBe(topTier);
  });

  it('does not double-count a task already completed today (same idempotency guard as the daily bucket)', () => {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = accrueRetentionTask(r, 'pve.clear', T_JUN22); // repeat, same day
    expect(r!.weekly!.points).toBe(1);
  });

  it('resets the weekly bucket on a new ISO week, independent of the monthly/daily reset', () => {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = resetStaleRetention(r, T_JUN29_NEXT_WEEK);
    expect(r.weekly).toBeUndefined();
  });
});

describe('weeklyPoints / weeklyClaimableTiers', () => {
  it('0 points when nothing recorded / stale', () => {
    expect(weeklyPoints(undefined, T_JUN22)).toBe(0);
    const r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    expect(weeklyPoints(r, T_JUN29_NEXT_WEEK)).toBe(0); // different week → stale
  });

  it('no tiers claimable below the first threshold', () => {
    const r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    expect(weeklyClaimableTiers(r, T_JUN22)).toEqual([]);
  });

  it('lists every threshold reached, in ascending order, once points clear them', () => {
    let r: RetentionSave | undefined;
    const days = [T_JUN22, T_JUN23, T_JUN24, T_JUN28_SAME_WEEK]; // 4 days × 3 tasks = 12 points → clears tier 1 (9) only
    for (const day of days) {
      for (const task of DAILY_TASKS) r = accrueRetentionTask(r, task.id, day);
    }
    expect(weeklyPoints(r, T_JUN22)).toBe(12);
    expect(weeklyClaimableTiers(r, T_JUN22)).toEqual([9]);
  });

  it('excludes tiers already claimed', () => {
    let r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22);
    r = accrueRetentionTask(r, 'pvp.match', T_JUN22);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN22);
    r = accrueRetentionTask(r, 'pve.clear', T_JUN23);
    r = accrueRetentionTask(r, 'pvp.match', T_JUN23);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN23);
    r = accrueRetentionTask(r, 'pve.clear', T_JUN24); // 7 points, still below tier1=9
    r = accrueRetentionTask(r, 'pvp.match', T_JUN24);
    r = accrueRetentionTask(r, 'gacha.draw', T_JUN24); // 9 points → tier1 reached
    expect(weeklyClaimableTiers(r, T_JUN22)).toEqual([9]);
    const claimed = claimWeeklyTier(r, 9, T_JUN22);
    expect(claimed.ok).toBe(true);
    const r2 = { ...r, weekly: (claimed as { newWeekly: typeof r.weekly }).newWeekly };
    expect(weeklyClaimableTiers(r2, T_JUN22)).toEqual([]);
  });
});

describe('claimWeeklyTier', () => {
  function pointsUpTo(threshold: number): RetentionSave {
    let r: RetentionSave | undefined;
    outer: for (const day of WEEK26_ALL_DAYS) {
      for (const task of DAILY_TASKS) {
        r = accrueRetentionTask(r, task.id, day);
        if (r!.weekly!.points >= threshold) break outer;
      }
    }
    return r!;
  }

  it('rejects an unknown threshold', () => {
    const r = pointsUpTo(9);
    expect(claimWeeklyTier(r, 999, T_JUN22)).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  it('rejects a claim before the threshold is reached', () => {
    const r = accrueRetentionTask(undefined, 'pve.clear', T_JUN22); // 1 point, tier1=9
    expect(claimWeeklyTier(r, 9, T_JUN22)).toEqual({ ok: false, error: 'NOT_REACHED' });
  });

  it('succeeds exactly at the threshold and returns the tier reward', () => {
    const r = pointsUpTo(9);
    const result = claimWeeklyTier(r, 9, T_JUN22);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.threshold).toBe(9);
      expect(result.reward).toEqual(WEEKLY_CHEST_TIERS[0]!.reward);
      expect(result.newWeekly.claimedTiers).toEqual([9]);
    }
  });

  it('rejects a repeat claim of the same tier', () => {
    const r = pointsUpTo(9);
    const first = claimWeeklyTier(r, 9, T_JUN22);
    expect(first.ok).toBe(true);
    const r2 = { ...r, weekly: (first as { newWeekly: typeof r.weekly }).newWeekly };
    expect(claimWeeklyTier(r2, 9, T_JUN22)).toEqual({ ok: false, error: 'ALREADY_CLAIMED' });
  });

  it('two different tiers can both be claimed independently within the same week', () => {
    const r = pointsUpTo(15);
    const t1 = claimWeeklyTier(r, 9, T_JUN22);
    expect(t1.ok).toBe(true);
    const r2 = { ...r, weekly: (t1 as { newWeekly: typeof r.weekly }).newWeekly };
    const t2 = claimWeeklyTier(r2, 15, T_JUN22);
    expect(t2.ok).toBe(true);
    if (t2.ok) expect(t2.newWeekly.claimedTiers).toEqual([9, 15]);
  });
});
