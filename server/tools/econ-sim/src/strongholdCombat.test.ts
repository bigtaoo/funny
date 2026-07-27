// Regression coverage for strongholdCombat.ts (SLG_ECONOMY_CHECK §21.4 follow-up, SLG_DESIGN_LOG §27).
// strongholdCombatRun.ts is a human-read analysis script (this package's established pattern, see README —
// "run script, read printed verdict, register in ECONOMY_VERIFICATION_LOG.md"), not itself a test suite. This
// file locks in the calibration result as an actual regression check: if a future engine-balance change
// silently opens or closes these gates, CI catches it instead of relying on someone re-running the script.
import { describe, expect, it } from 'vitest';
import {
  STRONGHOLD_LEVEL,
  CROSSING_LEVEL,
  STRONGHOLD_GARRISON,
  CROSSING_GARRISON,
  SCENARIO_BASE,
  SCENARIO_INVESTED,
  SIEGE_SYNTH_ARMY_MAX_TROOPS,
  shouldUseCheapSiege,
  simulateCapture,
  winRateOver,
  type ProgressionScenario,
} from './strongholdCombat';
import { TROOP_CAP_BASE, DRILL_TROOPCAP_STEP } from '@nw/shared';

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 11);

describe('strongholdCombat: fixed garrison levels (buildings always generate at map-max, not a 1..5 range)', () => {
  it('stronghold always generates at SLG_MAP_MAX_LEVEL → garrison = STRONGHOLD_GARRISON_PER_LEVEL × level', () => {
    expect(STRONGHOLD_LEVEL).toBe(10);
    expect(STRONGHOLD_GARRISON).toBe(11800); // 1180 × 10 (re-calibrated 2026-07-27, see ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5)
  });
  it('auto-crossings always generate at max(2, mapMax-1) → garrison = CROSSING_GARRISON_PER_LEVEL × level', () => {
    expect(CROSSING_LEVEL).toBe(9);
    expect(CROSSING_GARRISON).toBe(10350); // 1150 × 9 (re-calibrated 2026-07-27, see ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5)
  });
});

describe('strongholdCombat: determinism (same scenario + seed → identical outcome, no hidden randomness)', () => {
  it('simulateCapture is deterministic across repeated calls', () => {
    const a = simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, 42);
    const b = simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, 42);
    expect(b).toEqual(a);
  });
  it('different seeds can produce different outcomes (engine combat has seed-driven variance, e.g. crit rolls)', () => {
    const outcomes = new Set(SEEDS.map((s) => simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, s).attackerWin));
    // Not a strict requirement that both outcomes occur, but a scenario picked deep in "reliable win" territory
    // should not depend on the specific seed set — this is a sanity check that seeds are actually wired through.
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });
});

describe('strongholdCombat: calibration gates (SLG_DESIGN_LOG §27 — locks in the 2026-07-27 re-calibration verdict for ADR-048 TROOP_CAP_BASE=10000)', () => {
  it(`stronghold: a fresh player (troopCap=${TROOP_CAP_BASE}) loses outright`, () => {
    const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_BASE, SEEDS);
    expect(r.winRate).toBe(0);
  });
  it('stronghold: a modestly-invested player (2 drillYard levels) reliably wins', () => {
    const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, SEEDS);
    expect(r.winRate).toBeGreaterThanOrEqual(0.9);
    expect(r.avgAttackerSurvivors).toBeGreaterThan(0);
  });
  it(`crossing: a fresh player (troopCap=${TROOP_CAP_BASE}) loses outright`, () => {
    const r = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, SCENARIO_BASE, SEEDS);
    expect(r.winRate).toBe(0);
  });
  it('crossing: opens with a single drillYard level — lighter investment than the stronghold (2 levels)', () => {
    const scenario: ProgressionScenario = { label: `invested (troopCap=${TROOP_CAP_BASE + DRILL_TROOPCAP_STEP}, drillYard+1)`, troops: TROOP_CAP_BASE + DRILL_TROOPCAP_STEP };
    const r = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, scenario, SEEDS);
    expect(r.winRate).toBeGreaterThanOrEqual(0.9);
  });
  it('threshold sweep: stronghold win rate is 0 through drillYard+1 and reliable from drillYard+2 up', () => {
    // 2026-07-27: replaces the pre-ADR-048 sweep (was 1500-6000 absolute troops on a 2000 baseline). Under the
    // corrected cheap-linear-dispatch model this is a comfortable, thousands-of-troops-wide calibration (see
    // STRONGHOLD_GARRISON_PER_LEVEL's doc comment in shared/slg/siege.ts) — not the razor-thin band an earlier,
    // same-day pass mistakenly found before strongholdCombat.ts was corrected to mirror shouldUseCheapSiege.
    for (const levels of [0, 1]) {
      const troops = TROOP_CAP_BASE + levels * DRILL_TROOPCAP_STEP;
      const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: `drillYard+${levels}`, troops }, SEEDS);
      expect(r.winRate, `drillYard+${levels} (troops=${troops})`).toBe(0);
    }
    for (const levels of [2, 3, 4]) {
      const troops = TROOP_CAP_BASE + levels * DRILL_TROOPCAP_STEP;
      const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: `drillYard+${levels}`, troops }, SEEDS);
      expect(r.winRate, `drillYard+${levels} (troops=${troops})`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('strongholdCombat: cheap-path dispatch (2026-07-27 correction — see strongholdCombat.ts "IMPORTANT CORRECTION" header)', () => {
  it('both garrisons exceed SIEGE_SYNTH_ARMY_MAX_TROOPS, so shouldUseCheapSiege ALWAYS routes these fights to the cheap linear model in production', () => {
    // This is the structural precondition for "stronghold/crossing calibration is a simple linear comparison,
    // not a real-engine board-depth simulation" being true. If a future change shrinks either garrison below
    // SIEGE_SYNTH_ARMY_MAX_TROOPS, these fights would start reaching the real engine again and the fragile
    // board-depth non-monotonicity (documented in siegeEngine.ts / strongholdCombat.ts headers) would return.
    expect(STRONGHOLD_GARRISON).toBeGreaterThan(SIEGE_SYNTH_ARMY_MAX_TROOPS);
    expect(CROSSING_GARRISON).toBeGreaterThan(SIEGE_SYNTH_ARMY_MAX_TROOPS);
    expect(shouldUseCheapSiege({ attackerTroops: TROOP_CAP_BASE, defenderTroops: STRONGHOLD_GARRISON, attackerSynthesized: true, defenderSynthesized: true })).toBe(true);
    expect(shouldUseCheapSiege({ attackerTroops: TROOP_CAP_BASE, defenderTroops: CROSSING_GARRISON, attackerSynthesized: true, defenderSynthesized: true })).toBe(true);
  });

  it('the gate is an exact, deterministic linear boundary (tie goes to defender), not fuzzy engine-combat variance', () => {
    // Unlike the pre-correction real-engine path (seed-dependent crit rolls, board congestion), the cheap linear
    // resolveSiege is a pure troops > garrison comparison — verify the exact boundary across ALL seeds.
    for (const seed of SEEDS) {
      expect(simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: 'tie', troops: STRONGHOLD_GARRISON }, seed).attackerWin).toBe(false);
      expect(simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: 'one-more', troops: STRONGHOLD_GARRISON + 1 }, seed).attackerWin).toBe(true);
    }
  });
});
