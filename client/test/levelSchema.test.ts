import { describe, it, expect } from 'vitest';
import { parseLevelDefinition, LevelParseError } from '../src/game/campaign/levelSchema';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { UnitType } from '../src/game/types';

/**
 * Level JSON validation guard.
 *
 * Campaign levels are JSON (no compile-time type safety), so parseLevelDefinition
 * is the sole gate. These tests confirm every bundled level passes, spot-check
 * that the JSON expands to the exact authored values (tick = seconds × 30), and
 * that the validator actually rejects the malformed shapes it claims to.
 */

const minimal = () => ({
  id: 'test',
  chapter: 1,
  seed: 1,
  objective: { kind: 'survive' },
  waves: { entries: [{ atTick: 0, unitType: 'infantry', col: 3, count: 1 }] },
});

describe('parseLevelDefinition', () => {
  it('accepts every bundled campaign level', () => {
    // Loading levels.ts already ran the parser; assert the registry is intact.
    expect(CAMPAIGN_LEVEL_ORDER).toEqual(['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch_stress']);
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      expect(CAMPAIGN_LEVELS[id]!.id).toBe(id);
    }
  });

  it('expands authored seconds to the exact ticks the old TS produced', () => {
    const lv1 = CAMPAIGN_LEVELS['ch1_lv1']!;
    // First entry was s(2) = round(2 × 30) = 60.
    expect(lv1.waves.entries[0]!.atTick).toBe(60);
    expect(lv1.waves.entries[0]!.unitType).toBe(UnitType.Infantry);
    expect(lv1.waves.entries[0]!.spacingTicks).toBe(24); // s(0.8)

    const lv2 = CAMPAIGN_LEVELS['ch1_lv2']!;
    expect(lv2.objective).toEqual({ kind: 'timed_defense', durationTicks: 1650 }); // s(55)

    const lv3 = CAMPAIGN_LEVELS['ch1_lv3']!;
    expect(lv3.board?.cellMask?.noBuild).toHaveLength(4);

    const stress = CAMPAIGN_LEVELS['ch_stress']!;
    expect(stress.waves.entries).toHaveLength(20); // 10 lanes × 2 batches
  });

  it('accepts a minimal valid level', () => {
    expect(() => parseLevelDefinition(minimal())).not.toThrow();
  });

  it('rejects an unknown unit type', () => {
    const bad = minimal();
    bad.waves.entries[0]!.unitType = 'dragon';
    expect(() => parseLevelDefinition(bad)).toThrow(LevelParseError);
    expect(() => parseLevelDefinition(bad)).toThrow(/unitType/);
  });

  it('rejects a spawn on a non-attack lane (base column)', () => {
    const bad = minimal();
    bad.waves.entries[0]!.col = 5; // base column
    expect(() => parseLevelDefinition(bad)).toThrow(/not an attack lane/);
  });

  it('rejects an out-of-bounds no-build cell', () => {
    const bad: any = minimal();
    bad.board = { cellMask: { noBuild: [{ col: 99, row: 0 }] } };
    expect(() => parseLevelDefinition(bad)).toThrow(/out of bounds/);
  });

  it('rejects an unknown objective kind', () => {
    const bad: any = minimal();
    bad.objective = { kind: 'capture_the_flag' };
    expect(() => parseLevelDefinition(bad)).toThrow(/objective/);
  });

  it('rejects non-monotonic star thresholds', () => {
    const bad: any = minimal();
    bad.rewards = { starThresholds: [80, 50, 100] };
    expect(() => parseLevelDefinition(bad)).toThrow(/non-decreasing/);
  });

  it('rejects an empty wave list', () => {
    const bad: any = minimal();
    bad.waves = { entries: [] };
    expect(() => parseLevelDefinition(bad)).toThrow(/at least one wave/);
  });
});
