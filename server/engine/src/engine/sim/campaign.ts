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

/**
 * Lane-punish (§4.9.5): answer a sustained player wall in one column with a
 * column spell. No-op unless the level opted in via `lanePunish`.
 *
 * Campaign enemies are a wave script with no AI, so a player who packed one lane
 * could never be punished for it — the queue refilled the front rank faster than
 * scripted waves could break it and the level was over. This is the scripted
 * side's one reactive behaviour, and it is deliberately narrow: it reads only the
 * public board (unit counts per column), fires on a fixed sustain + cooldown, and
 * targets the column with the most player units — no hand-peeking, no randomness,
 * so a level stays deterministic for replays and the difficulty sim.
 */
export function tickLanePunish(ctx: EngineCtx, tick: number): void {
  const spec = ctx.level?.lanePunish;
  if (!spec) return;
  const { state } = ctx;

  // Count player (Bottom) units per column, then age each column's wall timer.
  const counts = new Map<number, number>();
  for (const unit of state.board.units.values()) {
    if (unit.isDead || unit.side !== Side.Bottom) continue;
    counts.set(unit.col, (counts.get(unit.col) ?? 0) + 1);
  }

  let targetCol = -1;
  let targetCount = 0;
  for (const col of [...state.lanePunishSustain.keys()]) {
    if ((counts.get(col) ?? 0) < spec.units) state.lanePunishSustain.delete(col);
  }
  for (const [col, count] of counts) {
    if (count < spec.units) continue;
    const sustain = (state.lanePunishSustain.get(col) ?? 0) + 1;
    state.lanePunishSustain.set(col, sustain);
    if (sustain < spec.sustainTicks) continue;
    // Thickest wall wins; ties break on the lower column index so the choice is
    // independent of Map iteration order.
    if (count > targetCount || (count === targetCount && (targetCol === -1 || col < targetCol))) {
      targetCol   = col;
      targetCount = count;
    }
  }

  if (targetCol === -1 || tick < state.lanePunishReadyTick) return;

  if (spec.spell === 'rockslide') {
    ctx.systems.spell.castRockslide(Side.Top, targetCol, state, true);
  } else {
    ctx.systems.spell.castBridgeCollapse(Side.Top, targetCol, state, tick);
  }
  state.lanePunishReadyTick = tick + spec.cooldownTicks;
  state.lanePunishSustain.delete(targetCol);
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
