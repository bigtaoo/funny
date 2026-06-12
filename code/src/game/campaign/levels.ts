import { ATTACK_LANES } from '../config';
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

/**
 * Chapter 1, Level 2 — "持久防线" (Hold the Line).
 *
 * Depth knob: **objective variation** (§4.6) + **economy constraint** (§4.7).
 * Objective is `timed_defense` — survive a relentless, never-clearing siege for
 * 55s rather than wiping a finite set of waves. Pressure is concentrated on the
 * four center lanes (3/4/7/8) so the player must hold a narrow front. A small
 * `startCoins` lets the player react to the immediate rush. Distinct feel from
 * lv1's "spread out, clear everything".
 */
const CH1_LV2: LevelDefinition = {
  id: 'ch1_lv2',
  chapter: 1,
  seed: 0x10002,
  objective: { kind: 'timed_defense', durationTicks: s(55) },
  startCoins: 8,
  waves: {
    entries: [
      // Continuous center pressure — keeps coming until the timer runs out.
      { atTick: s(1),  unitType: UnitType.Swordsman, col: 4,  count: 6,  spacingTicks: s(1.2) },
      { atTick: s(1),  unitType: UnitType.Swordsman, col: 7,  count: 6,  spacingTicks: s(1.2) },
      { atTick: s(10), unitType: UnitType.Archer,    col: 3,  count: 3,  spacingTicks: s(2.0) },
      { atTick: s(10), unitType: UnitType.Archer,    col: 8,  count: 3,  spacingTicks: s(2.0) },
      { atTick: s(20), unitType: UnitType.Swordsman, col: 3,  count: 8,  spacingTicks: s(0.9) },
      { atTick: s(20), unitType: UnitType.Swordsman, col: 8,  count: 8,  spacingTicks: s(0.9) },
      { atTick: s(30), unitType: UnitType.Guardian,  col: 4,  count: 1,  isBoss: true },
      { atTick: s(30), unitType: UnitType.Guardian,  col: 7,  count: 1,  isBoss: true },
      // Final crescendo — the hardest stretch right before the timer ends.
      { atTick: s(40), unitType: UnitType.Swordsman, col: 4,  count: 10, spacingTicks: s(0.6) },
      { atTick: s(40), unitType: UnitType.Swordsman, col: 7,  count: 10, spacingTicks: s(0.6) },
      { atTick: s(44), unitType: UnitType.Archer,    col: 3,  count: 4,  spacingTicks: s(1.5) },
      { atTick: s(44), unitType: UnitType.Archer,    col: 8,  count: 4,  spacingTicks: s(1.5) },
    ],
  },
  rewards: { starThresholds: [40, 70, 100] },
};

/**
 * Chapter 1, Level 3 — "残页防御" (Defending the Torn Page).
 *
 * Depth knob: **no-build coverage puzzle** (§4.1 / §4.3). The four center
 * building columns (3/4/7/8) are torn out (no-build), so the player cannot put
 * towers/barracks directly in front of the center lanes and must cover them
 * from the inner-most allowed columns (2 / 9) using arrow-tower range, or plug
 * gaps with units. Survive objective with sustained multi-lane waves so the
 * placement restriction actually bites (towers die and can't be rebuilt where
 * you'd want them).
 *
 * NOTE (validation finding to confirm in play): with arrow range 2 and only 10
 * lanes, two well-placed towers can still cover a lot — the puzzle is more
 * "restricted placement under fire" than a tight geometric optimization. S5
 * exists partly to judge whether this knob is deep enough as-is.
 */
const CH1_LV3: LevelDefinition = {
  id: 'ch1_lv3',
  chapter: 1,
  seed: 0x10003,
  objective: { kind: 'survive' },
  startCoins: 6,
  board: {
    cellMask: {
      // Player building row is row 0; tear out the four center build slots.
      noBuild: [
        { col: 3, row: 0 },
        { col: 4, row: 0 },
        { col: 7, row: 0 },
        { col: 8, row: 0 },
      ],
    },
  },
  waves: {
    entries: [
      { atTick: s(3),  unitType: UnitType.Swordsman, col: 4,  count: 4, spacingTicks: s(0.7) },
      { atTick: s(3),  unitType: UnitType.Swordsman, col: 7,  count: 4, spacingTicks: s(0.7) },
      { atTick: s(12), unitType: UnitType.Swordsman, col: 3,  count: 4, spacingTicks: s(0.6) },
      { atTick: s(12), unitType: UnitType.Archer,    col: 8,  count: 3, spacingTicks: s(1.4) },
      { atTick: s(22), unitType: UnitType.Swordsman, col: 2,  count: 3, spacingTicks: s(0.6) },
      { atTick: s(22), unitType: UnitType.Swordsman, col: 9,  count: 3, spacingTicks: s(0.6) },
      { atTick: s(22), unitType: UnitType.Guardian,  col: 4,  count: 1, isBoss: true },
      { atTick: s(34), unitType: UnitType.Swordsman, col: 7,  count: 5, spacingTicks: s(0.5) },
      { atTick: s(34), unitType: UnitType.Archer,    col: 3,  count: 3, spacingTicks: s(1.2) },
      // Closing push on the un-buildable center lanes.
      { atTick: s(44), unitType: UnitType.Guardian,  col: 4,  count: 1, isBoss: true },
      { atTick: s(44), unitType: UnitType.Guardian,  col: 7,  count: 1, isBoss: true },
      { atTick: s(45), unitType: UnitType.Swordsman, col: 3,  count: 4, spacingTicks: s(0.5) },
      { atTick: s(45), unitType: UnitType.Swordsman, col: 8,  count: 4, spacingTicks: s(0.5) },
    ],
  },
  rewards: { starThresholds: [50, 80, 100] },
};

/**
 * Stress test level — "压力测试" (not real content; S6 perf validation).
 *
 * Dumps a very large swarm across all 10 attack lanes in a short window so the
 * render layer (object pooling, draw batching) can be eyeballed for FPS on the
 * target device. Plenty of startCoins so the player can also spawn a counter-
 * swarm and push the concurrent unit count even higher.
 */
const CH_STRESS: LevelDefinition = {
  id: 'ch_stress',
  chapter: 0,
  seed: 0x1000f,
  objective: { kind: 'survive' },
  startCoins: 200,
  waves: {
    entries: ATTACK_LANES.flatMap((col, i) => [
      { atTick: s(1 + i * 0.1), unitType: UnitType.Swordsman, col, count: 12, spacingTicks: s(0.25) },
      { atTick: s(6 + i * 0.1), unitType: UnitType.Swordsman, col, count: 12, spacingTicks: s(0.25) },
    ]),
  },
  rewards: { starThresholds: [1, 1, 1] },
};

/** Registry of all campaign levels, keyed by id. */
export const CAMPAIGN_LEVELS: Record<string, LevelDefinition> = {
  [CH1_LV1.id]: CH1_LV1,
  [CH1_LV2.id]: CH1_LV2,
  [CH1_LV3.id]: CH1_LV3,
  [CH_STRESS.id]: CH_STRESS,
};

/** Ordered level ids — drives the level-select buttons (4th = swarm stress test). */
export const CAMPAIGN_LEVEL_ORDER: string[] = [CH1_LV1.id, CH1_LV2.id, CH1_LV3.id, CH_STRESS.id];

/** Look up a level by id, or null if unknown. */
export function getLevel(id: string): LevelDefinition | null {
  return CAMPAIGN_LEVELS[id] ?? null;
}
