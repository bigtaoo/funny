/**
 * sim/winCondition.ts coverage gaps: four branches never reached by any existing test —
 *  - bottomPlayer.isDead (the very first check, applies to PvP AND campaign/siege alike):
 *    every existing test that ends a match ends it via the campaign/siege-specific paths
 *    or the plain-PvP topPlayer.isDead path below, never via the LOCAL player's own base
 *    dying.
 *  - topPlayer.isDead reached via the plain-PvP tail (no waveDirector) — existing
 *    topPlayer.isDead coverage all goes through the campaign/siege `waveDirector` branch
 *    above it.
 *  - FORCE_DRAW_THRESHOLD_TICKS reached → game_draw.
 *  - COUNTDOWN_THRESHOLD_TICKS reached → game_countdown_start (fired once, gated by
 *    countdownStarted).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { buildEngineCtx } from '../engine/setup/buildCtx';
import { checkWinCondition } from '../engine/sim/winCondition';
import { COUNTDOWN_THRESHOLD_TICKS, FORCE_DRAW_THRESHOLD_TICKS } from '../config';
import { toFp } from '../math/fixed';
import { GamePhase, Side } from '../types';
import type { GameConfig } from '../types';

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

test('bottomPlayer.isDead ends the match immediately with Top winning (checked before the campaign/waveDirector branch)', () => {
  const engine = createGameEngine(pvpConfig(50));
  engine.state.bottomPlayer.baseHp_fp = toFp(0);

  const events = engine.step(0, []);

  assert.equal(engine.state.phase, GamePhase.GameOver);
  assert.equal(engine.state.winner, Side.Top);
  assert.ok(events.some((e) => e.type === 'game_over' && e.winner === 1));
  assert.ok(events.some((e) => e.type === 'game_stats'));
});

test('topPlayer.isDead in plain PvP (no waveDirector) ends the match with Bottom winning', () => {
  const engine = createGameEngine(pvpConfig(51));
  engine.state.topPlayer.baseHp_fp = toFp(0);

  const events = engine.step(0, []);

  assert.equal(engine.state.phase, GamePhase.GameOver);
  assert.equal(engine.state.winner, Side.Bottom);
  assert.ok(events.some((e) => e.type === 'game_over' && e.winner === 0));
});

test('reaching FORCE_DRAW_THRESHOLD_TICKS ends the match as a draw (no winner)', () => {
  const engine = createGameEngine(pvpConfig(52));
  engine.state.elapsedTicks = FORCE_DRAW_THRESHOLD_TICKS - 1;

  const events = engine.step(0, []);

  assert.equal(engine.state.phase, GamePhase.GameOver);
  assert.equal(engine.state.winner, null, 'a forced draw sets no winner');
  assert.ok(events.some((e) => e.type === 'game_draw'));
  assert.ok(events.some((e) => e.type === 'game_stats'));
});

test('reaching COUNTDOWN_THRESHOLD_TICKS starts the countdown exactly once', () => {
  const engine = createGameEngine(pvpConfig(53));
  engine.state.elapsedTicks = COUNTDOWN_THRESHOLD_TICKS - 1;
  assert.equal(engine.state.countdownStarted, false);

  const events = engine.step(0, []);

  assert.equal(engine.state.phase, GamePhase.Playing, 'countdown alone does not end the match');
  assert.equal(engine.state.countdownStarted, true);
  assert.ok(events.some((e) => e.type === 'game_countdown_start'));

  // A second step at/after the threshold must NOT re-fire the event (gated by countdownStarted).
  const events2 = engine.step(1, []);
  assert.ok(!events2.some((e) => e.type === 'game_countdown_start'), 'countdown start fires only once');
});

test('checkWinCondition is a no-op guard when called directly on an already-GameOver state', () => {
  // stepEngine's own top-level guard means checkWinCondition never actually gets called
  // this way through the normal step() loop — this exercises the free function's own
  // defensive early return directly.
  const ctx = buildEngineCtx(pvpConfig(54));
  ctx.state.phase = GamePhase.GameOver;
  ctx.state.winner = Side.Top;
  ctx.state.clearEvents();

  checkWinCondition(ctx);

  assert.equal(ctx.state.phase, GamePhase.GameOver, 'unchanged');
  assert.equal(ctx.state.winner, Side.Top, 'unchanged');
  assert.deepEqual(ctx.state.events, [], 'no new events pushed');
});
