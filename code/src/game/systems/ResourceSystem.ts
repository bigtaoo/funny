import {
  ACCEL_MULT_1,
  ACCEL_MULT_2,
  ACCEL_THRESHOLD_1,
  ACCEL_THRESHOLD_2,
} from '../config';
import { GameState } from '../GameState';

export class ResourceSystem {
  tick(state: GameState, dt: number): void {
    const mult = this.getAccelMult(state.elapsedTime);

    for (const player of [state.bottomPlayer, state.topPlayer]) {
      player.addCoins(player.coinRegenRate * mult * dt);
    }
  }

  private getAccelMult(elapsed: number): number {
    if (elapsed >= ACCEL_THRESHOLD_2) return ACCEL_MULT_2;
    if (elapsed >= ACCEL_THRESHOLD_1) return ACCEL_MULT_1;
    return 1;
  }
}
