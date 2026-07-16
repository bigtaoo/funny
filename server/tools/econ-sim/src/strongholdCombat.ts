// ─────────────────────────────────────────────────────────────────────────────
// Stronghold/crossing COMBAT-POWER calibration (SLG_ECONOMY_CHECK §21.4 follow-up, 2026-07-16).
//
// The A-track / stronghold-track runners (index.ts, strongholdRun.ts) validate the RESOURCE-FAUCET
// side of STRONGHOLD_GARRISON_PER_LEVEL / CROSSING_GARRISON_PER_LEVEL (density, dilution, one-off
// loot vs cap). They never actually fight the NPC garrison — "is this beatable, and by whom" was
// asserted from a napkin-HP comparison in the siege.ts source comments, not measured.
//
// This module answers that with the real deterministic `@nw/engine` driving the exact same
// `buildSiegeBattle` (attacker army + defender garrison + dual bases + timeout) construction worldsvc
// uses (server/worldsvc/src/siegeEngine.ts `runSiegeBattle`) — reimplemented standalone here (same
// pattern as client/test/pvpSim.ts: a self-contained sim reusing @nw/engine primitives directly,
// rather than importing worldsvc's module, which would pull cross-package relative paths outside this
// package's tsc rootDir). Reusing the production engine (rather than re-deriving a parallel
// Lanchester-style formula, as siegeRun.ts does for the cheap-path C-track) is deliberate:
// stronghold/crossing sieges always go through the real engine, so any answer not measured through
// that exact mechanic could be wrong in a way a formula-based check would never catch.
//
// Both NPC garrisons are effectively FIXED-level in practice (not a 1..5 range as the old siege.ts
// comments implied): strongholds always generate at SLG_MAP_MAX_LEVEL (§14/stronghold.ts), and
// auto-crossings always generate at max(2, SLG_MAP_MAX_LEVEL-1) (mapgen.ts:216). So this only needs
// to test one garrison size per building type, across a spread of attacker troop-count scenarios.
// ─────────────────────────────────────────────────────────────────────────────

import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  UnitType,
  Side,
  ATTACK_LANES,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
  parseLevelDefinition,
  type GarrisonEntry,
} from '@nw/engine';
import {
  buildSiegeBattle,
  strongholdGarrison,
  passageGarrison,
  SLG_MAP_MAX_LEVEL,
  TROOP_CAP_BASE,
  DRILL_TROOPCAP_STEP,
} from '@nw/shared';

/** Real garrison sizes at the levels these buildings actually generate at (not a hypothetical 1..5 range). */
export const STRONGHOLD_LEVEL = SLG_MAP_MAX_LEVEL; // strongholds always spawn at map max level
export const CROSSING_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1); // mapgen.ts _crossingTile
export const STRONGHOLD_GARRISON = strongholdGarrison(STRONGHOLD_LEVEL);
export const CROSSING_GARRISON = passageGarrison(CROSSING_LEVEL);

// Default synthesized unit = Infantry (mirrors worldsvc/src/siegeEngine.ts SYNTH_UNIT; troops = HP, §16.1).
const HP_PER_UNIT = UNIT_BLUEPRINTS[UnitType.Infantry].hp;
const TICK_MARGIN = 600; // same margin as siegeEngine.ts, guards against pathological stalemates

/** Deterministic round-robin army layout from a flat troop count (mirrors siegeEngine.ts synthesizeArmy). */
function synthesizeArmy(troops: number, role: 'attacker' | 'defender'): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  if (remaining <= 0) return [];
  const n = Math.ceil(remaining / HP_PER_UNIT);
  const army: GarrisonEntry[] = [];
  for (let i = 0; i < n; i++) {
    const hp = Math.min(HP_PER_UNIT, remaining);
    remaining -= hp;
    const col = ATTACK_LANES[i % ATTACK_LANES.length]!;
    const depth = Math.floor(i / ATTACK_LANES.length);
    const row = role === 'attacker'
      ? Math.min(TOP_SPAWN_ROW, BOTTOM_SPAWN_ROW + depth)
      : Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - depth);
    army.push({ unitType: UnitType.Infantry, col, row, initialHp: hp });
  }
  return army;
}

export interface ProgressionScenario {
  label: string;
  /** Total committed troops for this single siege deployment (bounded by the satchel per-march carry cap, city.ts). */
  troops: number;
}

/** Fresh/new player: base troop cap (drillYard=0), no satchel investment. Design intent: "nearly always lose". */
export const SCENARIO_BASE: ProgressionScenario = { label: 'fresh (troopCap=2000)', troops: TROOP_CAP_BASE };
/**
 * Mildly-invested player: drillYard/satchel raised ~2-3 levels (troops 4000-5000) — the empirically-found
 * threshold where the stronghold flips winnable (see strongholdCombatRun.ts sweep). NOT "maxed" — deliberately
 * modest, to show the gate opens well before endgame investment.
 */
export const SCENARIO_INVESTED: ProgressionScenario = { label: 'invested (troopCap=4500, drillYard~3)', troops: TROOP_CAP_BASE + 2 * DRILL_TROOPCAP_STEP + 500 };
// Deliberately NOT tested here: a maxed troopCap/satchel deployment (12,000 troops in one march) hits a
// separate, genuine engine limitation — synthesizeArmy's round-robin placement runs out of board depth
// (10 attack lanes × 16 spawnable rows ≈ 9,600-troop capacity at 60 HP/unit) and produces non-monotonic,
// occasionally-losing outcomes purely from lane congestion / battle-timeout, unrelated to the garrison
// constants below. `SIEGE_CHEAP_RATIO` (shared/slg/siege.ts) was designed to route lopsided fights like this
// away from the real engine, but is not actually wired into worldsvc's stronghold/crossing siege dispatch
// (combatSiege/arrival.ts calls runSiegeBattle unconditionally) — flagged as a follow-up, see SLG_DESIGN_LOG §21.4.
//
// Also deliberately not tested: unit-level (equipment/card) progression. Even if wired, siege blueprints
// are ONE shared table for the whole board (@nw/engine engine/base.ts), so a per-unit-type buff would lift
// attacker AND defender Infantry equally — troop count is the only lever that differentiates this same-type
// matchup, which is what this harness varies.

/**
 * Runs one authoritative siege (real `@nw/engine`) and returns whether the attacker won.
 * Deterministic — same scenario + seed → identical result.
 */
export function simulateCapture(garrison: number, tileLevel: number, scenario: ProgressionScenario, seed: number): { attackerWin: boolean; attackerSurvivors: number } {
  const attackerArmy = synthesizeArmy(scenario.troops, 'attacker');
  const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
  const levelObj = buildSiegeBattle({ army: attackerArmy }, defenderConfig, tileLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless({ seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level }, input, timeout + TICK_MARGIN);
  let atkHp = 0;
  for (const unit of engine.state.board.units.values()) {
    if (unit.side === Side.Bottom) atkHp += unit.hp;
  }
  return { attackerWin: engine.state.winner === Side.Bottom, attackerSurvivors: atkHp };
}

/** Win rate for a scenario across N seeds (siege outcome depends on seed via engine PRNG-driven combat variance, e.g. crit rolls). */
export function winRateOver(garrison: number, tileLevel: number, scenario: ProgressionScenario, seeds: number[]): { winRate: number; avgAttackerSurvivors: number } {
  let wins = 0;
  let survivorSum = 0;
  for (const seed of seeds) {
    const r = simulateCapture(garrison, tileLevel, scenario, seed);
    if (r.attackerWin) { wins++; survivorSum += r.attackerSurvivors; }
  }
  return { winRate: wins / seeds.length, avgAttackerSurvivors: wins > 0 ? survivorSum / wins : 0 };
}
