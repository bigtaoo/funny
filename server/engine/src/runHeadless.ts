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

import { createGameEngine } from './GameEngine';
import { GamePhase } from './types';
import type { GameConfig, IGameEngine } from './types';
import type { InputSource } from './net/InputSource';
import { TICK_RATE } from './math/fixed';

export interface HeadlessOutcome {
  /** True iff the match reached GamePhase.GameOver within `maxTicks`. */
  ok: boolean;
  /** Number of logic frames advanced before stopping. */
  ticks: number;
  /** The driven engine — read `state.winner` / `state.snapshotStats()` off it. */
  engine: IGameEngine;
}

/**
 * Build an engine for `config` (with already-decoded `input`) and tick it at the
 * fixed rate until GameOver or `maxTicks` (the loop guard against malformed input
 * / pathological stalemates). Returns the engine for the caller to inspect.
 *
 * Determinism is preserved verbatim: same `config` (seed, blueprints) + same
 * confirmed input stream → identical per-tick state. This function only owns the
 * loop; it adds no logic of its own.
 */
export function runHeadless(config: GameConfig, input: InputSource, maxTicks: number): HeadlessOutcome {
  const engine = createGameEngine(config, input);
  const tickDt = 1 / TICK_RATE;
  let ticks = 0;
  while (engine.state.phase !== GamePhase.GameOver && ticks < maxTicks) {
    engine.tick(tickDt);
    ticks++;
  }
  return { ok: engine.state.phase === GamePhase.GameOver, ticks, engine };
}
