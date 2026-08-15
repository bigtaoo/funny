/**
 * ResourceSystem — tick-based ink regen. Lines were already 100% covered, but branch coverage
 * was only 63.64%: the `mult !== 1` (bottomInkRegenMult) path, the `delta === 0` (ink capped,
 * no event) path, and 3 of the 4 acceleration-tier branches in regenFpPerInkPerS were never
 * exercised. All arithmetic here is exact integer math (no floats), matching the system's own
 * "no floating-point operations" contract — expected values are computed with the exact same
 * formula the source uses, mirroring the style of trait-system.test.ts's regen assertions.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { ResourceSystem } from '../systems/ResourceSystem';
import {
  INK_REGEN_BASE,
  REGEN_FP_PER_INK_PER_S_NORMAL, REGEN_FP_PER_INK_PER_S_ACCEL1,
  REGEN_FP_PER_INK_PER_S_ACCEL2, REGEN_FP_PER_INK_PER_S_ACCEL3,
  ACCEL_THRESHOLD_1_TICKS, ACCEL_THRESHOLD_2_TICKS, ACCEL_THRESHOLD_3_TICKS,
} from '../config';
import { toFp, FP_SCALE } from '../math/fixed';

/** Run `system.tick(state)` exactly `n` times. */
function tickN(system: ResourceSystem, state: GameState, n: number): void {
  for (let i = 0; i < n; i++) system.tick(state);
}

// ── Acceleration-tier branches (regenFpPerInkPerS) ────────────────────────────────────────────

test('regen tier: below ACCEL_THRESHOLD_1_TICKS uses the NORMAL rate', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = 0;

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_NORMAL;
  const ticksNeeded = Math.ceil(FP_SCALE / totalFpPerTick);

  tickN(system, state, ticksNeeded - 1);
  assert.equal(state.bottomPlayer.ink, 0, 'not enough fp accumulated yet at the NORMAL rate');

  system.tick(state);
  assert.equal(state.bottomPlayer.ink, 1, 'exactly 1 ink once the NORMAL-rate fp total crosses 1000');
});

test('regen tier: at ACCEL_THRESHOLD_1_TICKS uses the ACCEL1 rate', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = ACCEL_THRESHOLD_1_TICKS;

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_ACCEL1;
  const ticksNeeded = Math.ceil(FP_SCALE / totalFpPerTick);

  tickN(system, state, ticksNeeded - 1);
  assert.equal(state.bottomPlayer.ink, 0);

  system.tick(state);
  assert.equal(state.bottomPlayer.ink, 1);
});

test('regen tier: at ACCEL_THRESHOLD_2_TICKS uses the ACCEL2 rate', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = ACCEL_THRESHOLD_2_TICKS;

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_ACCEL2;
  const ticksNeeded = Math.ceil(FP_SCALE / totalFpPerTick);

  tickN(system, state, ticksNeeded - 1);
  assert.equal(state.bottomPlayer.ink, 0);

  system.tick(state);
  assert.equal(state.bottomPlayer.ink, 1);
});

test('regen tier: at ACCEL_THRESHOLD_3_TICKS uses the ACCEL3 rate', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = ACCEL_THRESHOLD_3_TICKS;

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_ACCEL3;
  const ticksNeeded = Math.ceil(FP_SCALE / totalFpPerTick);

  tickN(system, state, ticksNeeded - 1);
  assert.equal(state.bottomPlayer.ink, 0);

  system.tick(state);
  assert.equal(state.bottomPlayer.ink, 1);
});

// ── bottomInkRegenMult branch (mult !== 1, including a genuine Math.round case) ───────────────

test('bottomInkRegenMult !== 1 scales only the bottom player\'s regen, rounding a non-integer product', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = 0; // NORMAL tier: totalFp/tick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_NORMAL
  state.bottomInkRegenMult = 1.3; // forces the Math.round(totalFp * mult) branch (66*1.3=85.8 -> 86)

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_NORMAL;
  const bottomFpPerTick = Math.round(totalFpPerTick * 1.3);
  assert.equal(bottomFpPerTick, 86, 'sanity: this mult must force an actual (non-exact) rounding');

  const bottomTicksNeeded = Math.ceil(FP_SCALE / bottomFpPerTick);
  const topTicksNeeded = Math.ceil(FP_SCALE / totalFpPerTick); // top always uses mult=1
  assert.ok(bottomTicksNeeded < topTicksNeeded, 'sanity: the boosted bottom player must reach 1 ink strictly sooner');

  tickN(system, state, bottomTicksNeeded);

  assert.equal(state.bottomPlayer.ink, 1, 'bottom player regen was scaled by bottomInkRegenMult');
  assert.equal(state.topPlayer.ink, 0, 'top player must never be affected by bottomInkRegenMult (mult stays 1)');
});

// ── delta !== 0 branch (event only fires on a visible ink change) ─────────────────────────────

test('resource_changed fires only when the visible integer ink actually changes', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();

  // First tick from ink=0: NORMAL-tier fp/tick is < 1000, so the integer `ink` getter (trunc)
  // does not change yet -> delta === 0 -> no event this tick.
  system.tick(state);
  const firstTickEvents = state.events.filter((e) => e.type === 'resource_changed');
  assert.equal(firstTickEvents.length, 0, 'a sub-1-ink fp gain must not push a resource_changed event');

  // Once both players are already at the ink cap, addInkFp always returns delta 0.
  state.clearEvents();
  state.bottomPlayer.addInkFp(toFp(1000));
  state.topPlayer.addInkFp(toFp(1000));
  state.clearEvents();

  system.tick(state);
  const cappedTickEvents = state.events.filter((e) => e.type === 'resource_changed');
  assert.equal(cappedTickEvents.length, 0, 'no event should fire once ink is already capped (delta === 0)');
});

test('resource_changed fires with the correct owner/ink once the integer ink crosses to 1', () => {
  const state  = new GameState(1);
  const system = new ResourceSystem();
  state.elapsedTicks = 0;

  const totalFpPerTick = INK_REGEN_BASE * REGEN_FP_PER_INK_PER_S_NORMAL;
  const ticksNeeded = Math.ceil(FP_SCALE / totalFpPerTick);

  tickN(system, state, ticksNeeded - 1);
  state.clearEvents();

  system.tick(state);
  const events = state.events.filter((e) => e.type === 'resource_changed');
  // Both players regen identically by default (mult=1 for both), so both cross to ink=1 together.
  assert.equal(events.length, 2);
  const owners = events.map((e) => (e as { owner: number }).owner).sort();
  assert.deepEqual(owners, [0, 1]);
  for (const e of events) assert.equal((e as { ink: number }).ink, 1);
});
