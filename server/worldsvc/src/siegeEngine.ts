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
  type EngineCardInstance,
  type EngineEquipInv,
} from '@nw/engine';
import {
  buildSiegeBattle,
  SIEGE_BATTLE_TIMEOUT_TICKS,
  SIEGE_CHEAP_RATIO,
  CARD_BASE_SURVIVAL,
  CARD_INJURY_DURATION_MS,
  CARD_DEFS,
  type SiegeOutcome,
  type SiegeResolution,
  type CardInstance,
} from '@nw/shared';
import type { ArmyEntry, CardSLGState } from './db';

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
 * Max troop count `synthesizeArmy` can place without stacking multiple units on the same lane/row (ATTACK_LANES.length
 * distinct columns × the number of depths before `row` clamps to the opposing spawn row × HP_PER_UNIT). Beyond this,
 * round-robin placement runs out of board depth and units clog lanes, so the auto-battle can hit its hard time limit
 * (defender advantage) regardless of true combat strength — discovered while calibrating stronghold/crossing garrison
 * constants (a maxed drillYard+satchel raises both troopCap and per-march carry cap to 12,000, comfortably over this
 * cap). Only meaningful for synthesized (flat-troop, no real per-unit layout) armies — a real card/team army places
 * each unit at an explicit, level-schema-validated col/row and never collides regardless of total troops.
 */
export const SIEGE_SYNTH_ARMY_MAX_TROOPS = ATTACK_LANES.length * (TOP_SPAWN_ROW - BOTTOM_SPAWN_ROW + 1) * HP_PER_UNIT;

/**
 * Whether a siege should skip the deterministic engine and settle via the cheap linear `resolveSiege` instead
 * (§14.10 U7 / §16.5 A7 decision, SIEGE_CHEAP_RATIO): true when the attacker holds an overwhelming troop
 * advantage over the effective defense, or when a synthesized side's troop count would overflow
 * `synthesizeArmy`'s placement capacity (see {@link SIEGE_SYNTH_ARMY_MAX_TROOPS}) and congest the board
 * regardless of true strength. The overflow check is independent of the ratio: a lopsided-but-not-quite-10×
 * fight can still overflow the board and must not reach the engine either.
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

/**
 * Re-places an army onto DEFENDER spawn positions (ADR-026). A `teams[]` template is authored as an ATTACK formation
 * (units in the bottom half, owner0/Bottom rows); reused verbatim as a defender garrison it would spawn on the attacker's
 * side and the auto-battle degenerates (defenders never guard their base → attacker times out → defender wins by bias).
 * This mirrors synthesizeArmy(role='defender'): keep unitType + initialHp, reassign col/row across attack lanes starting
 * from the defender spawn row (row decreasing toward the battle zone). Pure, deterministic.
 */
export function toDefenderFormation(army: ReadonlyArray<GarrisonEntry>): GarrisonEntry[] {
  return army.map((e, i) => ({
    unitType: e.unitType,
    col: ATTACK_LANES[i % ATTACK_LANES.length]!,
    row: Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - Math.floor(i / ATTACK_LANES.length)),
    ...(e.initialHp != null ? { initialHp: e.initialHp } : {}),
  }));
}

/** Total deployed HP of an army layout = sum of each unit's initialHp (falling back to its blueprint full HP). Pure. (ADR-026 wave carry-over.) */
export function sumArmyHp(army: ReadonlyArray<GarrisonEntry>): number {
  let hp = 0;
  for (const e of army) hp += Math.max(0, Math.floor(e.initialHp ?? UNIT_BLUEPRINTS[e.unitType].hp));
  return hp;
}

/**
 * Scales an army layout's per-unit initialHp by `ratio` (0..1) to carry attacker survivors into the next defensive wave (ADR-026 §3).
 * Units that scale below 1 HP are dropped (they died). ratio is clamped to [0,1]; ratio≥1 returns a full-HP copy. Deterministic, pure.
 */
export function scaleArmyByRatio(army: ReadonlyArray<GarrisonEntry>, ratio: number): GarrisonEntry[] {
  const r = Math.max(0, Math.min(1, ratio));
  const out: GarrisonEntry[] = [];
  for (const e of army) {
    const full = e.initialHp ?? UNIT_BLUEPRINTS[e.unitType].hp;
    const hp = Math.floor(full * r);
    if (hp >= 1) out.push({ ...e, initialHp: hp });
  }
  return out;
}

/**
 * Resolves a card-based ArmyEntry[] to GarrisonEntry[] for the engine (CC-3, CHARACTER_CARDS_DESIGN §8.3).
 * For each entry with cardInstanceId: looks up CardInstance → CardDef.unitType; sets initialHp from cardState.currentTroops.
 * Entries without cardInstanceId (legacy synthesized/replay paths) are passed through as-is.
 * Entries whose card is missing from cardInv are skipped (defence against stale/migrated data).
 */
export function resolveCardArmy(
  army: ArmyEntry[],
  cardState: Record<string, CardSLGState>,
  cardInv: Record<string, CardInstance>,
): GarrisonEntry[] {
  const result: GarrisonEntry[] = [];
  for (const e of army) {
    if (!e.cardInstanceId) {
      // Legacy path: unitType must be present (synthesis / replay).
      if (e.unitType) {
        result.push({ unitType: e.unitType as UnitType, col: e.col, row: e.row, ...(e.initialHp != null ? { initialHp: e.initialHp } : {}) });
      }
      continue;
    }
    const instance = cardInv[e.cardInstanceId];
    if (!instance) continue; // card not found (stale reference); skip
    const def = CARD_DEFS[instance.defId];
    if (!def) continue; // unknown card definition; skip
    const troops = cardState[e.cardInstanceId]?.currentTroops ?? 0;
    result.push({ unitType: def.unitType as UnitType, col: e.col, row: e.row, initialHp: Math.max(0, troops) });
  }
  return result;
}

/**
 * Converts card instances from the meta save snapshot into EngineCardInstance[] for blueprint injection (CC-3).
 * Only includes instances referenced by the attacker's army. Unknown defId / unitType are silently skipped.
 */
export function toEngineCardInstances(
  army: ArmyEntry[],
  cardInv: Record<string, CardInstance>,
  equipmentInv: Record<string, unknown>,
): { cardInstances: EngineCardInstance[]; engEquipInv: EngineEquipInv } {
  const seen = new Set<string>();
  const cardInstances: EngineCardInstance[] = [];
  for (const e of army) {
    if (!e.cardInstanceId || seen.has(e.cardInstanceId)) continue;
    seen.add(e.cardInstanceId);
    const instance = cardInv[e.cardInstanceId];
    if (!instance) continue;
    const def = CARD_DEFS[instance.defId];
    if (!def) continue;
    cardInstances.push({
      id: instance.id,
      defId: instance.defId,
      unitType: def.unitType as UnitType,
      level: instance.level,
      gear: instance.gear as Record<string, string | undefined>,
    });
  }
  return { cardInstances, engEquipInv: equipmentInv as EngineEquipInv };
}

/** Post-battle card state updates for attacker cards (CC-3, CHARACTER_CARDS_DESIGN §7.1/§7.2). */
export interface CardStateUpdate {
  currentTroops: number;
  injuredUntil?: number;
}

/**
 * Computes per-card state updates after a siege battle (CC-3).
 * Uses a uniform attacker survival rate (total surviving HP / total deployed HP) applied proportionally
 * to each card's currentTroops. Cards whose HP reaches zero (total survivors == 0) are marked injured.
 * baseSurvival guarantees a minimum troop fraction even on full defeat (CHARACTER_CARDS_DESIGN §7.1).
 *
 * @param army            Attacker army entries with cardInstanceId
 * @param cardState       Current card state (for deployedTroops lookup)
 * @param attackerSurvivors Total attacker surviving HP from the engine
 * @param nowMs           Current time in ms (for injuredUntil calculation)
 */
export function computeCardStateUpdates(
  army: ArmyEntry[],
  cardState: Record<string, CardSLGState>,
  attackerSurvivors: number,
  nowMs: number,
): Record<string, CardStateUpdate> {
  const updates: Record<string, CardStateUpdate> = {};
  const cardIds = army.map((e) => e.cardInstanceId).filter((id): id is string => !!id);
  if (cardIds.length === 0) return updates;

  const totalDeployed = cardIds.reduce((s, id) => s + (cardState[id]?.currentTroops ?? 0), 0);
  // If no troops deployed, no state change needed.
  if (totalDeployed === 0) return updates;

  // Apply baseSurvival floor: even at 0 survivors, each card keeps baseSurvival fraction of its troops.
  const survivalRate = Math.max(
    CARD_BASE_SURVIVAL,
    Math.min(1, attackerSurvivors / totalDeployed),
  );
  const totalZero = attackerSurvivors === 0;

  for (const id of cardIds) {
    const deployed = cardState[id]?.currentTroops ?? 0;
    const newTroops = Math.round(deployed * survivalRate);
    const update: CardStateUpdate = { currentTroops: newTroops };
    if (totalZero) update.injuredUntil = nowMs + CARD_INJURY_DURATION_MS;
    updates[id] = update;
  }
  return updates;
}

/** Both-sides army layout and level parameters for a siege battle (attacker required; defender may be null = base-only). */
export interface SiegeBattleInput {
  /** Attacker army layout (GarrisonEntry[], each unit's initialHp = allocated troop strength). */
  attackerArmy: GarrisonEntry[];
  /** Defender defense config (garrison/defenderBuildings/defenderBaseLevel/defenderBaseHp); null = derive a symbolic base only. */
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null;
  /** Tile level used to derive a symbolic base when no custom defender config is provided. */
  tileLevel: number;
  /** Level seed (same seed for a siege → recalculation and replay are tick-for-tick identical). */
  seed: number;
  /** CC-3: attacker card instances for blueprint level + equipment injection. Replaces deprecated pveUpgrades/unitLevels/equipment. */
  cardInstances?: EngineCardInstance[];
  /** CC-3: equipment instance inventory for gear resolution. */
  equipmentInv?: EngineEquipInv;
  /** @deprecated use cardInstances+equipmentInv (CC-3). Retained for test paths that don't have cards yet. */
  pveUpgrades?: Record<string, number>;
  /** @deprecated use cardInstances+equipmentInv (CC-3). */
  unitLevels?: Record<string, number>;
  /** @deprecated use cardInstances+equipmentInv (CC-3). */
  equipment?: EngineEquipmentInput;
  /** Academy building seasonal blueprint buff (SLG_CITY_DESIGN P2): applied to attacker blueprints only; omit when academy=0. */
  siegeAcademy?: { hp: number; damage: number; siege: number };
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
  const { attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv, siegeAcademy } = input;

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
      cardInstances: cardInstances ?? [],
      equipmentInv,
      siegeAcademy },
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
