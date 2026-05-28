import {
  ACCEL_THRESHOLD_1_TICKS,
  ACCEL_THRESHOLD_2_TICKS,
  COIN_REGEN_BASE,
  BASE_UPGRADE_REGEN_BONUS,
  REGEN_FP_PER_COIN_PER_S_NORMAL,
  REGEN_FP_PER_COIN_PER_S_ACCEL1,
  REGEN_FP_PER_COIN_PER_S_ACCEL2,
} from '../config';
import { GameState } from '../GameState';

/**
 * ResourceSystem — tick-based coin regen, no floating-point.
 *
 * Each player's coin regen rate in coins/s is:
 *   coinRegenRate = COIN_REGEN_BASE + upgradeLevel * BASE_UPGRADE_REGEN_BONUS
 *
 * Per tick, that translates to:
 *   fp/tick = coinRegenRate * REGEN_FP_PER_COIN_PER_S_<PHASE>
 *
 * Both REGEN_FP_PER_COIN_PER_S_* and coinRegenRate are integers, so
 * the multiplication is exact integer arithmetic — no floats.
 *
 * Events are only emitted when the visible integer coin count changes.
 */
export class ResourceSystem {
  tick(state: GameState): void {
    const fpPerCoinPerS = this.regenFpPerCoinPerS(state.elapsedTicks);

    for (const player of [state.bottomPlayer, state.topPlayer]) {
      const coinRegenRate = COIN_REGEN_BASE + player.upgradeLevel * BASE_UPGRADE_REGEN_BONUS;
      const regenFp = coinRegenRate * fpPerCoinPerS; // integer × integer = integer

      const delta = player.addCoinsFp(regenFp);
      if (delta !== 0) {
        state.pushEvent({
          type:  'resource_changed',
          owner: state.ownerOf(player.side),
          coins: player.coins,
        });
      }
    }
  }

  /**
   * Returns the fp/tick earned per coin/s of regen rate.
   * All returned values are pre-computed integer constants.
   */
  private regenFpPerCoinPerS(elapsedTicks: number): number {
    if (elapsedTicks >= ACCEL_THRESHOLD_2_TICKS) return REGEN_FP_PER_COIN_PER_S_ACCEL2;
    if (elapsedTicks >= ACCEL_THRESHOLD_1_TICKS) return REGEN_FP_PER_COIN_PER_S_ACCEL1;
    return REGEN_FP_PER_COIN_PER_S_NORMAL;
  }
}
