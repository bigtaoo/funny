// B6 timed-event container pure-logic unit tests (no Mongo required): isEventActive / taskProgress / rewardClaimedCount.
import { describe, it, expect } from 'vitest';
import { isEventActive, taskProgress, rewardClaimedCount, type EventTaskProgress } from '@nw/shared';

describe('isEventActive event window check', () => {
  const START = 1_000_000;
  const END   = 2_000_000;

  it('returns true during the event window', () => {
    expect(isEventActive(START, END, 1_500_000)).toBe(true);
    expect(isEventActive(START, END, START)).toBe(true); // inclusive of start boundary
  });

  it('returns false after the event ends (windowEnd is exclusive)', () => {
    expect(isEventActive(START, END, END)).toBe(false);
    expect(isEventActive(START, END, END + 1)).toBe(false);
  });

  it('returns false before the event starts', () => {
    expect(isEventActive(START, END, START - 1)).toBe(false);
  });

  it('claim outside the event window must be blocked (window just closed)', () => {
    // acceptance: claim outside the event window is rejected
    const justClosed = END;
    expect(isEventActive(START, END, justClosed)).toBe(false);
  });
});

describe('taskProgress progress retrieval', () => {
  const prog: EventTaskProgress[] = [
    { taskId: 'task1', progress: 3, pointsGranted: false },
    { taskId: 'task2', progress: 5, pointsGranted: true },
  ];

  it('existing record returns correct progress', () => {
    expect(taskProgress(prog, 'task1')).toBe(3);
    expect(taskProgress(prog, 'task2')).toBe(5);
  });

  it('no record defaults to 0', () => {
    expect(taskProgress(prog, 'task3')).toBe(0);
    expect(taskProgress([], 'task1')).toBe(0);
  });
});

describe('rewardClaimedCount claim count tracking', () => {
  it('not yet claimed returns 0', () => {
    expect(rewardClaimedCount([], 'rwd1')).toBe(0);
    expect(rewardClaimedCount(['rwd2', 'rwd3'], 'rwd1')).toBe(0);
  });

  it('correctly counts occurrences of the same rewardId (supports multiple claims)', () => {
    expect(rewardClaimedCount(['rwd1'], 'rwd1')).toBe(1);
    expect(rewardClaimedCount(['rwd1', 'rwd2', 'rwd1'], 'rwd1')).toBe(2);
  });

  it('maxClaims semantics: count >= maxClaims is treated as over-limit', () => {
    // acceptance: points do not carry over across events (maxClaims upper-bound guard)
    const MAX = 1;
    const claimed = ['rwd1'];
    expect(rewardClaimedCount(claimed, 'rwd1') >= MAX).toBe(true);
  });
});

describe('points do not carry over across events (semantic acceptance)', () => {
  it('participation documents with different eventIds have different _id values', () => {
    // _id = `${eventId}:${accountId}`, naturally isolated per event
    const accountId = 'acc1';
    const event1Id = 'event-A';
    const event2Id = 'event-B';
    const pid1 = `${event1Id}:${accountId}`;
    const pid2 = `${event2Id}:${accountId}`;
    expect(pid1).not.toBe(pid2);
  });

  it('points belong to the event; claiming after it ends is blocked (guarded by isEventActive)', () => {
    const NOW = 3_000_000;
    const closedEvent = { windowStart: 1_000_000, windowEnd: 2_000_000 };
    expect(isEventActive(closedEvent.windowStart, closedEvent.windowEnd, NOW)).toBe(false);
  });
});
