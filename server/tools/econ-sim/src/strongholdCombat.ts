// ─────────────────────────────────────────────────────────────────────────────
// Stronghold/crossing COMBAT-POWER calibration (SLG_ECONOMY_CHECK §21.4 follow-up, 2026-07-16;
// corrected 2026-07-27, see the "IMPORTANT CORRECTION" block below before trusting anything about
// "board-depth fragility" you may have seen in an earlier version of this file or of the verification log).
//
// The A-track / stronghold-track runners (index.ts, strongholdRun.ts) validate the RESOURCE-FAUCET
// side of STRONGHOLD_GARRISON_PER_LEVEL / CROSSING_GARRISON_PER_LEVEL (density, dilution, one-off
// loot vs cap). They never actually fight the NPC garrison — "is this beatable, and by whom" was
// asserted from a napkin-HP comparison in the siege.ts source comments, not measured.
//
// This module answers that by reproducing worldsvc's ACTUAL production decision (server/worldsvc/src/
// siegeEngine.ts `shouldUseCheapSiege` + combatSiege/arrival.ts, wired in commit 13a7af86, 2026-07-16):
// most stronghold/crossing garrisons are large enough to overflow `synthesizeArmy`'s board-placement
// capacity, so production deliberately SKIPS the real `@nw/engine` auto-battle and settles via the cheap
// linear `resolveSiege` (attacker wins iff troops > garrison) instead. This module mirrors that same
// routing decision (see `shouldUseCheapSiege`/`SIEGE_SYNTH_ARMY_MAX_TROOPS` below, kept in lockstep with
// siegeEngine.ts's copy — duplicated rather than imported because this package cannot depend on the
// worldsvc service package, see the tsc-rootDir note in strongholdCombatRun.ts's original header).
//
// ⚠️ IMPORTANT CORRECTION (2026-07-27): the 2026-07-16 first pass of this file called the real engine
// UNCONDITIONALLY (no shouldUseCheapSiege mirror at all) and used that to hand-tune STRONGHOLD_GARRISON_PER_LEVEL
// /CROSSING_GARRISON_PER_LEVEL around the engine's ~9,600-troop board-depth cliff — appropriate at the time,
// since TROOP_CAP_BASE was 2000 and no realistic garrison came anywhere near that cliff. When ADR-048
// (2026-07-22) raised TROOP_CAP_BASE to 10000, a same-day-but-earlier commit (13a7af86, 2026-07-16 15:20,
// i.e. LATER THE SAME DAY as this file's original version) had ALREADY wired shouldUseCheapSiege's overflow
// guard into production specifically to route around that cliff — but this standalone file was never updated
// to mirror it. The result: an initial 2026-07-27 recalibration pass of this file (since corrected) spent a lot
// of effort hand-tuning STRONGHOLD_GARRISON_PER_LEVEL/CROSSING_GARRISON_PER_LEVEL to a razor-thin ~100-175-troop
// "safe band" that dodged the real engine's board-depth cliff — a problem that DOES NOT ACTUALLY OCCUR IN
// PRODUCTION, because any garrison this large already triggers the overflow guard and never reaches the real
// engine at all. Moral: keep this file's routing logic in lockstep with siegeEngine.ts, or recalibrations here
// will optimize for a mechanism production doesn't use. See ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5
// for the full incident writeup.
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
  fromFp,
  type GarrisonEntry,
} from '@nw/engine';
import {
  buildSiegeBattle,
  strongholdGarrison,
  passageGarrison,
  resolveSiege,
  SLG_MAP_MAX_LEVEL,
  TROOP_CAP_BASE,
  DRILL_TROOPCAP_STEP,
  SIEGE_CHEAP_RATIO,
} from '@nw/shared';

/** Real garrison sizes at the levels these buildings actually generate at (not a hypothetical 1..5 range). */
export const STRONGHOLD_LEVEL = SLG_MAP_MAX_LEVEL; // strongholds always spawn at map max level
export const CROSSING_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1); // mapgen.ts _crossingTile
export const STRONGHOLD_GARRISON = strongholdGarrison(STRONGHOLD_LEVEL);
export const CROSSING_GARRISON = passageGarrison(CROSSING_LEVEL);

// Default synthesized unit = Infantry (mirrors worldsvc/src/siegeEngine.ts SYNTH_UNIT; troops = HP, §16.1).
// ADR-065: UNIT_BLUEPRINTS is fp-scaled internally; fromFp() converts back to real units here.
const HP_PER_UNIT = fromFp(UNIT_BLUEPRINTS[UnitType.Infantry].hp_fp);
const TICK_MARGIN = 600; // same margin as siegeEngine.ts, guards against pathological stalemates

/**
 * Max troop count `synthesizeArmy` can place without lane/row collisions (10 attack lanes × 16 spawnable
 * rows × 60 HP/unit). Mirrors `SIEGE_SYNTH_ARMY_MAX_TROOPS` in worldsvc/src/siegeEngine.ts exactly — keep
 * these two in lockstep (see the IMPORTANT CORRECTION note above for what happens when they drift apart).
 */
export const SIEGE_SYNTH_ARMY_MAX_TROOPS = ATTACK_LANES.length * (TOP_SPAWN_ROW - BOTTOM_SPAWN_ROW + 1) * HP_PER_UNIT;

/**
 * Mirrors worldsvc/src/siegeEngine.ts `shouldUseCheapSiege` exactly: whether a siege skips the real engine
 * and settles via the cheap linear `resolveSiege` instead — true when a synthesized side would overflow
 * board capacity (independent of the ratio check), or when the attacker holds an overwhelming ratio advantage.
 * Both stronghold and crossing garrisons are ALWAYS synthesized (no real per-unit layout), so in practice: any
 * garrison above {@link SIEGE_SYNTH_ARMY_MAX_TROOPS} makes this always true, for every attacker, regardless of
 * the attacker's own army composition or size.
 */
export function shouldUseCheapSiege(opts: {
  attackerTroops: number;
  defenderTroops: number;
  attackerSynthesized: boolean;
  defenderSynthesized: boolean;
}): boolean {
  const { attackerTroops, defenderTroops, attackerSynthesized, defenderSynthesized } = opts;
  if (attackerSynthesized && attackerTroops > SIEGE_SYNTH_ARMY_MAX_TROOPS) return true;
  if (defenderSynthesized && defenderTroops > SIEGE_SYNTH_ARMY_MAX_TROOPS) return true;
  if (attackerTroops <= 0) return false;
  return defenderTroops > 0 ? attackerTroops >= defenderTroops * SIEGE_CHEAP_RATIO : true;
}

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
export const SCENARIO_BASE: ProgressionScenario = { label: `fresh (troopCap=${TROOP_CAP_BASE})`, troops: TROOP_CAP_BASE };
/** drillYard levels at which each gate first flips winnable under the cheap linear model (strongholdCombatRun.ts). */
export const STRONGHOLD_OPEN_DRILL_LEVELS = 5;
export const CROSSING_OPEN_DRILL_LEVELS = 4;
/**
 * Invested player: drillYard raised {@link STRONGHOLD_OPEN_DRILL_LEVELS} levels — the threshold where the
 * STRONGHOLD (heavier gate) flips winnable under the cheap linear model (see strongholdCombatRun.ts). The
 * CROSSING (lighter gate) opens a level earlier, at {@link CROSSING_OPEN_DRILL_LEVELS}; that scenario is built
 * inline where tested (e.g. strongholdCombat.test.ts) rather than exported here, since the two buildings
 * intentionally open at different investment levels.
 *
 * 2026-08-25 re-tune (TROOP_CAP_BASE 10000→5000, DRILL_TROOPCAP_STEP 1000→1500, garrisons deliberately held
 * fixed): was `drillYard+2` / crossing at `+1`. The gates moved out by 3 levels each — intended, see
 * TROOP_CAP_BASE's doc comment. Note the levels are no longer sufficient on their own: `troops` here is a
 * *deployment*, and the satchel per-march carry cap (SATCHEL_CARRY_BASE=TROOP_CAP_BASE=5000, +1500/level)
 * means a real attacker also needs satchel ~L5 to physically carry 12500 into one siege. That coupling
 * predates this re-tune (satchel ~L2 was needed under the old baseline) and is still not modelled here.
 *
 * 2026-07-27 re-calibration (ADR-048 TROOP_CAP_BASE 2000→10000): was `troopCap=4500, drillYard~3` under the
 * pre-ADR-048 baseline. Both garrisons now comfortably exceed {@link SIEGE_SYNTH_ARMY_MAX_TROOPS}, so — per the
 * IMPORTANT CORRECTION in this file's header — production always resolves these fights via the cheap linear
 * `resolveSiege` (attacker wins iff troops > garrison), not the real engine. That makes this a simple,
 * comfortable (multi-thousand-troop-margin) calibration, unlike the razor-thin band a naive real-engine-only
 * simulation would suggest.
 */
export const SCENARIO_INVESTED: ProgressionScenario = {
  label: `invested (troopCap=${TROOP_CAP_BASE + STRONGHOLD_OPEN_DRILL_LEVELS * DRILL_TROOPCAP_STEP}, drillYard+${STRONGHOLD_OPEN_DRILL_LEVELS})`,
  troops: TROOP_CAP_BASE + STRONGHOLD_OPEN_DRILL_LEVELS * DRILL_TROOPCAP_STEP,
};
// Deliberately NOT tested here: unit-level (equipment/card) progression. Under the cheap linear path this is
// low-risk to ignore: an equipment/academy attacker-power bonus (up to +20% elsewhere, see
// SLG_NPC_BASE_HP_PER_LEVEL's doc comment) just proportionally raises effective troops in a straight-line
// formula — it can shift WHICH drillYard level first opens the gate, but never produces a non-monotonic
// surprise the way it would have under the real-engine board-depth regime this file used to (incorrectly)
// simulate. Also unaffected: a maxed troopCap/satchel deployment (SATCHEL_CARRY_BASE + 10 satchel levels =
// 20,000 troops) — comfortably a cheap-path win against either garrison, no board-depth congestion risk at all
// once the cheap path is correctly modeled (see `simulateCapture` below).

/**
 * Runs one authoritative siege and returns whether the attacker won — mirroring worldsvc's actual dispatch:
 * `shouldUseCheapSiege` first (both garrisons here are always synthesized, matching production), falling back
 * to the real `@nw/engine` auto-battle only when neither side would overflow the board and the fight isn't
 * ratio-overwhelming. Deterministic in both branches — same scenario + seed → identical result (the cheap
 * branch is deterministic regardless of seed).
 */
export function simulateCapture(garrison: number, tileLevel: number, scenario: ProgressionScenario, seed: number): { attackerWin: boolean; attackerSurvivors: number } {
  if (shouldUseCheapSiege({ attackerTroops: scenario.troops, defenderTroops: garrison, attackerSynthesized: true, defenderSynthesized: true })) {
    const res = resolveSiege(scenario.troops, garrison);
    return { attackerWin: res.outcome === 'attacker_win', attackerSurvivors: res.attackerSurvivors };
  }
  const attackerArmy = synthesizeArmy(scenario.troops, 'attacker');
  const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
  const levelObj = buildSiegeBattle({ army: attackerArmy }, defenderConfig, tileLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless({ seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level }, input, timeout + TICK_MARGIN);
  let atkHp = 0;
  for (const unit of engine.state.board.units.values()) {
    // ADR-065: unit.hp_fp is fp — fromFp() converts back to real units at this boundary.
    if (unit.side === Side.Bottom) atkHp += fromFp(unit.hp_fp);
  }
  return { attackerWin: engine.state.winner === Side.Bottom, attackerSurvivors: atkHp };
}

/** Win rate for a scenario across N seeds (only varies when the real engine runs — the cheap linear path is
 *  deterministic and gives the same win/loss for every seed; kept plural for a uniform call signature). */
export function winRateOver(garrison: number, tileLevel: number, scenario: ProgressionScenario, seeds: number[]): { winRate: number; avgAttackerSurvivors: number } {
  let wins = 0;
  let survivorSum = 0;
  for (const seed of seeds) {
    const r = simulateCapture(garrison, tileLevel, scenario, seed);
    if (r.attackerWin) { wins++; survivorSum += r.attackerSurvivors; }
  }
  return { winRate: wins / seeds.length, avgAttackerSurvivors: wins > 0 ? survivorSum / wins : 0 };
}
