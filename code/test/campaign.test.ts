import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import type { GameConfig } from '../src/game/types';
import { Side } from '../src/game/types';

/**
 * Campaign (PvE) mode determinism + wiring guard.
 *
 * The WaveDirector reads only the tick and its static script, so campaign
 * levels are fully deterministic (same seed ⇒ identical evolution), just like
 * PvP. These tests assert that structurally and check the basic wiring:
 * scripted enemies actually spawn, and no-build cells reach the board.
 */

const TICK_DT = 1 / 30;

function campaignConfig(levelId: string): GameConfig {
  const level = CAMPAIGN_LEVELS[levelId]!;
  return { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
}

function fingerprint(levelId: string, ticks: number): unknown {
  const engine = createGameEngine(campaignConfig(levelId));
  for (let i = 0; i < ticks; i++) engine.tick(TICK_DT);
  const s = engine.state;
  const units = Array.from(s.board.units.values())
    .map((u) => `${u.id}:${u.unitType}:${u.side}:${u.col}:${u.y_fp}:${u.x_fp}:${u.hp}:${u.state}`)
    .sort();
  return {
    elapsedTicks: s.elapsedTicks,
    phase: s.phase,
    winner: s.winner,
    bottomBaseHp: s.bottomPlayer.baseHp,
    units,
    stats: s.snapshotStats(),
  };
}

describe('campaign mode', () => {
  it('every registered level evolves identically run-vs-run (determinism)', () => {
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      expect(fingerprint(id, 400)).toEqual(fingerprint(id, 400));
    }
  });

  it('the wave director actually spawns enemy (Top) units', () => {
    const engine = createGameEngine(campaignConfig('ch1_lv1'));
    for (let i = 0; i < 200; i++) engine.tick(TICK_DT);
    const enemies = Array.from(engine.state.board.units.values())
      .filter((u) => u.side === Side.Top);
    expect(enemies.length).toBeGreaterThan(0);
    expect(engine.state.stats[1].unitsSent).toBeGreaterThan(0);
  });

  it('ch1_lv3 applies its no-build cells to the board', () => {
    const engine = createGameEngine(campaignConfig('ch1_lv3'));
    // Center building slots (row 0) are torn out; edges remain buildable.
    expect(engine.state.board.isNoBuild(4, 0)).toBe(true);
    expect(engine.state.board.isNoBuild(7, 0)).toBe(true);
    expect(engine.state.board.isNoBuild(0, 0)).toBe(false);
    expect(engine.state.board.getNoBuildCells().length).toBe(4);
  });

  it('an idle player eventually loses (enemy waves reach the base)', () => {
    // No player commands → the base should take damage over a long run.
    const engine = createGameEngine(campaignConfig('ch1_lv1'));
    for (let i = 0; i < 3000; i++) engine.tick(TICK_DT);
    expect(engine.state.bottomPlayer.baseHp).toBeLessThan(100);
  });

  it('the stress level forms a large concurrent swarm and stays deterministic', () => {
    // Scaling guard for S6: the logic core must handle a big swarm without
    // error, and the simulation stays reproducible under heavy load.
    const run = (): number => {
      const engine = createGameEngine(campaignConfig('ch_stress'));
      let maxConcurrent = 0;
      for (let i = 0; i < 300; i++) {
        engine.tick(TICK_DT);
        maxConcurrent = Math.max(maxConcurrent, engine.state.board.units.size);
      }
      return maxConcurrent;
    };
    const peak = run();
    expect(peak).toBeGreaterThan(80);   // a real swarm formed
    expect(run()).toBe(peak);           // same load, same peak — deterministic
  });
});
