import { describe, it, expect } from 'vitest';
import { computeStars, remainingHpPct, applyCampaignClear } from '../src/game/meta/campaignRewards';
import { makeNewSave } from '../src/game/meta/SaveData';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

const LEVEL: LevelDefinition = {
  id: 'ch_test',
  seed: 1,
  objective: { kind: 'survive' } as LevelDefinition['objective'],
  rewards: { starThresholds: [50, 80, 100], materials: { scrap: 6, lead: 2 } },
};

describe('computeStars', () => {
  it('counts non-decreasing thresholds met', () => {
    expect(computeStars([50, 80, 100], 100)).toBe(3);
    expect(computeStars([50, 80, 100], 85)).toBe(2);
    expect(computeStars([50, 80, 100], 50)).toBe(1);
    expect(computeStars([50, 80, 100], 49)).toBe(0);
  });
  it('falls back to 1★ on clear when no thresholds given', () => {
    expect(computeStars(undefined, 1)).toBe(1);
    expect(computeStars(undefined, 0)).toBe(0);
  });
});

describe('remainingHpPct', () => {
  it('is 100 minus base damage, clamped 0..100', () => {
    expect(remainingHpPct(0)).toBe(100);
    expect(remainingHpPct(30)).toBe(70);
    expect(remainingHpPct(140)).toBe(0);
  });
});

describe('applyCampaignClear', () => {
  it('on first clear: records cleared, stars, and grants materials', () => {
    const s = makeNewSave();
    const granted = applyCampaignClear(s, 'ch_test', LEVEL, 2);
    expect(s.progress.cleared).toContain('ch_test');
    expect(s.progress.stars['ch_test']).toBe(2);
    expect(s.materials).toEqual({ scrap: 6, lead: 2 });
    expect(granted).toEqual({ scrap: 6, lead: 2 });
  });

  it('replay does not re-grant materials but keeps the higher star count', () => {
    const s = makeNewSave();
    applyCampaignClear(s, 'ch_test', LEVEL, 1);
    const granted2 = applyCampaignClear(s, 'ch_test', LEVEL, 3);
    expect(granted2).toEqual({}); // no double-dip
    expect(s.materials).toEqual({ scrap: 6, lead: 2 }); // unchanged
    expect(s.progress.stars['ch_test']).toBe(3); // improved
  });

  it('a lower star replay never lowers the recorded star count', () => {
    const s = makeNewSave();
    applyCampaignClear(s, 'ch_test', LEVEL, 3);
    applyCampaignClear(s, 'ch_test', LEVEL, 1);
    expect(s.progress.stars['ch_test']).toBe(3);
  });

  it('grants nothing for 0 stars (not cleared)', () => {
    const s = makeNewSave();
    const granted = applyCampaignClear(s, 'ch_test', LEVEL, 0);
    expect(granted).toEqual({});
    expect(s.progress.cleared).toEqual([]);
  });
});
