import {
  ACCEL_THRESHOLD_1_TICKS,
  ACCEL_THRESHOLD_2_TICKS,
  ACCEL_THRESHOLD_3_TICKS,
  INK_REGEN_BASE,
  BASE_UPGRADE_REGEN_BONUS,
  REGEN_FP_PER_INK_PER_S_NORMAL,
  REGEN_FP_PER_INK_PER_S_ACCEL1,
  REGEN_FP_PER_INK_PER_S_ACCEL2,
  REGEN_FP_PER_INK_PER_S_ACCEL3,
} from '../config';
import { GameState } from '../GameState';

/**
 * ResourceSystem — tick-based ink regen, no floating-point.
 *
 * Each player's ink regen rate in ink/s is:
 *   inkRegenRate = INK_REGEN_BASE + upgradeLevel * BASE_UPGRADE_REGEN_BONUS
 *
 * Per tick, that translates to:
 *   fp/tick = inkRegenRate * REGEN_FP_PER_INK_PER_S_<PHASE>
 *
 * Both REGEN_FP_PER_INK_PER_S_* and inkRegenRate are integers, so
 * the multiplication is exact integer arithmetic — no floats.
 *
 * Events are only emitted when the visible integer ink count changes.
 */
export class ResourceSystem {
  tick(state: GameState): void {
    const fpPerInkPerS = this.regenFpPerInkPerS(state.elapsedTicks);

    for (const player of [state.bottomPlayer, state.topPlayer]) {
      const inkRegenRate = INK_REGEN_BASE + player.upgradeLevel * BASE_UPGRADE_REGEN_BONUS;
      const regenFp = inkRegenRate * fpPerInkPerS; // integer × integer = integer

      const delta = player.addInkFp(regenFp);
      if (delta !== 0) {
        state.pushEvent({
          type:  'resource_changed',
          owner: state.ownerOf(player.side),
          ink: player.ink,
        });
      }
    }
  }

  /**
   * Returns the fp/tick earned per ink/s of regen rate.
   * All returned values are pre-computed integer constants.
   */
  private regenFpPerInkPerS(elapsedTicks: number): number {
    if (elapsedTicks >= ACCEL_THRESHOLD_3_TICKS) return REGEN_FP_PER_INK_PER_S_ACCEL3;
    if (elapsedTicks >= ACCEL_THRESHOLD_2_TICKS) return REGEN_FP_PER_INK_PER_S_ACCEL2;
    if (elapsedTicks >= ACCEL_THRESHOLD_1_TICKS) return REGEN_FP_PER_INK_PER_S_ACCEL1;
    return REGEN_FP_PER_INK_PER_S_NORMAL;
  }
}
