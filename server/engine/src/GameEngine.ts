// GameEngine — battle engine core. Assembled from three independent layers (see
// claudedocs/server.md "engine/GameEngine" for the full rationale behind this split):
//   - engine/setup/*.ts   — one-time construction (buildEngineCtx) from a GameConfig
//   - engine/sim/*.ts     — the deterministic simulation, pure functions of (ctx, tick,
//                           commands); never touches wall-clock or the InputSource
//   - engine/driver/*.ts  — wall-clock playback (RealtimeDriver); the headless path
//                           (runHeadless.ts) bypasses this entirely and drives sim/step.ts
//                           directly through the same public step()/state that this
//                           facade exposes
// This file itself is the thin facade: it owns the InputSource (the one piece that must
// never leak into sim/**) and implements IGameEngine by delegating to the layers above.
import { LocalInputSource } from './net/InputSource';
import type { InputSource } from './net/InputSource';
import type { GameConfig, GameEvent, IGameEngine, PlayerCommand } from './types';
import { buildEngineCtx } from './engine/setup/buildCtx';
import type { EngineCtx } from './engine/ctx';
import { stepEngine } from './engine/sim/step';
import { RealtimeDriver } from './engine/driver/realtimeDriver';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a game engine.
 *
 * `input` is the unified input pipeline (M13). Defaults to `LocalInputSource`
 * (single-player / practice: UI commands self-forward to the current tick with
 * zero delay). Online play (S1-7) and replay (S1-RP) inject `NetInputSource` /
 * `ReplayInputSource` here instead — the engine code is unchanged.
 */
export function createGameEngine(config: GameConfig, input?: InputSource): IGameEngine {
  return new GameEngineImpl(config, input ?? new LocalInputSource());
}

// ─── Implementation (not exported) ───────────────────────────────────────────

class GameEngineImpl implements IGameEngine {
  private readonly ctx: EngineCtx;
  private readonly input: InputSource;
  private readonly driver = new RealtimeDriver();

  constructor(config: GameConfig, input: InputSource) {
    this.ctx = buildEngineCtx(config);
    this.input = input;
  }

  get state() {
    return this.ctx.state;
  }

  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
    return stepEngine(this.ctx, tick, commands);
  }

  tick(dt: number): void {
    const frameEvents = this.driver.tick(dt, this.input, (tick, cmds) => stepEngine(this.ctx, tick, cmds));
    // Always overwrite — on a 0-step frame this clears stale events so the renderer
    // doesn't re-process them.
    this.ctx.state.setEvents(frameEvents);
  }

  // ─── Render-facing API ───────────────────────────────────────────────────
  // These only submit into the InputSource — the actual command handling (and its
  // access to game state) lives in engine/sim/commands.ts's processCommand, reached via
  // step()/tick() above. Stamped with driver.currentTick, matching the tick a
  // LocalInputSource-submitted command self-forwards onto.

  playCard(handIndex: number, col: number, row?: number): void {
    this.input.submit({ type: 'play_card', owner: 0, tick: this.driver.currentTick, handIndex, col, row });
  }

  upgradeBase(): void {
    this.input.submit({ type: 'upgrade_base', owner: 0, tick: this.driver.currentTick });
  }

  refreshHand(): void {
    this.input.submit({ type: 'refresh_hand', owner: 0, tick: this.driver.currentTick });
  }
}
