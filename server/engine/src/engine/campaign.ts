// Campaign/siege scripted-enemy domain (§4.10, G3 §16). Applied after HelpersMixin (see
// ../GameEngine.ts); WinConditionMixin's `survive` objective calls hasLivingEnemyUnits().
import type { Constructor, GameEngineBaseCtor } from './base';
import { BOARD_ROWS, BOTTOM_BUILDING_ROW, TOP_SPAWN_ROW } from '../config';
import { toFp } from '../math/fixed';
import { Unit } from '../Unit';
import { OwnerId, Side, UnitType } from '../types';

/** See helpers.ts HelpersHandlers doc comment for why this is exported. */
export interface CampaignHandlers {
  spawnEnemyUnit(unitType: UnitType, col: number, isBoss?: boolean, crossWaypoints?: { atRow: number; toCol: number }[]): void;
  hasLivingEnemyUnits(): boolean;
}

export function CampaignMixin<TBase extends GameEngineBaseCtor>(Base: TBase): TBase & Constructor<CampaignHandlers> {
  return class extends Base {
    // ─── Campaign: scripted enemy spawn ────────────────────────────────────────

    /**
     * Spawn a single enemy (Top side, owner 1) unit on `col`, bypassing the
     * hand/ink economy. Emits the same unit_spawned / unit_move_start events as
     * a card play, so the render layer needs no campaign-specific handling.
     */
    spawnEnemyUnit(unitType: UnitType, col: number, isBoss?: boolean, crossWaypoints?: { atRow: number; toCol: number }[]): void {
      const side: Side = Side.Top;
      const owner: OwnerId = 1;
      const laneLen  = this.level?.board?.laneLength;
      const lane = laneLen?.[String(col)];
      const spawnRow = lane !== undefined ? BOARD_ROWS - lane : TOP_SPAWN_ROW;
      const unit = new Unit(unitType, side, col, spawnRow, this.enemyWaveBlueprints[unitType], undefined, this.state.allocUnitId());
      if (isBoss) {
        unit.isBoss = true;
        this.state.bossUnitIds.add(unit.id);
      }
      if (crossWaypoints && crossWaypoints.length > 0) {
        unit.pendingWaypoints = crossWaypoints.slice();
      }
      this.state.board.addUnit(unit);
      this.state.stats[owner].unitsSent++;
      this.state.pushEvent({
        type:      'unit_spawned',
        unitId:    unit.id,
        owner,
        unitType:  unit.unitType,
        col:       unit.col,
        y_fp:      unit.y_fp,
        radius_fp: unit.radius_fp,
      });
      this.state.pushEvent({
        type:     'unit_move_start',
        unitId:   unit.id,
        from:     { col: unit.col, y_fp: unit.y_fp },
        to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
        speed_fp: unit.speed_fp,
      });
    }

    /** Whether any living Top-side (enemy) unit is still on the board. */
    hasLivingEnemyUnits(): boolean {
      for (const unit of this.state.board.units.values()) {
        if (unit.side === Side.Top && !unit.isDead) return true;
      }
      return false;
    }
  };
}
