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
 * INK_REGEN_BASE scales with the match's acceleration phase; the base-upgrade
 * bonus deliberately does NOT, so it stays a flat +BASE_UPGRADE_REGEN_BONUS
 * ink/s per level at every phase. (Scaling the upgrade bonus by the same
 * accel multiplier as the base rate let it compound into an 8 ink/s gap by
 * the ×4 phase — worth more per second than most cards cost — for a one-time
 * investment that paid for itself in well under a minute. See BALANCE.md.)
 *
 *   fp/tick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_<PHASE>
 *           + upgradeLevel * BASE_UPGRADE_REGEN_BONUS * REGEN_FP_PER_INK_PER_S_NORMAL
 *
 * All operands are integers, so the arithmetic is exact — no floats.
 *
 * Events are only emitted when the visible integer ink count changes.
 */
export class ResourceSystem {
  tick(state: GameState): void {
    const accelFpPerInkPerS = this.regenFpPerInkPerS(state.elapsedTicks);

    for (const player of [state.bottomPlayer, state.topPlayer]) {
      const baseFp = INK_REGEN_BASE * accelFpPerInkPerS;
      const bonusFp = player.upgradeLevel * BASE_UPGRADE_REGEN_BONUS * REGEN_FP_PER_INK_PER_S_NORMAL;
      const totalFp = baseFp + bonusFp; // integer × integer + integer × integer = integer
      // Apply per-level regen multiplier only to the bottom (human) player.
      const mult = player === state.bottomPlayer ? state.bottomInkRegenMult : 1;
      const regenFp = mult === 1 ? totalFp : Math.round(totalFp * mult);

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
