// Building survival stats — free-function form of the old HelpersMixin.accumulateBuildingSurvival
// (see claudedocs/server.md "engine/GameEngine").
import type { GameState } from '../../GameState';

export function accumulateBuildingSurvival(state: GameState): void {
  for (const building of state.board.buildings.values()) {
    if (!building.isDead) {
      const owner = state.ownerOf(building.side);
      state.stats[owner].buildingSurvivalTicks++;
    }
  }
}
