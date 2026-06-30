// Authoritative siege battle for worldsvc (G3-2b, SLG_DESIGN §16).
//
// This is the keystone moment of "closing the load-bearing arch": worldsvc directly imports the
// deterministic engine (`@nw/engine`, pure TS, no PIXI) and runs "both-sides pre-deployment auto-battle"
// headless to obtain the authoritative win/loss result and real surviving HP, replacing the old
// cheap linear formula `resolveSiege`. M12 (§14.1) classifies this as "an extension of the judge exception" —
// the engine runs authoritatively inside the server process.
//
// Battle model (§16.1): troop count = unit HP. Attacker deploys in the bottom half (owner0/Bottom);
// defender garrison deploys in the top half (owner1/Top); both bases present; objective:destroy_base;
// hard battle tick limit. No live commands → the battle is uniquely determined by `seed + both armies`.
// Destroying the enemy base wins; timeout with both bases intact → defender wins (defender bias).
// After battle, the sum of surviving unit HP on each side = that side's surviving troops, returned to the troop pool (§16.5).
//
// engineVersion pin (U9): the engine exports `ENGINE_VERSION`; upgrading the engine mid-season requires pinning;
// worldsvc must be rebuilt with each engine version change (cost: D0+P2). The seed/army layout
// produced by this module is fully serializable; clients can replay the battle locally using the same seed.

import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  Side,
  UnitType,
  ATTACK_LANES,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
  parseLevelDefinition,
  type GarrisonEntry,
  type EngineEquipmentInput,
} from '@nw/engine';
import {
  buildSiegeBattle,
  SIEGE_BATTLE_TIMEOUT_TICKS,
  type SiegeOutcome,
  type SiegeResolution,
} from '@nw/shared';

/** Default synthesized unit type = Infantry (basic melee, full HP 60 = unit troop equivalent). §16.5 full-HP capacity table is pending tuning. */
const SYNTH_UNIT = UnitType.Infantry;
const HP_PER_UNIT = UNIT_BLUEPRINTS[SYNTH_UNIT].hp;

/** Extra tick margin for bad army layouts / pathological stalemates (same pattern as §16.6 judgeRunner: time limit + margin to prevent infinite loops). */
const TICK_MARGIN = 600;

/**
 * Synthesizes a deterministic default army layout from a flat troop count (G3-2b v1 bridge).
 * The current SLG data model still stores flat troop counts (`march.troops` / `tile.garrison`).
 * Until the army editor (G3-2c) lands, this converts a troop count into a GarrisonEntry[] army:
 * each unit's initialHp ≤ full-HP capacity (troops = HP), spread across attack lanes in round-robin order.
 *
 * - attacker (owner0/Bottom): placed starting from the attacker spawn row (row 1), moving toward the battle zone (row increasing).
 * - defender (owner1/Top): placed starting from the defender spawn row (row 16), moving toward the battle zone (row decreasing).
 *
 * Pure function, deterministic (same input → same output). Once the G3-2c editor is integrated,
 * real army layouts are read from `tile.defense` / `playerWorld.teams[]`; this synthesis is only
 * the fallback for the "no layout set" case.
 */
export function synthesizeArmy(troops: number, role: 'attacker' | 'defender'): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  if (remaining <= 0) return [];
  const n = Math.ceil(remaining / HP_PER_UNIT);
  const army: GarrisonEntry[] = [];
  for (let i = 0; i < n; i++) {
    const hp = Math.min(HP_PER_UNIT, remaining);
    remaining -= hp;
    const col = ATTACK_LANES[i % ATTACK_LANES.length]!;
    const depth = Math.floor(i / ATTACK_LANES.length);
    const row =
      role === 'attacker'
        ? Math.min(TOP_SPAWN_ROW, BOTTOM_SPAWN_ROW + depth)
        : Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - depth);
    army.push({ unitType: SYNTH_UNIT, col, row, initialHp: hp });
  }
  return army;
}

/**
 * Validates an attacker army layout (called when saving a team template, G3-2c). Reuses the engine-side
 * levelSchema: packs the army into a symbolic siege level and passes it through `parseLevelDefinition`;
 * invalid unitType/column/row or out-of-bounds values throw an error (caller maps to SlgError).
 * Pure validation, no side effects. An empty army ([]) is valid (= empty team slot).
 */
export function validateAttackerArmy(army: unknown): void {
  if (!Array.isArray(army)) throw new Error('army must be an array');
  if (army.length === 0) return;
  const levelObj = buildSiegeBattle({ army }, null, 1, 0);
  parseLevelDefinition(levelObj); // throws = invalid army layout
}

/**
 * Validates a defender defense config (called when saving from the editor, G3-2c). Same as validateAttackerArmy
 * but for the defender half: packs the config (garrison/defenderBuildings/defenderBaseLevel) into a
 * symbolic siege level and passes it through levelSchema. Throws on invalid data.
 * Empty config / no garrison is valid (= base-only defense).
 */
export function validateDefenseConfig(config: unknown): void {
  if (config == null) return;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('defense config must be an object');
  const levelObj = buildSiegeBattle(null, config as Record<string, unknown>, 1, 0);
  parseLevelDefinition(levelObj); // throws = invalid layout
}

/**
 * Scales the initialHp of each unit in an army layout by `factor` (floor, minimum 1).
 * Used for the national defense bonus on custom defender armies (§2.4 / G1 item②):
 * garrison strength is boosted inside the owning faction's capital Voronoi region.
 * The engine's Unit constructor caps HP at the blueprint maximum, so units below full HP benefit
 * while already-full units are naturally capped (v1 behavior, DRAFT — subject to tuning). Pure function.
 */
export function scaleArmyHp(
  army: ReadonlyArray<GarrisonEntry>,
  factor: number,
): GarrisonEntry[] {
  if (factor <= 1) return army.map((e) => ({ ...e }));
  return army.map((e) => ({
    ...e,
    initialHp: Math.max(1, Math.floor((e.initialHp ?? UNIT_BLUEPRINTS[e.unitType].hp) * factor)),
  }));
}

/** Both-sides army layout and level parameters for a siege battle (attacker required; defender may be null = base-only). */
export interface SiegeBattleInput {
  /** Attacker army layout (GarrisonEntry[], each unit's initialHp = allocated troop strength). */
  attackerArmy: GarrisonEntry[];
  /** Defender defense config (garrison/defenderBuildings/defenderBaseLevel); null = derive a symbolic base only. */
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null;
  /** Tile level used to derive a symbolic base when no custom defender config is provided. */
  tileLevel: number;
  /** Level seed (same seed for a siege → recalculation and replay are tick-for-tick identical). */
  seed: number;
  /** Attacker progression snapshot (E8 SLG integration): default = no upgrades, blueprints keep base values (does not block marching). */
  pveUpgrades?: Record<string, number>;
  unitLevels?: Record<string, number>;
  equipment?: EngineEquipmentInput;
  /** Academy building seasonal blueprint buff (SLG_CITY_DESIGN P2): applied to attacker blueprints only; omit when academy=0. */
  siegeAcademy?: { hp: number; damage: number };
}

/**
 * Runs one authoritative headless siege auto-battle → {@link SiegeResolution} (outcome + real surviving troops for both sides).
 *
 * Flow: `buildSiegeBattle` (attacker army + defender garrison + both bases + tick limit) →
 * `parseLevelDefinition` validation (P2, engine-side levelSchema) →
 * `runHeadless` in siege mode until GameOver or tick limit →
 * read `state.winner` to determine outcome, accumulate `board.units` surviving HP per side to determine survivors.
 * winner=Bottom(owner0) = attacker destroyed the base; otherwise = defender holds.
 *
 * Deterministic: same seed + same armies → tick-for-tick identical (fixed-point arithmetic + injected PRNG).
 * Settlement goes through the single landing point at service.landSiege (G3-1), decoupled from this function.
 */
export function runSiegeBattle(input: SiegeBattleInput): SiegeResolution {
  const { attackerArmy, defenderConfig, tileLevel, seed, pveUpgrades, unitLevels, equipment, siegeAcademy } = input;

  const levelObj = buildSiegeBattle({ army: attackerArmy }, defenderConfig, tileLevel, seed);
  // P2: The defense config is a restricted subset of the engine LevelDefinition; validated via levelSchema
  // (a bad config throws, caught by applySiege; dirty data must not enter the engine).
  const level = parseLevelDefinition(levelObj);

  const timeout = level.battleTimeoutTicks ?? SIEGE_BATTLE_TIMEOUT_TICKS;
  const input$ = new ReplayInputSource({
    engineVersion: ENGINE_VERSION,
    mode: 'siege',
    seed,
    frames: [],
    endFrame: 0,
  });

  const { engine } = runHeadless(
    { seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level,
      pveUpgrades, unitLevels, equipment, siegeAcademy },
    input$,
    timeout + TICK_MARGIN,
  );

  // Accumulate surviving unit HP for both sides = real surviving troops (§16.5 survivor return to pool).
  let atkHp = 0;
  let defHp = 0;
  for (const unit of engine.state.board.units.values()) {
    if (unit.isDead) continue;
    if (unit.side === Side.Bottom) atkHp += unit.hp;
    else defHp += unit.hp;
  }

  // winner=Bottom(owner0) = attacker destroyed the base and captured the tile; all other cases (Top wins / timeout / null fallback) = defense holds.
  const outcome: SiegeOutcome = engine.state.winner === Side.Bottom ? 'attacker_win' : 'defender_win';
  if (outcome === 'attacker_win') {
    // Tile captured: attacker survivors return (become new garrison / return to home city); defender is considered routed, no survivors left.
    return { outcome, attackerSurvivors: Math.floor(atkHp), defenderSurvivors: 0 };
  }
  // Defense holds: defender survivors remain at the tile; attacker survivors retreat and return to the troop pool.
  return { outcome, attackerSurvivors: Math.floor(atkHp), defenderSurvivors: Math.floor(defHp) };
}
