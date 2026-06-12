import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import type { GameConfig } from '../src/game/types';

/**
 * Determinism / golden-replay guard.
 *
 * The whole engine is built on a fixed tick rate + LCG PRNG + integer math.
 * Therefore: same seed + same command stream ⇒ byte-identical evolution.
 *
 * These tests assert that property structurally (run-vs-run), so they keep
 * protecting determinism even as the balance numbers change — there is no
 * hand-copied "golden number" to rot.
 */

const TICK_DT = 1 / 30;

function makeConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

/** A compact, deep-comparable fingerprint of the full game state. */
function fingerprint(seed: number, ticks: number): unknown {
  const engine = createGameEngine(makeConfig(seed));
  for (let i = 0; i < ticks; i++) engine.tick(TICK_DT);

  const s = engine.state;
  const units = Array.from(s.board.units.values())
    .map((u) => `${u.id}:${u.unitType}:${u.side}:${u.col}:${u.y_fp}:${u.x_fp}:${u.hp}:${u.state}`)
    .sort();
  const buildings = Array.from(s.board.buildings.values())
    .map((b) => `${b.id}:${b.buildingType}:${b.side}:${b.col}:${b.row}:${b.hp}`)
    .sort();

  return {
    elapsedTicks: s.elapsedTicks,
    phase: s.phase,
    winner: s.winner,
    bottomBaseHp: s.bottomPlayer.baseHp,
    topBaseHp: s.topPlayer.baseHp,
    bottomCoins: s.bottomPlayer.coins,
    topCoins: s.topPlayer.coins,
    bottomUpgrade: s.bottomPlayer.upgradeLevel,
    topUpgrade: s.topPlayer.upgradeLevel,
    units,
    buildings,
    stats: s.snapshotStats(),
  };
}

describe('engine determinism (golden replay)', () => {
  it('two runs with the same seed evolve identically (short horizon)', () => {
    expect(fingerprint(0xC0FFEE, 300)).toEqual(fingerprint(0xC0FFEE, 300));
  });

  it('two runs with the same seed evolve identically (long horizon, with combat)', () => {
    // 1800 ticks = 60s: enough for AI to play cards, units to clash, bases to take damage.
    expect(fingerprint(42, 1800)).toEqual(fingerprint(42, 1800));
  });

  it('different seeds diverge', () => {
    expect(fingerprint(1, 1800)).not.toEqual(fingerprint(999, 1800));
  });

  it('produces meaningful activity over a long run (sanity, not a frozen value)', () => {
    const engine = createGameEngine(makeConfig(7));
    for (let i = 0; i < 1800; i++) engine.tick(TICK_DT);
    const s = engine.state;
    // Both AIs spent gold and sent units — the sim actually did something.
    expect(s.stats[0].unitsSent + s.stats[1].unitsSent).toBeGreaterThan(0);
    // The game runs until GameOver or the tick budget, whichever comes first.
    expect(s.elapsedTicks).toBeGreaterThan(0);
    expect(s.elapsedTicks).toBeLessThanOrEqual(1800);
  });
});
