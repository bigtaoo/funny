// Real-time playback driver — free-function-sim's wall-clock front door. Free-function
// form of the old LoopMixin.tick() (see claudedocs/server.md "engine/GameEngine"). Owns
// EXACTLY the two fields that used to live on GameEngineBase purely for this purpose
// (accumulatedTime, currentTick) and knows nothing about EngineCtx/GameState — it only
// calls the `stepFn` it's given and unions the returned event batches. This is the piece
// that must never sit on the headless authoritative path (runHeadless.ts calls
// engine.step() + input directly instead) — see claudedocs/server.md for why.
import { TICK_RATE } from '../../math/fixed';
import type { GameEvent, PlayerCommand } from '../../types';
import type { InputSource } from '../../net/InputSource';

/**
 * Max wall-clock the accumulator may bank, in *catch-up* ticks. Bounds how much real
 * time one tick() call may convert to sim steps, so a long pause (backgrounded tab, GC
 * hitch, or a resolved lockstep stall) can't bank an unbounded burst. At catch-up speed
 * N this still permits N× this many sim steps in a single tick() — that is the intended
 * fast-forward.
 */
const MAX_CATCHUP_TICKS = 5;

/**
 * Backlog (in sim ticks, *beyond* the jitter buffer) above which we catch up at 3×.
 * Without this floor the ladder below only starts draining at 1 s of backlog, so any
 * hitch that banks less than a second (a brief tab background, a GC pause, a bunched-up
 * batch delivery) leaves playback stuck that far behind the server *for the rest of the
 * match* — the metronome runs at the same rate we do, so a sub-second lead neither grows
 * nor shrinks at 1×.
 *
 * `confirmedLead` already subtracts `bufferFrames` (the 100 ms jitter cushion, which is
 * the hard minimum lag — playback can never be closer than that to the server), so any
 * positive lead is real backlog *past* that cushion. 3 ≈ one 100 ms batch: it drains
 * accumulated backlog back to essentially just the cushion (~0.1 s total lag) while
 * staying above normal single-batch delivery (a batch lands 3 frames at once, so lead
 * peaks at 3 and falls back to 0 at 1×) — so steady 1× playback never trips the catch-up,
 * but a bunched double-batch (lead 6) is drained promptly. Do NOT lower below one batch:
 * catching up on every normal batch would fight the metronome and reintroduce
 * micro-stutter.
 */
const CATCHUP_MIN_LEAD = 3;

/** What the driver calls once per sim step it decides to run — sim/step.ts's stepEngine, bound to a ctx. */
export type StepFn = (tick: number, commands: readonly PlayerCommand[]) => readonly GameEvent[];

export class RealtimeDriver {
  private accumulatedTime = 0;
  private _currentTick = 0;

  /** The tick a command submitted right now would land on (facade's playCard/upgradeBase/refreshHand). */
  get currentTick(): number {
    return this._currentTick;
  }

  /**
   * Catch-up speed multiplier (sim ticks per wall-clock tick) based on how far the
   * confirmed watermark has outrun our playback head. A client that paused (minimized
   * tab → rAF halts) or stalled keeps receiving frame_batches, so on resume the backlog
   * can be huge; draining it at 1× would never sync. Speed up aggressively with the
   * backlog so we converge fast, then settle back to 1×. Latency here is not cosmetic:
   * while playback lags, a placed card isn't shown (or resolved) in real time, which can
   * lose the match — so we favour catching up hard over a smooth speed ramp.
   *
   *   backlog > 3 s → 10×   |   > 1 s → 5×   |   > ~0.1 s → 3×   |   else 1×
   *
   * The 3× floor (see {@link CATCHUP_MIN_LEAD}) is what keeps sub-second backlog from
   * becoming a permanent offset: without it the metronome runs at our rate so a
   * sub-second lead never shrinks. It drains back to essentially just the 100 ms jitter
   * buffer so a placed card shows up ~0.1 s later, not ~1.1 s.
   *
   * Only re-times step() calls — never changes which frames run or their order, so
   * lockstep determinism is unaffected.
   */
  private catchUpSpeed(input: InputSource): number {
    const lead = input.confirmedLead?.(this._currentTick) ?? 0;
    if (lead > 3 * TICK_RATE) return 10;
    if (lead > 1 * TICK_RATE) return 5;
    if (lead > CATCHUP_MIN_LEAD) return 3;
    return 1;
  }

  /**
   * Advance by wall-clock `dt` seconds, running zero or more sim steps via `stepFn`, and
   * return the per-*frame* union of every step's events (see GameState.setEvents' doc —
   * a catch-up frame's earlier steps' events must not be lost, and a 0-step frame must
   * not re-surface the previous frame's events).
   */
  tick(dt: number, input: InputSource, stepFn: StepFn): GameEvent[] {
    const tickDt = 1 / TICK_RATE;
    this.accumulatedTime += dt;

    // When playback has fallen behind the confirmed watermark, spend each banked
    // millisecond on more than one sim step so we catch up to the server.
    const speed = this.catchUpSpeed(input);
    const stepDt = tickDt / speed;

    // Cap banked time — prevents post-pause bursts and the spiral-of-death. The bound is
    // on real time (MAX_CATCHUP_TICKS at 1×); at speed N this still allows N× as many sim
    // steps to drain, which is the catch-up we want.
    const maxAccum = tickDt * MAX_CATCHUP_TICKS;
    if (this.accumulatedTime > maxAccum) this.accumulatedTime = maxAccum;

    const frameEvents: GameEvent[] = [];
    while (this.accumulatedTime >= stepDt) {
      // Pull the confirmed command set for this frame from the input pipeline.
      // LocalInputSource never stalls; a net source returns null when the frame is not
      // yet confirmed, in which case we stop advancing (S1-7 buffering).
      const cmds = input.take(this._currentTick);
      if (cmds === null) {
        // Lockstep stall: the next frame isn't confirmed yet. Drop banked time back to a
        // single step so that when the frame lands we resume at the natural cadence
        // rather than replaying the whole buffered batch in one render frame — that
        // burst-then-idle is exactly the choppy, 10 Hz-looking stutter. Re-times step()
        // calls only; never changes which frames run or their order, so determinism is
        // unaffected.
        if (this.accumulatedTime > stepDt) this.accumulatedTime = stepDt;
        break;
      }
      this.accumulatedTime -= stepDt;
      const stepEvents = stepFn(this._currentTick++, cmds);
      if (stepEvents.length) frameEvents.push(...stepEvents);
    }
    return frameEvents;
  }
}
