// Unit tests for the client-side retention mirror (game/meta/retention.ts), focused on the
// three claimable checks that feed DailyScene's sidebar-tab red dots (Monthly Check-in / Daily
// Tasks) and the lobby entry-point dot — the DailyScene sidebar tabs previously never showed a
// dot at all (fixed 2026-07-12); this locks down the values they now read.
import { describe, it, expect } from 'vitest';
import { nextCheckinDay, dailyRewardClaimable, hasRetentionClaimable, makeDayKey, makeMonthKey } from '../src/game/meta/retention';
import { makeNewSave } from '../src/game/meta/SaveData';
import type { SaveData } from '../src/game/meta/SaveData';

const T = Date.parse('2026-07-12T10:00:00Z');
const dayKey = makeDayKey(T);
const monthKey = makeMonthKey(T);

function withRetention(retention: SaveData['retention']): SaveData {
  return { ...makeNewSave(), retention };
}

describe('nextCheckinDay (Monthly Check-in tab badge)', () => {
  it('no retention data yet → day 1 is claimable', () => {
    expect(nextCheckinDay(withRetention(undefined), T)).toBe(1);
  });

  it('a stale month key resets to day 1 claimable', () => {
    const save = withRetention({ checkin: { monthKey: '2026-01', claimedDays: [1, 2, 3], lastClaimedDayKey: '2026-01-03' } });
    expect(nextCheckinDay(save, T)).toBe(1);
  });

  it('already claimed today → not claimable (null)', () => {
    const save = withRetention({ checkin: { monthKey, claimedDays: [1], lastClaimedDayKey: dayKey } });
    expect(nextCheckinDay(save, T)).toBeNull();
  });

  it('claimed on a prior day this month → next slot is claimable', () => {
    const save = withRetention({ checkin: { monthKey, claimedDays: [1, 2], lastClaimedDayKey: '2026-07-11' } });
    expect(nextCheckinDay(save, T)).toBe(3);
  });

  it('all 30 slots claimed → not claimable (null)', () => {
    const claimedDays = Array.from({ length: 30 }, (_, i) => i + 1);
    const save = withRetention({ checkin: { monthKey, claimedDays, lastClaimedDayKey: '2026-07-11' } });
    expect(nextCheckinDay(save, T)).toBeNull();
  });
});

describe('dailyRewardClaimable (Daily Tasks tab badge)', () => {
  it('no daily data yet → not claimable', () => {
    expect(dailyRewardClaimable(withRetention(undefined), T)).toBe(false);
  });

  it('a stale day key → not claimable', () => {
    const save = withRetention({ daily: { dayKey: '2026-07-11', completedTasks: {}, taskPoints: 3, rewardClaimed: false } });
    expect(dailyRewardClaimable(save, T)).toBe(false);
  });

  it('3/3 tasks done today, not yet claimed → claimable (the reported bug\'s exact state)', () => {
    const save = withRetention({
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: false },
    });
    expect(dailyRewardClaimable(save, T)).toBe(true);
  });

  it('below the 3-point threshold → not claimable', () => {
    const save = withRetention({ daily: { dayKey, completedTasks: { 'pve.clear': 1 }, taskPoints: 1, rewardClaimed: false } });
    expect(dailyRewardClaimable(save, T)).toBe(false);
  });

  it('3/3 done and already claimed → not claimable', () => {
    const save = withRetention({
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: true },
    });
    expect(dailyRewardClaimable(save, T)).toBe(false);
  });
});

describe('hasRetentionClaimable (lobby entry-point dot)', () => {
  it('claimable when only the check-in is available', () => {
    expect(hasRetentionClaimable(withRetention(undefined), T)).toBe(true);
  });

  it('claimable when only the daily task reward is available (check-in already done today)', () => {
    const save = withRetention({
      checkin: { monthKey, claimedDays: [1], lastClaimedDayKey: dayKey },
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: false },
    });
    expect(hasRetentionClaimable(save, T)).toBe(true);
  });

  it('not claimable when both are already claimed today', () => {
    const save = withRetention({
      checkin: { monthKey, claimedDays: [1], lastClaimedDayKey: dayKey },
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, taskPoints: 3, rewardClaimed: true },
    });
    expect(hasRetentionClaimable(save, T)).toBe(false);
  });
});
