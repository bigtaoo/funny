/**
 * Unified input pipeline (META_DESIGN §6.6 / M13).
 *
 * The deterministic core (fixed-point math + injected PRNG + golden replay)
 * lets single-player, multiplayer and replay share ONE input path: the engine
 * pulls the *confirmed command set* for each tick from an abstract
 * `InputSource`, without caring where the commands came from.
 *
 *   | impl              | used for          | DELAY            | command source                |
 *   |-------------------|-------------------|------------------|-------------------------------|
 *   | LocalInputSource  | single PvE / 练习 | 0 (immediate)    | client self-forward (this file) |
 *   | NetInputSource    | online match      | ~1 batch (3 frames) | gameserver frame_batch (S1-7) |
 *   | ReplayInputSource | replay            | —                | recorded FrameCmds[] (S1-RP)  |
 *
 * All three feed the engine the same `PlayerCommand[]` per tick, so the engine
 * logic is byte-identical regardless of source. The UI no longer calls
 * `processCommand` directly — it `submit()`s into the source, and the engine
 * `take()`s the confirmed set each tick.
 */

import type { PlayerCommand } from '../types';

export interface InputSource {
  /**
   * Submit a locally-produced command (UI tap / drag). The source decides when
   * it becomes confirmed: `LocalInputSource` forwards it to the engine's current
   * frame immediately (DELAY 0); a net source would relay it to the server.
   */
  submit(cmd: PlayerCommand): void;

  /**
   * The confirmed command set for `frame`.
   *
   * Returns `null` when the frame is **not yet confirmed** — the engine must
   * then stall (stop advancing) until it is. `LocalInputSource` never stalls and
   * always returns an array (possibly empty).
   */
  take(frame: number): readonly PlayerCommand[] | null;
}

const NO_COMMANDS: readonly PlayerCommand[] = [];

/**
 * Single-player / practice input source. Commands submitted by the UI are
 * confirmed at the engine's current frame with zero delay ("self-forward").
 *
 * Behaviourally identical to the previous inline `pendingCommands` buffer: a
 * tick consumes everything queued since the last tick and clears it, so the
 * golden-replay determinism contract is preserved.
 */
export class LocalInputSource implements InputSource {
  private queue: PlayerCommand[] = [];

  submit(cmd: PlayerCommand): void {
    this.queue.push(cmd);
  }

  take(_frame: number): readonly PlayerCommand[] {
    if (this.queue.length === 0) return NO_COMMANDS;
    const cmds = this.queue;
    this.queue = [];
    return cmds;
  }
}
