import { addFp, mulFp, toFp, TICK_DT_FP } from '../math/fixed';
import { TOP_BUILDING_ROW } from '../config';
import type { GameState } from '../GameState';

/**
 * EscortSystem — advances friendly escort units toward the enemy base each tick.
 *
 * Movement model (§4.9.3):
 *   • Escort always advances by (speed_fp × TICK_DT_FP) in the row direction
 *     (row increases → toward TOP_BUILDING_ROW = enemy side).
 *   • On reaching a waypoint's row the escort snaps its col to the waypoint's col,
 *     then pops the waypoint and continues.
 *   • Escort does NOT stop for enemies — it keeps moving even while taking damage.
 *   • Death and arrival are checked here; HP is reduced by CombatSystem.
 *
 * Does NOT modify board.units — escorts live in state.escorts.
 */
export class EscortSystem {
  tick(state: GameState): void {
    const arrivalRow_fp = toFp(TOP_BUILDING_ROW);

    for (const escort of state.escorts) {
      if (escort.status !== 'moving') continue;

      // Death check (damage applied by CombatSystem in the same tick before this runs).
      if (escort.hp <= 0) {
        escort.status = 'dead';
        state.pushEvent({ type: 'escort_died', escortId: escort.id });
        continue;
      }

      // Advance row toward enemy base.
      const step_fp = mulFp(escort.speed_fp, TICK_DT_FP);
      escort.row_fp = addFp(escort.row_fp, step_fp);

      // Process waypoints: snap col when the escort's row reaches a waypoint's row.
      while (escort.remainingPath.length > 0) {
        const wp      = escort.remainingPath[0]!;
        const wpRow_fp = toFp(wp.row);
        if (escort.row_fp >= wpRow_fp) {
          escort.row_fp = wpRow_fp;
          escort.col_fp = toFp(wp.col);
          escort.remainingPath.shift();
        } else {
          break;
        }
      }

      // Arrival check.
      if (escort.row_fp >= arrivalRow_fp) {
        escort.row_fp  = arrivalRow_fp;
        escort.status  = 'arrived';
        state.pushEvent({ type: 'escort_arrived', escortId: escort.id });
        continue;
      }

      state.pushEvent({
        type:     'escort_moved',
        escortId: escort.id,
        col_fp:   escort.col_fp,
        row_fp:   escort.row_fp,
      });
    }
  }
}
