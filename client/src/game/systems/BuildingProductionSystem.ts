import { BARRACKS_SPAWN_INTERVAL_TICKS, BUILDING_BLUEPRINTS, BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW } from '../config';
import { Building } from '../Building';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { BuildingType, Side } from '../types';

/**
 * BuildingProductionSystem — barracks produce units on a tick-based interval.
 * No floating-point; uses integer spawnCooldownTicks.
 */
export class BuildingProductionSystem {
  tick(state: GameState): void {
    for (const building of state.board.buildings.values()) {
      if (building.buildingType !== BuildingType.Barracks) continue;
      if (building.isDead) continue;

      if (building.spawnCooldownTicks > 0) {
        building.spawnCooldownTicks--;
      }

      if (building.spawnCooldownTicks === 0) {
        // Reset BEFORE spawning so the next interval starts from this tick
        building.spawnCooldownTicks = BARRACKS_SPAWN_INTERVAL_TICKS;
        this.spawnUnit(building, state);
      }
    }
  }

  private spawnUnit(building: Building, state: GameState): void {
    const bp       = BUILDING_BLUEPRINTS[BuildingType.Barracks];
    const spawnRow = building.side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;

    const unit = new Unit(bp.spawnUnit!, building.side, building.col, spawnRow);
    state.board.addUnit(unit);

    // Track barracks-spawned units in stats
    state.stats[state.ownerOf(building.side)].unitsSent++;

    state.pushEvent({ type: 'building_spawned_unit', buildingId: building.id, unitId: unit.id });
    state.pushEvent({
      type:      'unit_spawned',
      unitId:    unit.id,
      owner:     state.ownerOf(building.side),
      unitType:  unit.unitType,
      col:       unit.col,
      y_fp:      unit.y_fp,
      radius_fp: unit.radius_fp,
    });
  }
}
