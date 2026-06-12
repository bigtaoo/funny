import { UnitType } from '../types';
import type { LevelDefinition } from './LevelDefinition';

// tick = seconds × TICK_RATE(30). Helper keeps the wave script readable in seconds.
const s = (sec: number): number => Math.round(sec * 30);

/**
 * Chapter 1, Level 1 — "新兵集结" (Recruits Muster).
 *
 * P0 validation level: pure `survive` objective, all lanes open, no hazards or
 * no-build cells (those depth knobs are exercised in ch1_lv2/lv3 during S5).
 * The wave script ramps over ~50s — swordsmen → archers → a Guardian tank →
 * a multi-lane closing push — to test whether the *defense* loop is fun.
 *
 * Attack lanes (non-base cols): 0,1,2,3,4,7,8,9,10,11.
 */
const CH1_LV1: LevelDefinition = {
  id: 'ch1_lv1',
  chapter: 1,
  seed: 0x10001,
  objective: { kind: 'survive' },
  waves: {
    entries: [
      // ── Wave 1: a light probe down two lanes ──────────────────────────────
      { atTick: s(2),  unitType: UnitType.Swordsman, col: 3,  count: 2, spacingTicks: s(0.8) },
      { atTick: s(2),  unitType: UnitType.Swordsman, col: 8,  count: 2, spacingTicks: s(0.8) },

      // ── Wave 2: more bodies + first archers ───────────────────────────────
      { atTick: s(8),  unitType: UnitType.Swordsman, col: 2,  count: 3, spacingTicks: s(0.6) },
      { atTick: s(8),  unitType: UnitType.Archer,    col: 9,  count: 2, spacingTicks: s(1.3) },

      // ── Wave 3: pressure on three lanes ───────────────────────────────────
      { atTick: s(16), unitType: UnitType.Swordsman, col: 1,  count: 3, spacingTicks: s(0.6) },
      { atTick: s(16), unitType: UnitType.Swordsman, col: 4,  count: 3, spacingTicks: s(0.6) },
      { atTick: s(16), unitType: UnitType.Archer,    col: 10, count: 2, spacingTicks: s(1.2) },

      // ── Wave 4: a Guardian tank leads a swordsman column ──────────────────
      { atTick: s(26), unitType: UnitType.Guardian,  col: 8,  count: 1, isBoss: true },
      { atTick: s(27), unitType: UnitType.Swordsman, col: 7,  count: 4, spacingTicks: s(0.5) },

      // ── Wave 5: flanks light up ───────────────────────────────────────────
      { atTick: s(36), unitType: UnitType.Swordsman, col: 0,  count: 3, spacingTicks: s(0.5) },
      { atTick: s(36), unitType: UnitType.Swordsman, col: 11, count: 3, spacingTicks: s(0.5) },
      { atTick: s(36), unitType: UnitType.Archer,    col: 3,  count: 2, spacingTicks: s(1.0) },

      // ── Wave 6: closing push — two tanks + a four-lane swarm ──────────────
      { atTick: s(46), unitType: UnitType.Guardian,  col: 3,  count: 1, isBoss: true },
      { atTick: s(46), unitType: UnitType.Guardian,  col: 8,  count: 1, isBoss: true },
      { atTick: s(47), unitType: UnitType.Swordsman, col: 2,  count: 3, spacingTicks: s(0.4) },
      { atTick: s(47), unitType: UnitType.Swordsman, col: 4,  count: 3, spacingTicks: s(0.4) },
      { atTick: s(47), unitType: UnitType.Swordsman, col: 7,  count: 3, spacingTicks: s(0.4) },
      { atTick: s(47), unitType: UnitType.Swordsman, col: 9,  count: 3, spacingTicks: s(0.4) },
    ],
  },
  rewards: {
    starThresholds: [50, 80, 100], // base-HP% for 1/2/3 stars (reserved, not yet consumed)
  },
};

/** Registry of all campaign levels, keyed by id. */
export const CAMPAIGN_LEVELS: Record<string, LevelDefinition> = {
  [CH1_LV1.id]: CH1_LV1,
};

/** Look up a level by id, or null if unknown. */
export function getLevel(id: string): LevelDefinition | null {
  return CAMPAIGN_LEVELS[id] ?? null;
}
