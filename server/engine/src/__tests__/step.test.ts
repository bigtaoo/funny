/**
 * sim/step.ts coverage gap: the BridgeCollapse column-expiry cleanup loop
 * (`for (const [col, expiresAt] of state.tempBlockedCols) if (elapsedTicks >= expiresAt) delete`)
 * was never exercised — no existing test ever let a temp-blocked column's timer actually
 * elapse. Pins a near-future expiry directly on state.tempBlockedCols instead of playing
 * out the full BRIDGE_COLLAPSE_DURATION_TICKS (240 ticks) via the spell.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { ATTACK_LANES } from '../config';
import type { GameConfig } from '../types';

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

test('a tempBlockedCols entry is removed once elapsedTicks reaches its expiry (stepEngine cleanup loop)', () => {
  const engine = createGameEngine(pvpConfig(40));
  engine.step(0, []); // elapsedTicks -> 1

  const col = ATTACK_LANES[0]!;
  engine.state.tempBlockedCols.set(col, engine.state.elapsedTicks + 1);
  assert.ok(engine.state.tempBlockedCols.has(col));

  engine.step(1, []); // elapsedTicks -> 2, still < expiry (elapsedTicks+1 at time of set = 2) -> boundary hit
  assert.ok(!engine.state.tempBlockedCols.has(col), 'the block expires once elapsedTicks reaches the recorded expiry tick');
});
