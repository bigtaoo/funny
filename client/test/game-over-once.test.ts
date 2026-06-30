// Regression guard: double-fire settlement bug (analytics event level_complete / recordClear
// triggered repeatedly every frame).
//
// Root cause has two layers:
//   1. Engine side: after GameOver, step() returns early without clearing state.events, so the
//      game_over event lingers in the event queue — GameRenderer.update iterates
//      `for (event of state.events)` every frame and re-reads it each time.
//      This test proves the lingering is real (→ the render layer must have its own gate).
//   2. Render side (the real fix): GameRenderer uses a one-shot `gameEnded` gate to ensure
//      game_over / game_draw fires onGameEnd exactly once (→ settlement runs only once).
//      The render layer depends on PIXI and belongs in UI stack tests; here we use the
//      pure engine contract to assert "engine emits game_over exactly once" and
//      document the lingering behavior.

import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import type { GameConfig } from '../src/game/types';
import { GamePhase, UnitType } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

// A level guaranteed to lose quickly: maxLeaks=1 + 3 Runners charging to the base → game decided fast (Top wins).
const losingLevel: LevelDefinition = {
  id: 'test_over', chapter: 0, seed: 1,
  objective: { kind: 'leak_limit', maxLeaks: 1 },
  waves: { entries: [{ atTick: 5, unitType: UnitType.Runner, col: 0, count: 3, spacingTicks: 60 }] },
};
const cfg: GameConfig = { seed: losingLevel.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level: losingLevel };

describe('game_over emitted exactly once (double-fire settlement regression)', () => {
  it('across the whole run, step() return values contain game_over exactly once; after end, step() returns empty', () => {
    const engine = createGameEngine(cfg);
    let gameOverEmissions = 0;
    let postOverSteps = 0;
    for (let i = 0; i < 800; i++) {
      const wasOver = engine.state.phase === GamePhase.GameOver;
      const events = engine.step(i, []);
      gameOverEmissions += events.filter((e) => e.type === 'game_over').length;
      if (wasOver) {
        postOverSteps++;
        expect(events).toEqual([]); // no further events emitted after game over
      }
    }
    expect(gameOverEmissions).toBe(1); // engine emits game_over exactly once
    expect(postOverSteps).toBeGreaterThan(0); // confirms we actually ran steps after game over
  });

  it('after game over, game_over lingers in state.events queue (→ render layer must use a one-shot gate)', () => {
    const engine = createGameEngine(cfg);
    let i = 0;
    for (; i < 800 && engine.state.phase !== GamePhase.GameOver; i++) engine.step(i, []);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.events.some((e) => e.type === 'game_over')).toBe(true);
    // Run one more frame (bypassing the normal step branch that clears the queue) — event still present,
    // confirming the per-frame re-read hazard is real.
    engine.step(i, []);
    expect(engine.state.events.some((e) => e.type === 'game_over')).toBe(true);
  });
});
