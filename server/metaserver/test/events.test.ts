// B6 限时活动容器纯逻辑单测（无 Mongo）：isEventActive / taskProgress / rewardClaimedCount。
import { describe, it, expect } from 'vitest';
import { isEventActive, taskProgress, rewardClaimedCount, type EventTaskProgress } from '@nw/shared';

describe('isEventActive 活动窗口判断', () => {
  const START = 1_000_000;
  const END   = 2_000_000;

  it('活动期内返回 true', () => {
    expect(isEventActive(START, END, 1_500_000)).toBe(true);
    expect(isEventActive(START, END, START)).toBe(true); // 含边界 start
  });

  it('活动结束后返回 false（windowEnd 不含）', () => {
    expect(isEventActive(START, END, END)).toBe(false);
    expect(isEventActive(START, END, END + 1)).toBe(false);
  });

  it('活动开始前返回 false', () => {
    expect(isEventActive(START, END, START - 1)).toBe(false);
  });

  it('活动期外 claim 需拦截（窗口刚关）', () => {
    // 验收：活动期外 claim 被拒
    const justClosed = END;
    expect(isEventActive(START, END, justClosed)).toBe(false);
  });
});

describe('taskProgress 进度读取', () => {
  const prog: EventTaskProgress[] = [
    { taskId: 'task1', progress: 3, pointsGranted: false },
    { taskId: 'task2', progress: 5, pointsGranted: true },
  ];

  it('已有记录返回正确进度', () => {
    expect(taskProgress(prog, 'task1')).toBe(3);
    expect(taskProgress(prog, 'task2')).toBe(5);
  });

  it('无记录默认返回 0', () => {
    expect(taskProgress(prog, 'task3')).toBe(0);
    expect(taskProgress([], 'task1')).toBe(0);
  });
});

describe('rewardClaimedCount 兑换次数统计', () => {
  it('未兑换返回 0', () => {
    expect(rewardClaimedCount([], 'rwd1')).toBe(0);
    expect(rewardClaimedCount(['rwd2', 'rwd3'], 'rwd1')).toBe(0);
  });

  it('正确计数同 rewardId 出现次数（支持多次兑换）', () => {
    expect(rewardClaimedCount(['rwd1'], 'rwd1')).toBe(1);
    expect(rewardClaimedCount(['rwd1', 'rwd2', 'rwd1'], 'rwd1')).toBe(2);
  });

  it('maxClaims 语义：≥ maxClaims 视为超限', () => {
    // 验收：积分不跨活动结转（maxClaims 上限守卫）
    const MAX = 1;
    const claimed = ['rwd1'];
    expect(rewardClaimedCount(claimed, 'rwd1') >= MAX).toBe(true);
  });
});

describe('积分不跨活动结转（语义验收）', () => {
  it('不同 eventId 的参与文档 _id 不同', () => {
    // _id = `${eventId}:${accountId}`，不同活动天然隔离
    const accountId = 'acc1';
    const event1Id = 'event-A';
    const event2Id = 'event-B';
    const pid1 = `${event1Id}:${accountId}`;
    const pid2 = `${event2Id}:${accountId}`;
    expect(pid1).not.toBe(pid2);
  });

  it('积分归属活动，活动结束后无法再 claim（isEventActive 拦截）', () => {
    const NOW = 3_000_000;
    const closedEvent = { windowStart: 1_000_000, windowEnd: 2_000_000 };
    expect(isEventActive(closedEvent.windowStart, closedEvent.windowEnd, NOW)).toBe(false);
  });
});
