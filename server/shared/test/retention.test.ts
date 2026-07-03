// Unit tests for retention.ts: UTC time keys, calendar/daily reward tables, lazy stale reset, state derivation,
// idempotent accrual + one-per-day claim logic (RETENTION_DESIGN.md §3/§4). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  makeDayKey,
  makeMonthKey,
  CHECKIN_REWARDS,
  CHECKIN_TOTAL_DAYS,
  CHECKIN_MILESTONE_DAYS,
  DAILY_TASKS,
  DAILY_POINTS_THRESHOLD,
  DAILY_COINS_REWARD,
  resetStaleRetention,
  checkinClaimedCount,
  nextCheckinDay,
  dailyTaskPoints,
  isDailyTaskDone,
  dailyRewardClaimable,
  accrueRetentionTask,
  claimCheckinDay,
  claimDailyReward,
  type RetentionSave,
} from '../src/retention';

// Fixed timestamps (UTC). Using explicit epoch ms keeps these deterministic across machines.
const T_JUN22 = Date.parse('2026-06-22T10:00:00Z');
const T_JUN22_LATE = Date.parse('2026-06-22T23:30:00Z');
const T_JUN23 = Date.parse('2026-06-23T01:00:00Z');
const T_JUL01 = Date.parse('2026-07-01T00:00:00Z');

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

  it('milestone days pay coins', () => {
    for (const day of CHECKIN_MILESTONE_DAYS) {
      expect(CHECKIN_REWARDS[day - 1]!.kind).toBe('coins');
    }
  });

  it('the month-end finale (day 30) is the biggest coin payout', () => {
    const coinSlots = CHECKIN_REWARDS.filter((r) => r.kind === 'coins').map((r) => r.count);
    expect(CHECKIN_REWARDS[29]!.count).toBe(Math.max(...coinSlots));
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
