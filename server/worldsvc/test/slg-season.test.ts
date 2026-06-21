// SLG 大区赛季纯函数单测（§17.11，无 Mongo，always-run）。
// 覆盖：繁荣度评分/衰减边界、settleTier 名次切档边界、sectStrengthScore 新宗门中位 vs 有历史、
// allocateSectsToShards 蛇形均衡（各 shard 强弱总和差有界 + 同宗门不拆分）。
import { describe, expect, it } from 'vitest';
import {
  familyProsperity,
  decayProsperity,
  settleTier,
  sectStrengthScore,
  allocateSectsToShards,
  PROSPERITY_W_TERRITORY,
  PROSPERITY_W_MEMBER,
  PROSPERITY_W_ACTIVITY,
  type SectStrength,
} from '@nw/shared';

describe('familyProsperity', () => {
  it('全 0 → 0', () => {
    expect(familyProsperity(0, 0, 0)).toBe(0);
  });
  it('线性加权 + 整数化', () => {
    expect(familyProsperity(3, 2, 4)).toBe(
      3 * PROSPERITY_W_TERRITORY + 2 * PROSPERITY_W_MEMBER + 4 * PROSPERITY_W_ACTIVITY,
    );
  });
});

describe('decayProsperity', () => {
  it('0 天不衰减', () => {
    expect(decayProsperity(1000, 0)).toBe(1000);
  });
  it('负天数视作 0（不放大）', () => {
    expect(decayProsperity(1000, -5)).toBe(1000);
  });
  it('衰减单调递减且 floor 整数', () => {
    const d1 = decayProsperity(1000, 1);
    const d10 = decayProsperity(1000, 10);
    expect(d1).toBeLessThan(1000);
    expect(d10).toBeLessThan(d1);
    expect(Number.isInteger(d10)).toBe(true);
  });
});

describe('settleTier', () => {
  it('名次切档边界 1/3/10/11', () => {
    expect(settleTier(1)).toBe('champion');
    expect(settleTier(2)).toBe('top3');
    expect(settleTier(3)).toBe('top3');
    expect(settleTier(4)).toBe('top10');
    expect(settleTier(10)).toBe('top10');
    expect(settleTier(11)).toBe('participant');
    expect(settleTier(999)).toBe('participant');
  });
});

describe('sectStrengthScore', () => {
  it('新宗门（无历史）给中位 + 规模/繁荣度加分', () => {
    const s: SectStrength = { sectId: 'a', memberFamilyCount: 2, prosperity: 500 };
    expect(sectStrengthScore(s)).toBe(500 + 2 * 50 + 5); // 605
  });
  it('有历史：名次越小分越高', () => {
    const top: SectStrength = { sectId: 'a', lastSeasonRank: 1, memberFamilyCount: 0, prosperity: 0 };
    const mid: SectStrength = { sectId: 'b', lastSeasonRank: 50, memberFamilyCount: 0, prosperity: 0 };
    expect(sectStrengthScore(top)).toBeGreaterThan(sectStrengthScore(mid));
  });
});

describe('allocateSectsToShards', () => {
  it('单 shard：所有宗门进 0', () => {
    const sects: SectStrength[] = [
      { sectId: 'a', memberFamilyCount: 1, prosperity: 0 },
      { sectId: 'b', memberFamilyCount: 1, prosperity: 0 },
    ];
    const m = allocateSectsToShards(sects, 1);
    expect([...m.values()].every((v) => v === 0)).toBe(true);
  });

  it('蛇形：同宗门不拆分（每个 sectId 恰一个 shard）', () => {
    const sects: SectStrength[] = Array.from({ length: 7 }, (_, i) => ({
      sectId: `s${i}`, memberFamilyCount: i, prosperity: i * 100,
    }));
    const m = allocateSectsToShards(sects, 3);
    expect(m.size).toBe(7);
    for (const s of sects) expect(m.has(s.sectId)).toBe(true);
  });

  it('蛇形均衡：各 shard 强弱总和差 ≤ 最强单体', () => {
    // 构造强弱悬殊的一组，验证蛇形分配后各区总分接近。
    const sects: SectStrength[] = Array.from({ length: 12 }, (_, i) => ({
      sectId: `s${i}`, lastSeasonRank: i + 1, memberFamilyCount: 0, prosperity: 0,
    }));
    const shardCount = 4;
    const m = allocateSectsToShards(sects, shardCount);
    const sums = new Array(shardCount).fill(0);
    for (const s of sects) sums[m.get(s.sectId)!] += sectStrengthScore(s);
    const maxSingle = Math.max(...sects.map(sectStrengthScore));
    const spread = Math.max(...sums) - Math.min(...sums);
    expect(spread).toBeLessThanOrEqual(maxSingle);
  });
});
