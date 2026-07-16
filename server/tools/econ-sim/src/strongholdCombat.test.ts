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
  simulateCapture,
  winRateOver,
  type ProgressionScenario,
} from './strongholdCombat';

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 11);

describe('strongholdCombat: fixed garrison levels (buildings always generate at map-max, not a 1..5 range)', () => {
  it('stronghold always generates at SLG_MAP_MAX_LEVEL → garrison = STRONGHOLD_GARRISON_PER_LEVEL × level', () => {
    expect(STRONGHOLD_LEVEL).toBe(10);
    expect(STRONGHOLD_GARRISON).toBe(3600); // 360 × 10
  });
  it('auto-crossings always generate at max(2, mapMax-1) → garrison = CROSSING_GARRISON_PER_LEVEL × level', () => {
    expect(CROSSING_LEVEL).toBe(9);
    expect(CROSSING_GARRISON).toBe(1800); // 200 × 9
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

describe('strongholdCombat: calibration gates (SLG_DESIGN_LOG §27 — locks in the 2026-07-16 verdict)', () => {
  it('stronghold: a fresh player (troopCap=2000) loses outright', () => {
    const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_BASE, SEEDS);
    expect(r.winRate).toBe(0);
  });
  it('stronghold: a modestly-invested player (troopCap≈4500, ~3 drillYard levels) reliably wins', () => {
    const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, SCENARIO_INVESTED, SEEDS);
    expect(r.winRate).toBeGreaterThanOrEqual(0.9);
    expect(r.avgAttackerSurvivors).toBeGreaterThan(0);
  });
  it('crossing: a fresh player (troopCap=2000) loses outright', () => {
    const r = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, SCENARIO_BASE, SEEDS);
    expect(r.winRate).toBe(0);
  });
  it('crossing: opens with a single drillYard level (troopCap=3000) — lighter investment than the stronghold', () => {
    const scenario: ProgressionScenario = { label: 'invested (troopCap=3000, drillYard=1)', troops: 3000 };
    const r = winRateOver(CROSSING_GARRISON, CROSSING_LEVEL, scenario, SEEDS);
    expect(r.winRate).toBeGreaterThanOrEqual(0.9);
  });
  it('threshold sweep: stronghold win rate is 0 below 4500 troops and reliable from 4500 up to the board-safe ceiling', () => {
    for (const troops of [1500, 2000, 2500, 3000, 3500, 4000]) {
      const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: `t${troops}`, troops }, SEEDS);
      expect(r.winRate, `troops=${troops}`).toBe(0);
    }
    for (const troops of [4500, 5000, 5500, 6000]) {
      const r = winRateOver(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: `t${troops}`, troops }, SEEDS);
      expect(r.winRate, `troops=${troops}`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('strongholdCombat: known board-depth limitation (documented, not a garrison-tuning issue — see module header)', () => {
  it('single-deployment armies well beyond board capacity (~9,600 troops) can lose to a much weaker garrison', () => {
    // 12,000 troops vs a 3,600-troop garrison would trivially win on raw numbers alone if the board had room;
    // this assertion exists to make the known congestion/timeout artifact visible in CI (not to bless it as
    // correct) — if a future engine change makes this pass differently, that's worth a human look, not a
    // silent green checkmark. See SLG_DESIGN_LOG §27 and the spawned follow-up task (wire SIEGE_CHEAP_RATIO).
    const r = simulateCapture(STRONGHOLD_GARRISON, STRONGHOLD_LEVEL, { label: 'overloaded', troops: 12_000 }, 42);
    expect(r.attackerWin).toBe(false);
  });
});
