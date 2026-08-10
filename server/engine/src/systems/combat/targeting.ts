// Split from CombatSystem.ts (2026-08-10, independent function module range 6).
// Target acquisition for units and arrow towers — pure functions of GameState,
// no shared state with the rest of the combat pipeline (CombatSystem never had
// any instance fields to begin with, so this split carries zero ctx object).
import { BOARD_COLS, BOARD_ROWS } from '../../config';
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { Building } from '../../Building';
import { EscortUnit } from '../../EscortUnit';
import { fromFp } from '../../math/fixed';
import { Side } from '../../types';

export function findTarget(unit: Unit, state: GameState): Unit | Building | EscortUnit | null {
  const board = state.board;

  // Top-side (enemy) units can also target moving escort units (§4.9.3).
  // Collect active escorts once; empty for Bottom-side units and non-escort levels.
  const movingEscorts = unit.side === Side.Top
    ? state.escorts.filter(e => e.status === 'moving')
    : [];

  // Units advance single-file along their lane, but engage ANY enemy within
  // attack range around them (Chebyshev distance), not just the cell straight
  // ahead. Scan ring by ring so the closest target is preferred; within a ring:
  //   taunt unit > enemy unit > escort unit > enemy building.
  // Stealth: enemies with stealth are invisible at Chebyshev dist > 2.
  // Flying: units without canTargetFlying cannot target flying enemies.
  let bestTarget: Unit | Building | EscortUnit | null = null;
  let bestTaunt  = false;  // whether bestTarget has taunt
  let bestDist   = Infinity;

  for (let dist = 1; dist <= unit.effectiveRange; dist++) {
    let buildingHit: Building | null = null;
    let escortHit: EscortUnit | null = null;

    // Check escort units at this Chebyshev distance.
    if (movingEscorts.length > 0) {
      for (const escort of movingEscorts) {
        const eRow = Math.round(fromFp(escort.row_fp));
        const eCol = Math.round(fromFp(escort.col_fp));
        const d    = Math.max(Math.abs(unit.row - eRow), Math.abs(unit.col - eCol));
        if (d === dist && !escortHit) {
          escortHit = escort;
        }
      }
    }

    for (let dr = -dist; dr <= dist; dr++) {
      for (let dc = -dist; dc <= dist; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
        const checkRow = unit.row + dr;
        const checkCol = unit.col + dc;
        if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
        if (checkCol < 0 || checkCol >= BOARD_COLS) continue;

        // A cell may hold several stacked units — scan them all so none is hidden.
        for (const enemy of board.getUnitsAt(checkCol, checkRow)) {
          if (enemy.side === unit.side) continue;
          // Flying filter: skip flying targets if attacker can't target them.
          if (enemy.flying && !unit.canTargetFlying) continue;
          // Stealth: invisible beyond dist 2.
          if (enemy.stealth && dist > 2) continue;

          // Taunt preference: keep best candidate, prefer taunt.
          const hasTaunt = enemy.taunt;
          if (
            bestTarget === null ||
            (!bestTaunt && hasTaunt) ||
            (bestTaunt === hasTaunt && dist < bestDist)
          ) {
            bestTarget = enemy;
            bestTaunt  = hasTaunt;
            bestDist   = dist;
          }
        }

        if (!buildingHit) {
          const building = board.getBuildingAt(checkCol, checkRow);
          if (building && building.side !== unit.side && !building.isDead) buildingHit = building;
        }
      }
    }

    // Accumulate escort candidate (lower priority than taunt unit).
    if (escortHit && bestTarget === null) {
      bestTarget = escortHit;
      bestDist   = dist;
    }
    // Accumulate building candidate (lowest priority).
    if (buildingHit && bestTarget === null) {
      bestTarget = buildingHit;
      bestDist   = dist;
    }
  }

  return bestTarget;
}

export function findTargetForBuilding(building: Building, state: GameState): Unit | null {
  const board     = state.board;
  const enemySide = building.side === Side.Bottom ? Side.Top : Side.Bottom;
  const range     = building.attackRange;

  // Scan all cells within attackRange in every direction (Chebyshev distance),
  // ring by ring so closer targets are preferred.
  for (let dist = 1; dist <= range; dist++) {
    for (let dr = -dist; dr <= dist; dr++) {
      for (let dc = -dist; dc <= dist; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
        const checkRow = building.row + dr;
        const checkCol = building.col + dc;
        if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
        if (checkCol < 0 || checkCol >= BOARD_COLS) continue;
        // Scan every unit stacked on the cell so a ghosted enemy is still found.
        for (const unit of board.getUnitsAt(checkCol, checkRow)) {
          if (unit.side !== enemySide) continue;
          // Flying filter: buildings without canTargetFlying skip flying targets.
          if (unit.flying && !building.canTargetFlying) continue;
          return unit;
        }
      }
    }
  }
  return null;
}
