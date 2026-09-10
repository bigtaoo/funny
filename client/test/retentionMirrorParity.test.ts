// `client/src/game/meta/retention.ts` is a hand-written mirror of `server/shared/src/retention.ts`
// (its own header: "Semantically consistent with server/shared/src/retention.ts"). This file is the
// mechanical version of that sentence.
//
// Why (2026-09-10, FN/FNDA sweep — see claudedocs/client-testing.md): the mirror had a suite
// (`test/retention.test.ts`) but it only ever imported the CLIENT half, and three of its functions
// — `checkinClaimedCount`, `dailyTaskPoints`, `isDailyTaskDone` — were called by no test in the
// repo at all. Same shape as the equipment mirror in ADR-087's predecessor: the server side is
// well covered, the client side is uncovered, and "keep the two in sync" is a thing a human
// remembers.
//
// The failure is invisible by construction. Retention is server-authoritative — the server grants
// the coins and stamps `claimedDays` — so drift never errors and never desyncs the save. It only
// makes the UI lie: a red dot on the Daily tab for a reward the server will refuse, a check-in
// slot that looks claimable on the 30th, a "2/3 tasks" line while the server has already paid out.
// All three read to a player as "the game is buggy", and none of them show up in a log.
//
// Two deliberate limits, same as the equipment gate:
//   - This is a PARITY test, not a value test. Moving a threshold on both sides is a designer's
//     normal move and stays green; the numbers belong to ECONOMY_NUMBERS §12 and the server suite.
//   - Every comparison carries a non-vacuity guard. Retention getters return 0 / false / [] for
//     stale or absent data, so a fixture that is stale in a way the author did not intend makes
//     both sides agree on nothing and the whole file passes empty.
//
// The client's signatures differ from the server's by one layer (`SaveData` vs `RetentionSave`),
// which is why this mirror is not deletable the way `equipment.ts` was (ADR-087) — the parity
// test is the answer here, not a deep alias.
import { describe, it, expect } from 'vitest';
import {
  checkinClaimedCount,
  nextCheckinDay,
  dailyTaskPoints,
  isDailyTaskDone,
  dailyRewardClaimable,
  weeklyPoints,
  weeklyClaimableTiers,
  makeDayKey,
  makeMonthKey,
  makeWeekKey,
  WEEKLY_CHEST_THRESHOLDS,
  type DailyTaskId,
} from '../src/game/meta/retention';
import * as srv from '../../server/shared/src/retention';
import { makeNewSave } from '../src/game/meta/SaveData';
import type { SaveData } from '../src/game/meta/SaveData';

type Retention = NonNullable<SaveData['retention']>;

function withRetention(retention: Retention | undefined): SaveData {
  return { ...makeNewSave(), retention };
}

const TASK_IDS: DailyTaskId[] = ['pve.clear', 'pvp.match', 'gacha.draw'];

// Timestamps chosen to land on different days / months / ISO weeks, including the two dates the
// ISO-week rule is actually interesting on (Jan 1st falling mid-week, and a year-end rollover).
const STAMPS = [
  Date.parse('2026-07-12T10:00:00Z'),
  Date.parse('2026-07-13T00:00:00Z'),
  Date.parse('2026-07-31T23:59:59Z'),
  Date.parse('2026-08-01T00:00:00Z'),
  Date.parse('2026-12-31T12:00:00Z'),
  Date.parse('2027-01-01T12:00:00Z'),
  Date.parse('2027-01-04T00:00:00Z'),
];

/**
 * Retention states worth comparing: absent, empty, current, and stale in each of the three
 * sections independently — staleness is where every one of these functions branches.
 */
function statesFor(tsMs: number): Array<{ label: string; r: Retention | undefined }> {
  const dayKey = makeDayKey(tsMs);
  const monthKey = makeMonthKey(tsMs);
  const weekKey = makeWeekKey(tsMs);
  const allTasks = { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 };
  return [
    { label: 'absent', r: undefined },
    { label: 'empty object', r: {} },
    { label: 'fresh, nothing done', r: {
      checkin: { monthKey, claimedDays: [] },
      daily: { dayKey, completedTasks: {}, taskPoints: 0, rewardClaimed: false },
      weekly: { weekKey, points: 0, claimedTiers: [] },
    } },
    { label: 'mid-progress', r: {
      checkin: { monthKey, claimedDays: [1, 2, 3], lastClaimedDayKey: makeDayKey(tsMs - 86400000) },
      daily: { dayKey, completedTasks: { 'pve.clear': 1, 'gacha.draw': 2 }, taskPoints: 2, rewardClaimed: false },
      weekly: { weekKey, points: 12, claimedTiers: [9] },
    } },
    // Claimed today with the month nowhere near full: the ONLY state in which the once-per-day
    // gate is the deciding branch. Without it the whole set still agrees with the server while
    // that gate is missing entirely, because 'full month, claimed today' below already returns
    // null on the slot count alone (mutation-verified 2026-09-10 — this state was the one hole).
    { label: 'claimed today, month not full', r: {
      checkin: { monthKey, claimedDays: [1, 2], lastClaimedDayKey: dayKey },
      daily: { dayKey, completedTasks: { 'pvp.match': 1 }, taskPoints: 1, rewardClaimed: false },
      weekly: { weekKey, points: 9, claimedTiers: [] },
    } },
    { label: 'full points, unclaimed', r: {
      checkin: { monthKey, claimedDays: Array.from({ length: 29 }, (_, i) => i + 1), lastClaimedDayKey: makeDayKey(tsMs - 86400000) },
      daily: { dayKey, completedTasks: allTasks, taskPoints: 3, rewardClaimed: false },
      weekly: { weekKey, points: 21, claimedTiers: [] },
    } },
    { label: 'full month, claimed today', r: {
      checkin: { monthKey, claimedDays: Array.from({ length: 30 }, (_, i) => i + 1), lastClaimedDayKey: dayKey },
      daily: { dayKey, completedTasks: allTasks, taskPoints: 3, rewardClaimed: true },
      weekly: { weekKey, points: 30, claimedTiers: [9, 15, 21] },
    } },
    { label: 'stale everything', r: {
      checkin: { monthKey: '2026-01', claimedDays: [1, 2], lastClaimedDayKey: '2026-01-02' },
      daily: { dayKey: '2026-01-02', completedTasks: allTasks, taskPoints: 3, rewardClaimed: false },
      weekly: { weekKey: '2026-W01', points: 21, claimedTiers: [] },
    } },
    { label: 'stale daily only', r: {
      checkin: { monthKey, claimedDays: [1] },
      daily: { dayKey: '2026-01-02', completedTasks: allTasks, taskPoints: 3, rewardClaimed: false },
      weekly: { weekKey, points: 9, claimedTiers: [] },
    } },
  ];
}

describe('time keys agree with server/shared/src/retention.ts', () => {
  it('day / month / ISO-week keys are identical at every stamp', () => {
    for (const ts of STAMPS) {
      expect(makeDayKey(ts), `day @${ts}`).toBe(srv.makeDayKey(ts));
      expect(makeMonthKey(ts), `month @${ts}`).toBe(srv.makeMonthKey(ts));
      expect(makeWeekKey(ts), `week @${ts}`).toBe(srv.makeWeekKey(ts));
    }
  });

  it('the stamps span more than one day / month / ISO week (guards the case above)', () => {
    expect(new Set(STAMPS.map(makeDayKey)).size).toBe(STAMPS.length);
    expect(new Set(STAMPS.map(makeMonthKey)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(STAMPS.map(makeWeekKey)).size).toBeGreaterThanOrEqual(5);
  });
});

describe('state derivation agrees with the server for every state x stamp', () => {
  it('check-in: claimed count and next claimable slot', () => {
    const counts = new Set<number>();
    const slots = new Set<number | null>();
    for (const ts of STAMPS) {
      for (const { label, r } of statesFor(ts)) {
        const save = withRetention(r);
        const count = checkinClaimedCount(save, ts);
        const slot = nextCheckinDay(save, ts);
        expect(count, `count / ${label} @${ts}`).toBe(srv.checkinClaimedCount(r, ts));
        expect(slot, `slot / ${label} @${ts}`).toBe(srv.nextCheckinDay(r, ts));
        counts.add(count);
        slots.add(slot);
      }
    }
    // Non-vacuity: both the "month is full" null and the "claimed today" null have to be reached,
    // as well as a real slot number — otherwise the loop is comparing 0 against 0.
    expect(counts.size).toBeGreaterThan(2);
    expect(slots.has(null)).toBe(true);
    expect([...slots].some((s) => typeof s === 'number' && s > 1)).toBe(true);
  });

  it('daily: task points, per-task done flags, and reward claimability', () => {
    const points = new Set<number>();
    const doneFlags = new Set<boolean>();
    const claimable = new Set<boolean>();
    for (const ts of STAMPS) {
      for (const { label, r } of statesFor(ts)) {
        const save = withRetention(r);
        const p = dailyTaskPoints(save, ts);
        const c = dailyRewardClaimable(save, ts);
        expect(p, `points / ${label} @${ts}`).toBe(srv.dailyTaskPoints(r, ts));
        expect(c, `claimable / ${label} @${ts}`).toBe(srv.dailyRewardClaimable(r, ts));
        points.add(p);
        claimable.add(c);
        for (const taskId of TASK_IDS) {
          const done = isDailyTaskDone(save, taskId, ts);
          expect(done, `${taskId} / ${label} @${ts}`).toBe(srv.isDailyTaskDone(r, taskId, ts));
          doneFlags.add(done);
        }
      }
    }
    expect([...points].sort((a, b) => a - b)).toContain(0);
    expect(points.size).toBeGreaterThan(2);
    expect(doneFlags).toEqual(new Set([true, false]));
    expect(claimable).toEqual(new Set([true, false]));
  });

  it('weekly: points and claimable chest tiers', () => {
    const tierLists = new Set<string>();
    for (const ts of STAMPS) {
      for (const { label, r } of statesFor(ts)) {
        const save = withRetention(r);
        const tiers = weeklyClaimableTiers(save, ts);
        expect(weeklyPoints(save, ts), `points / ${label} @${ts}`).toBe(srv.weeklyPoints(r, ts));
        expect(tiers, `tiers / ${label} @${ts}`).toEqual(srv.weeklyClaimableTiers(r, ts));
        tierLists.add(JSON.stringify(tiers));
      }
    }
    // At least one state must actually offer a chest, and at least one must offer none.
    expect(tierLists.has('[]')).toBe(true);
    expect([...tierLists].some((s) => s !== '[]')).toBe(true);
  });
});

describe('the constants the client hardcodes instead of importing', () => {
  it('the daily full-point threshold matches DAILY_POINTS_THRESHOLD', () => {
    // `dailyRewardClaimable` in the client spells this `>= 3` literally, where the server reads
    // DAILY_POINTS_THRESHOLD. Derived here from behaviour rather than read from a constant,
    // because there is no client-side constant to read.
    const ts = STAMPS[0]!;
    const dayKey = makeDayKey(ts);
    const clientThreshold = [0, 1, 2, 3, 4, 5].find((taskPoints) => dailyRewardClaimable(
      withRetention({ daily: { dayKey, completedTasks: {}, taskPoints, rewardClaimed: false } }),
      ts,
    ));
    expect(clientThreshold).toBe(srv.DAILY_POINTS_THRESHOLD);
    // ...and the pool that can reach it: three tasks, one point each, so the threshold is
    // "all tasks done". A fourth task or a re-pointed one silently changes what the dot means.
    expect(srv.DAILY_TASKS.map((d) => d.id).sort()).toEqual([...TASK_IDS].sort());
    expect(srv.DAILY_TASKS.reduce((a, d) => a + d.points, 0)).toBe(srv.DAILY_POINTS_THRESHOLD);
  });

  it('the check-in calendar length matches CHECKIN_TOTAL_DAYS', () => {
    // Client: `if (nextSlot > 30) return null`. Server: `> CHECKIN_TOTAL_DAYS`.
    const ts = STAMPS[0]!;
    const monthKey = makeMonthKey(ts);
    const full = (n: number): SaveData => withRetention({
      checkin: { monthKey, claimedDays: Array.from({ length: n }, (_, i) => i + 1) },
    });
    expect(nextCheckinDay(full(srv.CHECKIN_TOTAL_DAYS - 1), ts)).toBe(srv.CHECKIN_TOTAL_DAYS);
    expect(nextCheckinDay(full(srv.CHECKIN_TOTAL_DAYS), ts)).toBeNull();
    expect(srv.CHECKIN_REWARDS.length).toBe(srv.CHECKIN_TOTAL_DAYS);
  });

  it('WEEKLY_CHEST_THRESHOLDS matches the server tier table', () => {
    expect([...WEEKLY_CHEST_THRESHOLDS]).toEqual(srv.WEEKLY_CHEST_TIERS.map((tier) => tier.threshold));
    expect(WEEKLY_CHEST_THRESHOLDS.length).toBeGreaterThan(0);
  });
});
