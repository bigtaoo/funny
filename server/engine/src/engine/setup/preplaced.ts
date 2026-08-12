// Create pre-placed entities for a campaign/siege level — verbatim extract of
// engine/base.ts's old constructor (escorts / SLG defense config: garrison,
// attackerArmy, defenderBuildings, defenderBaseLevel, defenderBaseHp).
//
// Escorts push directly into state.escorts (already a GameState field); garrison/
// attackerArmy/defenderBuildings are both added to the live board (a state side effect,
// same as before) AND returned so the caller can wire them into EngineCtx for
// emitInitialEvents' one-shot spawn events.
import { TOP_BUILDING_ROW } from '../../config';
import { Building } from '../../Building';
import { EscortUnit } from '../../EscortUnit';
import type { GameState } from '../../GameState';
import type { LevelDefinition } from '../../campaign/LevelDefinition';
import { Side, type UnitBlueprint, type UnitType } from '../../types';
import { Unit } from '../../Unit';

export interface PreplacedEntities {
  garrisonUnits: Unit[];
  attackerArmyUnits: Unit[];
  defenderBuildingList: Building[];
}

export function createPreplacedEntities(
  state: GameState,
  level: LevelDefinition,
  // 2026-08-12 fix: the Top-side garrison below deliberately reads THIS table, not
  // `state.unitBlueprints` — see blueprints.ts/pveUpgrades.ts buildSiegeGarrisonBlueprints' doc
  // comment for why the two must never be the same object for mode==='siege'.
  enemyWaveBlueprints: Record<UnitType, UnitBlueprint>,
): PreplacedEntities {
  // Escort units (§4.9.3): created here so they're ready for emitInitialEvents.
  if (level.escorts) {
    for (const spec of level.escorts) {
      state.escorts.push(new EscortUnit(spec, state.allocEscortId()));
    }
  }

  // SLG defense config (U10) — garrison, defender buildings, base level. These three
  // knobs let a player-authored defense config pre-shape the battle exactly like a
  // hand-crafted campaign level would.

  // Garrison: pre-placed Top-side units at their specified mid-field positions. Tracked
  // in garrisonUnits[] so emitInitialEvents() can emit spawn events.
  // 2026-08-12 fix: reads `enemyWaveBlueprints`, NOT `state.unitBlueprints` — the latter is the
  // ATTACKER's own leveled/equipped/academy-buffed table (buildSiegeBlueprints keys purely off the
  // attacker's cardInstances/equipmentInv, no side concept). Using it here meant leveling up your
  // own "infantry" card silently buffed a same-typed NPC garrison by the same multiplier. See
  // pveUpgrades.ts buildSiegeGarrisonBlueprints' doc comment for the full incident writeup.
  const garrisonUnits: Unit[] = [];
  if (level.garrison) {
    for (const entry of level.garrison) {
      const bp = enemyWaveBlueprints[entry.unitType];
      const unit = new Unit(entry.unitType, Side.Top, entry.col, entry.row, bp, entry.initialHp, state.allocUnitId());
      state.board.addUnit(unit);
      garrisonUnits.push(unit);
    }
  }

  // Attacker army (G3, §16): the attacker's pre-deployed units on the Bottom (owner 0)
  // half. Mirror of the garrison block above — same construction, opposite side. Tracked
  // in attackerArmyUnits[] so emitInitialEvents() can emit owner-0 spawn + move-toward-
  // enemy-base events. troops = HP via entry.initialHp (§16.1). No live card play needed:
  // these advance on tick 1. Deliberately still reads `state.unitBlueprints` (the buffed table,
  // unlike the garrison block above) — this is the attacker's OWN army, it is supposed to reflect
  // the attacker's own card levels/equipment/academy.
  const attackerArmyUnits: Unit[] = [];
  if (level.attackerArmy) {
    for (const entry of level.attackerArmy) {
      const bp = state.unitBlueprints[entry.unitType];
      const unit = new Unit(entry.unitType, Side.Bottom, entry.col, entry.row, bp, entry.initialHp, state.allocUnitId());
      state.board.addUnit(unit);
      attackerArmyUnits.push(unit);
    }
  }

  // Defender buildings: pre-placed buildings on the Top player's building row. Tracked in
  // defenderBuildingList[] for emitInitialEvents() event emission.
  const defenderBuildingList: Building[] = [];
  if (level.defenderBuildings) {
    for (const entry of level.defenderBuildings) {
      const building = new Building(entry.buildingType, Side.Top, entry.col, TOP_BUILDING_ROW, undefined, state.allocBuildingId());
      state.board.addBuilding(building);
      defenderBuildingList.push(building);
    }
  }

  // Defender base level: pre-apply upgrade levels for the Top player. Sets upgradeLevel
  // directly (skips ink cost) — this represents the defender's investment in their base
  // before the attacker arrives.
  if (level.defenderBaseLevel && level.defenderBaseLevel > 0) {
    state.topPlayer.upgradeLevel = level.defenderBaseLevel;
  }

  // Defender base HP ceiling: NPC tiles scale their base HP with tile level (SLG option 2,
  // 2026-07-17). Sets both current and max so the HP bar reads full (hp/maxBaseHp) at
  // start; independent of upgradeLevel.
  if (level.defenderBaseHp && level.defenderBaseHp > 0) {
    state.topPlayer.maxBaseHp = level.defenderBaseHp;
    state.topPlayer.baseHp = level.defenderBaseHp;
  }

  return { garrisonUnits, attackerArmyUnits, defenderBuildingList };
}
