import { describe, expect, it } from 'vitest';
import {
  PROSPERITY_W_ACTIVITY,
  PROSPERITY_W_MEMBER,
  PROSPERITY_W_TERRITORY,
  allocateSectsToShards,
  decayProsperity,
  familyProsperity,
  sectStrengthScore,
  settleTier,
  shardCountForPopulation,
  worldShardId,
  type SectStrength,
} from '../src/slg';

describe('familyProsperity / decayProsperity', () => {
  it('sums weighted territory/member/activity contributions', () => {
    expect(familyProsperity(10, 5, 20)).toBe(
      Math.floor(10 * PROSPERITY_W_TERRITORY + 5 * PROSPERITY_W_MEMBER + 20 * PROSPERITY_W_ACTIVITY),
    );
  });

  it('decays by 5%/day, floored to an integer', () => {
    expect(decayProsperity(1000, 0)).toBe(1000);
    expect(decayProsperity(1000, 1)).toBe(Math.floor(1000 * 0.95));
  });

  it('never decays for negative dtDays (clamped to 0)', () => {
    expect(decayProsperity(1000, -5)).toBe(1000);
  });
});

describe('settleTier', () => {
  it('buckets rank into champion/top3/top10/participant', () => {
    expect(settleTier(1)).toBe('champion');
    expect(settleTier(2)).toBe('top3');
    expect(settleTier(3)).toBe('top3');
    expect(settleTier(10)).toBe('top10');
    expect(settleTier(11)).toBe('participant');
  });
});

describe('sectStrengthScore / allocateSectsToShards', () => {
  const mk = (sectId: string, rank: number | undefined, members: number, prosperity: number): SectStrength => ({
    sectId,
    lastSeasonRank: rank,
    memberFamilyCount: members,
    prosperity,
  });

  it('gives a new sect (no lastSeasonRank) the median rank score', () => {
    const veteran = mk('v1', 1, 0, 0); // rankScore = (100-1)*100 = 9900
    const rookie = mk('r1', undefined, 0, 0); // rankScore = 500
    expect(sectStrengthScore(veteran)).toBeGreaterThan(sectStrengthScore(rookie));
  });

  it('adds member count and prosperity as secondary factors', () => {
    const base = mk('a', undefined, 0, 0);
    const withMembers = mk('a', undefined, 3, 0);
    const withProsperity = mk('a', undefined, 0, 500);
    expect(sectStrengthScore(withMembers)).toBe(sectStrengthScore(base) + 3 * 50);
    expect(sectStrengthScore(withProsperity)).toBe(sectStrengthScore(base) + Math.floor(500 / 100));
  });

  it('snake-drafts sects into balanced shards, alternating direction each cycle', () => {
    const sects = [mk('a', 1, 0, 0), mk('b', 2, 0, 0), mk('c', 3, 0, 0), mk('d', 4, 0, 0)];
    const out = allocateSectsToShards(sects, 2);
    // sorted strongest→weakest by rank: a,b,c,d; snake to 2 shards: a→0, b→1, c→1, d→0
    expect(out.get('a')).toBe(0);
    expect(out.get('b')).toBe(1);
    expect(out.get('c')).toBe(1);
    expect(out.get('d')).toBe(0);
  });

  it('assigns every sect to shard 0 when shardCount is 1', () => {
    const sects = [mk('a', 1, 0, 0), mk('b', 2, 0, 0)];
    const out = allocateSectsToShards(sects, 1);
    expect([...out.values()]).toEqual([0, 0]);
  });
});

describe('worldShardId / shardCountForPopulation', () => {
  it('formats world ids as s{season}-{shard}', () => {
    expect(worldShardId(5, 2)).toBe('s5-2');
  });

  it('computes required shard count, ceiling, minimum 1', () => {
    expect(shardCountForPopulation(0, 1000)).toBe(1);
    expect(shardCountForPopulation(1000, 1000)).toBe(1);
    expect(shardCountForPopulation(1001, 1000)).toBe(2);
  });
});
