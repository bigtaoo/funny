// Campaign/siege scripted-enemy domain (§4.10, G3 §16) — free-function form of the old
// CampaignMixin (see claudedocs/server.md "engine/GameEngine"). checkWinCondition's
// `survive`/`destroy_base` branches call hasLivingEnemyUnits/hasLivingAttackerUnits.
import { BOARD_ROWS, BOTTOM_BUILDING_ROW, TOP_SPAWN_ROW } from '../../config';
import { toFp } from '../../math/fixed';
import { Unit } from '../../Unit';
import { OwnerId, Side, UnitType } from '../../types';
import type { EngineCtx } from '../ctx';

/**
 * Spawn a single enemy (Top side, owner 1) unit on `col`, bypassing the hand/ink
 * economy. Emits the same unit_spawned/unit_move_start events as a card play, so the
 * render layer needs no campaign-specific handling.
 */
export function spawnEnemyUnit(
  ctx: EngineCtx,
  unitType: UnitType,
  col: number,
  isBoss?: boolean,
  crossWaypoints?: { atRow: number; toCol: number }[],
): void {
  const { state, level, enemyWaveBlueprints } = ctx;
  const side: Side = Side.Top;
  const owner: OwnerId = 1;
  const laneLen  = level?.board?.laneLength;
  const lane = laneLen?.[String(col)];
  const spawnRow = lane !== undefined ? BOARD_ROWS - lane : TOP_SPAWN_ROW;
  const unit = new Unit(unitType, side, col, spawnRow, enemyWaveBlueprints[unitType], undefined, state.allocUnitId());
  if (isBoss) {
    unit.isBoss = true;
    state.bossUnitIds.add(unit.id);
  }
  if (crossWaypoints && crossWaypoints.length > 0) {
    unit.pendingWaypoints = crossWaypoints.slice();
  }
  state.board.addUnit(unit);
  state.stats[owner].unitsSent++;
  state.pushEvent({
    type:      'unit_spawned',
    unitId:    unit.id,
    owner,
    unitType:  unit.unitType,
    col:       unit.col,
    y_fp:      unit.y_fp,
    radius_fp: unit.radius_fp,
  });
  state.pushEvent({
    type:     'unit_move_start',
    unitId:   unit.id,
    from:     { col: unit.col, y_fp: unit.y_fp },
    to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
    speed_fp: unit.speed_fp,
  });
}

/** Whether any living Top-side (enemy) unit is still on the board. */
export function hasLivingEnemyUnits(ctx: EngineCtx): boolean {
  for (const unit of ctx.state.board.units.values()) {
    if (unit.side === Side.Top && !unit.isDead) return true;
  }
  return false;
}

/** Whether any living Bottom-side (attacker, siege) unit is still on the board. */
export function hasLivingAttackerUnits(ctx: EngineCtx): boolean {
  for (const unit of ctx.state.board.units.values()) {
    if (unit.side === Side.Bottom && !unit.isDead) return true;
  }
  return false;
}
