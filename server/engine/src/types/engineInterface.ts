// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). The public engine interface the render layer drives — method signatures only, no
// implementation (BattleEngine implements this).
import type { PlayerCommand } from './config';
import type { GameEvent } from './events';

export interface IGameEngine {
  /**
   * Advance game state by one logic frame (1/30 s).
   *
   * On the very first call (tick 0), also emits initial state events
   * (card_drawn for both players' starting hands, resource_changed for initial ink).
   *
   * @param tick       Monotonically increasing frame counter (starts at 0).
   * @param commands   All commands bound to this tick (player + any external).
   * @returns          All events produced this frame (drives rendering).
   */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[];

  /**
   * Called every render frame with wall-clock dt (seconds).
   * Internally accumulates time and calls step() at TICK_RATE.
   * The render layer calls this instead of step() directly.
   */
  tick(dt: number): void;

  /** Current game state — read by the render layer after tick(). */
  readonly state: import('../GameState').GameState;

  /** Queue a play_card command for the local player (owner 0). */
  playCard(handIndex: number, col: number, row?: number): void;

  /** Queue an upgrade_base command for the local player (owner 0). */
  upgradeBase(): void;

  /** Queue a refresh_hand command for the local player (owner 0). */
  refreshHand(): void;
}
