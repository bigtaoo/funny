import { BUILDING_BLUEPRINTS, BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW } from '../config';
import { Building } from '../Building';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { BuildingType, Side } from '../types';

/** Handles barracks producing units over time */
export class BuildingProductionSystem {
  tick(state: GameState, dt: number): void {
    for (const building of state.board.buildings.values()) {
      if (building.buildingType !== BuildingType.Barracks) continue;
      if (building.isDead) continue;

      building.spawnCooldown -= dt;
      if (building.spawnCooldown <= 0) {
        const bp = BUILDING_BLUEPRINTS[BuildingType.Barracks];
        building.spawnCooldown = bp.spawnInterval!;

        const spawnRow = building.side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
        const unit = new Unit(bp.spawnUnit!, building.side, building.col, spawnRow);
        state.board.addUnit(unit);
        state.pushEvent({ type: 'unit_spawned', unitId: unit.id });
      }
    }
  }
}
