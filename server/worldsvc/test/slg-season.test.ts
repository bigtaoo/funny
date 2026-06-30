// Pure-function unit tests for SLG region season logic (§17.11, no Mongo, always-run).
// Coverage: prosperity score/decay boundary, settleTier rank-tier boundary, sectStrengthScore
// for new sects (median baseline) vs sects with history, allocateSectsToShards snake-balance
// (bounded total-strength spread across shards + no sect split across shards).
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
  it('all 0 → 0', () => {
    expect(familyProsperity(0, 0, 0)).toBe(0);
  });
  it('linear weighted sum + integer floor', () => {
    expect(familyProsperity(3, 2, 4)).toBe(
      3 * PROSPERITY_W_TERRITORY + 2 * PROSPERITY_W_MEMBER + 4 * PROSPERITY_W_ACTIVITY,
    );
  });
});

describe('decayProsperity', () => {
  it('0 days no decay', () => {
    expect(decayProsperity(1000, 0)).toBe(1000);
  });
  it('negative days treated as 0 (no amplification)', () => {
    expect(decayProsperity(1000, -5)).toBe(1000);
  });
  it('decay is monotonically decreasing and floor integer', () => {
    const d1 = decayProsperity(1000, 1);
    const d10 = decayProsperity(1000, 10);
    expect(d1).toBeLessThan(1000);
    expect(d10).toBeLessThan(d1);
    expect(Number.isInteger(d10)).toBe(true);
  });
});

describe('settleTier', () => {
  it('rank tier boundary 1/3/10/11', () => {
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
  it('new sect (no history) gets median baseline + size/prosperity bonus', () => {
    const s: SectStrength = { sectId: 'a', memberFamilyCount: 2, prosperity: 500 };
    expect(sectStrengthScore(s)).toBe(500 + 2 * 50 + 5); // 605
  });
  it('with history: lower rank gives higher score', () => {
    const top: SectStrength = { sectId: 'a', lastSeasonRank: 1, memberFamilyCount: 0, prosperity: 0 };
    const mid: SectStrength = { sectId: 'b', lastSeasonRank: 50, memberFamilyCount: 0, prosperity: 0 };
    expect(sectStrengthScore(top)).toBeGreaterThan(sectStrengthScore(mid));
  });
});

describe('allocateSectsToShards', () => {
  it('single shard: all sects go to shard 0', () => {
    const sects: SectStrength[] = [
      { sectId: 'a', memberFamilyCount: 1, prosperity: 0 },
      { sectId: 'b', memberFamilyCount: 1, prosperity: 0 },
    ];
    const m = allocateSectsToShards(sects, 1);
    expect([...m.values()].every((v) => v === 0)).toBe(true);
  });

  it('snake order: no sect split across shards (each sectId maps to exactly one shard)', () => {
    const sects: SectStrength[] = Array.from({ length: 7 }, (_, i) => ({
      sectId: `s${i}`, memberFamilyCount: i, prosperity: i * 100,
    }));
    const m = allocateSectsToShards(sects, 3);
    expect(m.size).toBe(7);
    for (const s of sects) expect(m.has(s.sectId)).toBe(true);
  });

  it('snake balance: total strength spread across shards ≤ strongest single sect', () => {
    // Build a group with a wide strength spread and verify that snake allocation keeps shard totals close.
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
