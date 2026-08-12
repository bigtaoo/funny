// Headless engine driver — the single tick-loop that runs a deterministic match
// to its end with no renderer, no interaction. Extracted from the client's
// judgeRunner (SLG_DESIGN §16.7) so every authoritative consumer shares ONE
// code path:
//   - client peer-judge   (judgeRunner): decode proto frames → ReplayInputSource → here
//   - gateway self-judge   (G3-2b)      : decode proto frames → ReplayInputSource → here
//   - worldsvc siege       (G3-2b)      : pre-placed armies, empty input → here
//
// runHeadless eats ALREADY-DECODED input (a GameConfig + an InputSource); proto
// decoding stays at each caller's edge. That separation is what lets the three
// callers above converge on this one engine path.
//
// Deliberately calls engine.step() + input.take() directly instead of engine.tick(dt) —
// tick()'s wall-clock accumulator + catch-up-speed ladder (driver/realtimeDriver.ts) is
// real-time-playback machinery with no business being on an authoritative path. It's a
// no-op for LocalInputSource/ReplayInputSource today (neither implements confirmedLead,
// so speed is always 1×), but that was "doesn't break today" by accident, not by
// construction (see claudedocs/server.md "engine/GameEngine" for the full reasoning) —
// routing every authoritative recompute through the same driver that also has to smooth
// over frame-rate jitter for a live human is exactly the kind of coupling one day trips
// on some future InputSource that DOES implement confirmedLead.

import { createGameEngine } from './GameEngine';
import { GamePhase } from './types';
import type { GameConfig, IGameEngine } from './types';
import type { InputSource } from './net/InputSource';

export interface HeadlessOutcome {
  /** True iff the match reached GamePhase.GameOver within `maxTicks`. */
  ok: boolean;
  /** Number of logic frames advanced before stopping. */
  ticks: number;
  /** The driven engine — read `state.winner` / `state.snapshotStats()` off it. */
  engine: IGameEngine;
}

/**
 * Build an engine for `config` (with already-decoded `input`) and step it tick-by-tick
 * until GameOver or `maxTicks` (the loop guard against malformed input / pathological
 * stalemates). Returns the engine for the caller to inspect.
 *
 * Determinism is preserved verbatim: same `config` (seed, blueprints) + same confirmed
 * input stream → identical per-tick state. This function only owns the loop; it adds no
 * logic of its own.
 */
export function runHeadless(config: GameConfig, input: InputSource, maxTicks: number): HeadlessOutcome {
  const engine = createGameEngine(config, input);
  let ticks = 0;
  while (engine.state.phase !== GamePhase.GameOver && ticks < maxTicks) {
    // Every caller today (peer-judge/self-judge decoded proto, or worldsvc's pre-placed
    // armies + empty input) has the full command stream available up front, so take()
    // never returns null here — a source that DOES stall (a live NetInputSource) has no
    // business driving an authoritative recompute in the first place.
    const cmds = input.take(ticks);
    if (cmds === null) break;
    engine.step(ticks, cmds);
    ticks++;
  }
  return { ok: engine.state.phase === GamePhase.GameOver, ticks, engine };
}
