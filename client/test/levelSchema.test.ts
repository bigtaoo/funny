import { describe, it, expect } from 'vitest';
import { parseLevelDefinition, LevelParseError } from '@nw/engine/campaign/levelSchema';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { UnitType } from '@nw/engine/types';

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
    expect(CAMPAIGN_LEVEL_ORDER).toEqual([
      'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5',
      'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9', 'ch1_lv10',
      'ch2_lv1', 'ch2_lv2', 'ch2_lv3', 'ch2_lv4', 'ch2_lv5',
      'ch2_lv6', 'ch2_lv7', 'ch2_lv8', 'ch2_lv9', 'ch2_lv10',
      'ch3_lv1', 'ch3_lv2', 'ch3_lv3', 'ch3_lv4', 'ch3_lv5',
      'ch3_lv6', 'ch3_lv7', 'ch3_lv8', 'ch3_lv9', 'ch3_lv10',
      'ch4_lv1', 'ch4_lv2', 'ch4_lv3', 'ch4_lv4', 'ch4_lv5',
      'ch4_lv6', 'ch4_lv7', 'ch4_lv8', 'ch4_lv9', 'ch4_lv10',
      'ch5_lv1', 'ch5_lv2', 'ch5_lv3', 'ch5_lv4', 'ch5_lv5',
      'ch5_lv6', 'ch5_lv7', 'ch5_lv8', 'ch5_lv9', 'ch5_lv10',
      'ch6_lv1', 'ch6_lv2', 'ch6_lv3', 'ch6_lv4', 'ch6_lv5',
      'ch6_lv6', 'ch6_lv7', 'ch6_lv8', 'ch6_lv9', 'ch6_lv10',
      // 'ch_stress' intentionally excluded (2026-08-03 fix) — see CAMPAIGN_LEVEL_ORDER's doc comment
      // in levels.ts; it's a perf fixture, not a real level, and pollutes currentChapter()'s scan.
    ]);
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      expect(CAMPAIGN_LEVELS[id]!.id).toBe(id);
    }
  });

  it('expands authored seconds to the exact ticks the old TS produced', () => {
    const lv1 = CAMPAIGN_LEVELS['ch1_lv1']!;
    // First entry is s(4) = round(4 × 30) = 120 (softened opener, balance 0233a645).
    expect(lv1.waves.entries[0]!.atTick).toBe(120);
    expect(lv1.waves.entries[0]!.unitType).toBe(UnitType.Max); // Anna-side vanguard
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

  it('parses story.realLayerKey (chapter-end "real layer" interlude, world.md「章末真实层」)', () => {
    const withKey: any = minimal();
    withKey.story = { outroKey: 'campaign.ch1.outro', realLayerKey: 'campaign.realLayer.ch1' };
    const parsed = parseLevelDefinition(withKey);
    expect(parsed.story?.outroKey).toBe('campaign.ch1.outro');
    expect(parsed.story?.realLayerKey).toBe('campaign.realLayer.ch1');
  });

  it('every chapter\'s last level (chN_lv10) carries the matching realLayerKey', () => {
    // One per chapter (see IllustratedInterludeScene + realLayerInterludeArt.ts) — ch6 reuses
    // campaign.epilogue rather than a dedicated campaign.realLayer.ch6 key.
    const expected: Record<string, string> = {
      ch1_lv10: 'campaign.realLayer.ch1',
      ch2_lv10: 'campaign.realLayer.ch2',
      ch3_lv10: 'campaign.realLayer.ch3',
      ch4_lv10: 'campaign.realLayer.ch4',
      ch5_lv10: 'campaign.realLayer.ch5',
      ch6_lv10: 'campaign.epilogue',
    };
    for (const [id, key] of Object.entries(expected)) {
      expect(CAMPAIGN_LEVELS[id]?.story?.realLayerKey).toBe(key);
    }
  });

  it('no other level carries a realLayerKey — it is exclusive to each chapter\'s last level', () => {
    const lastLevels = new Set(['ch1_lv10', 'ch2_lv10', 'ch3_lv10', 'ch4_lv10', 'ch5_lv10', 'ch6_lv10']);
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      if (lastLevels.has(id)) continue;
      expect(CAMPAIGN_LEVELS[id]!.story?.realLayerKey).toBeUndefined();
    }
  });

  it('every campaign level carries a briefKey — every level shows a story beat at the start (2026-08-08)', () => {
    // Product ask: every level opens with a story line, no exceptions. Lv4/Lv8 ("纯战斗关") used
    // to be the one gap — LevelPrepScene rendered a blank panel for them (visible on e.g. Level 24
    // = ch3_lv4) until briefKey was added for all twelve Lv4/Lv8 levels across the six chapters.
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      if (id === 'ch_stress') continue; // perf fixture, not a real narrative level
      expect(CAMPAIGN_LEVELS[id]!.briefKey, `${id} is missing briefKey`).toBeDefined();
    }
  });

  it('outroKey is exclusive to each chapter\'s last level — only special (finale) levels end with a story', () => {
    // Complements the realLayerKey exclusivity check above: the other end of the product ask
    // ("只有特殊关卡在结束时有故事") is that ResultScene's outro overlay never fires outside the
    // six chapter finales.
    const lastLevels = new Set(['ch1_lv10', 'ch2_lv10', 'ch3_lv10', 'ch4_lv10', 'ch5_lv10', 'ch6_lv10']);
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      if (lastLevels.has(id)) {
        expect(CAMPAIGN_LEVELS[id]!.story?.outroKey, `${id} should carry an outroKey`).toBeDefined();
      } else {
        expect(CAMPAIGN_LEVELS[id]!.story?.outroKey).toBeUndefined();
      }
    }
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
