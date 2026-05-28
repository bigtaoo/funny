/**
 * GameRunner — CLIENT-LAYER adapter between PIXI's variable-dt render loop
 * and the fixed 30 Hz logic engine.
 *
 * This file belongs to the CLIENT layer (game-client), NOT the logic layer.
 * It is the only place where float time accumulation is intentional and allowed.
 *
 * Usage:
 *   const runner = new GameRunner(createGameEngine({ seed: 12345, players: [...] }));
 *
 *   // In PIXI ticker:
 *   const events = runner.update(app.ticker.elapsedMS);
 *   for (const e of events) renderEvent(e);
 *
 *   // Player input:
 *   runner.queueCommand({ type: 'play_card', owner: 0, tick: runner.currentTick, ... });
 */

import type { GameEvent, IGameEngine, PlayerCommand } from './game/index';
import { TICK_RATE } from './game/index';

const TICK_DT_S = 1 / TICK_RATE; // 1/30 s — used in CLIENT accumulator only

export class GameRunner {
  private readonly engine: IGameEngine;

  /** Current logic tick counter (read-only for the render layer). */
  currentTick = 0;

  /** Whether the game loop is paused. */
  private paused = false;

  /** Float accumulator for sub-tick time (CLIENT layer float — intentional). */
  private accumulator = 0;

  /** Commands queued by the render layer, injected into the next step(). */
  private pendingCmds: PlayerCommand[] = [];

  /**
   * Events produced by the most recent update() call.
   * Available until the next update() call.
   */
  lastEvents: readonly GameEvent[] = [];

  constructor(engine: IGameEngine) {
    this.engine = engine;
  }

  // ── Game loop ──────────────────────────────────────────────────────────────

  /**
   * Advance the engine by `elapsedMs` milliseconds (from PIXI ticker).
   * Calls engine.step() at 30 Hz; clamps to 3 steps per update to prevent
   * "spiral of death" when the tab was hidden and catches up.
   *
   * @returns Concatenated events from all logic steps this frame.
   */
  update(elapsedMs: number): readonly GameEvent[] {
    if (this.paused) return [];

    this.accumulator += elapsedMs / 1000; // ms → seconds (float, CLIENT only)

    const events: GameEvent[] = [];
    let steps = 0;
    while (this.accumulator >= TICK_DT_S && steps < 3) {
      const cmds = this.pendingCmds.splice(0);
      events.push(...this.engine.step(this.currentTick, cmds));
      this.currentTick++;
      this.accumulator -= TICK_DT_S;
      steps++;
    }

    this.lastEvents = events;
    return events;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  pause():  void { this.paused = true; }
  resume(): void { this.paused = false; }

  // ── Input ──────────────────────────────────────────────────────────────────

  /**
   * Queue a command from the local player.
   * The command will be injected into the next step() call.
   * Always bind commands to `runner.currentTick` at the moment of input.
   */
  queueCommand(cmd: PlayerCommand): void {
    this.pendingCmds.push(cmd);
  }
}
