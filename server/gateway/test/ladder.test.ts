// 天梯段位 + ELO 纯函数单测（S1-R）。数值见 ECONOMY_BALANCE.md §2.3。
import { describe, it, expect } from 'vitest';
import {
  eloToRank,
  computeEloDelta,
  nextStreak,
  INITIAL_ELO,
  RANK_TIERS,
} from '@nw/shared';

describe('ladder', () => {
  it('9 段段位 + eloToRank 边界', () => {
    expect(RANK_TIERS).toHaveLength(9);
    expect(eloToRank(0)).toBe('bronze');
    expect(eloToRank(INITIAL_ELO)).toBe('bronze'); // 初始 1000 < silver 1100
    expect(eloToRank(1099)).toBe('bronze');
    expect(eloToRank(1100)).toBe('silver');
    expect(eloToRank(2399)).toBe('grandmaster');
    expect(eloToRank(2400)).toBe('king');
    expect(eloToRank(99999)).toBe('king');
  });

  it('computeEloDelta 同分 ±16（K=32），零和', () => {
    const d = computeEloDelta(1000, 1000);
    expect(d.winner).toBe(16);
    expect(d.loser).toBe(-16);
    expect(d.winner + d.loser).toBe(0);
  });

  it('爆冷（低分赢高分）得分更多', () => {
    const upset = computeEloDelta(1000, 1400);
    const expected = computeEloDelta(1400, 1000);
    expect(upset.winner).toBeGreaterThan(expected.winner);
    expect(upset.winner + upset.loser).toBe(0);
  });

  it('nextStreak 连胜/连败串', () => {
    expect(nextStreak(0, true)).toBe(1);
    expect(nextStreak(3, true)).toBe(4);
    expect(nextStreak(-2, true)).toBe(1); // 连败中赢一场 → 重置为 +1
    expect(nextStreak(0, false)).toBe(-1);
    expect(nextStreak(-2, false)).toBe(-3);
    expect(nextStreak(3, false)).toBe(-1); // 连胜中输一场 → 重置为 -1
  });
});
