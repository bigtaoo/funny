import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { ResourceSystem } from '../src/game/systems/ResourceSystem';
import {
  INK_CAP,
  INK_REGEN_BASE,
  ACCEL_THRESHOLD_1_TICKS,
} from '../src/game/config';

/** Run the resource system `ticks` times against a fresh-ish state. */
function pump(state: GameState, sys: ResourceSystem, ticks: number): void {
  for (let i = 0; i < ticks; i++) sys.tick(state);
}

describe('ResourceSystem', () => {
  it('accumulates ink at the documented normal rate (2 ink/s)', () => {
    const state = new GameState(1);
    const sys = new ResourceSystem();
    // normal phase: rate = INK_REGEN_BASE(2) * 33 fp/tick = 66 fp/tick
    // after 16 ticks: trunc(16*66 / 1000) = trunc(1056/1000) = 1 ink
    state.elapsedTicks = 0;
    pump(state, sys, 16);
    expect(state.bottomPlayer.ink).toBe(1);
    expect(INK_REGEN_BASE).toBe(2);
  });

  it('never exceeds INK_CAP', () => {
    const state = new GameState(2);
    const sys = new ResourceSystem();
    pump(state, sys, 5000); // way more than enough to overflow
    expect(state.bottomPlayer.ink).toBe(INK_CAP);
    expect(state.topPlayer.ink).toBe(INK_CAP);
  });

  it('base upgrade increases regen rate', () => {
    const state = new GameState(3);
    const sys = new ResourceSystem();
    state.bottomPlayer.upgradeLevel = 1; // rate 3 ink/s vs top's 2
    pump(state, sys, 200);
    expect(state.bottomPlayer.ink).toBeGreaterThan(state.topPlayer.ink);
  });

  it('acceleration phase regenerates faster than normal phase', () => {
    const normal = new GameState(4);
    const accel = new GameState(4);
    const sys = new ResourceSystem();

    normal.elapsedTicks = 0;
    accel.elapsedTicks = ACCEL_THRESHOLD_1_TICKS; // ×1.5 phase

    for (let i = 0; i < 21; i++) {
      sys.tick(normal);
      sys.tick(accel);
    }
    expect(accel.bottomPlayer.ink).toBeGreaterThan(normal.bottomPlayer.ink);
  });

  it('emits resource_changed only when the integer ink count changes', () => {
    const state = new GameState(5);
    const sys = new ResourceSystem();
    // First tick adds 66 fp → still 0 ink → no event.
    state.clearEvents();
    sys.tick(state);
    expect(state.events.filter((e) => e.type === 'resource_changed')).toHaveLength(0);

    // Pump until ink ticks over, then the next crossing emits an event.
    let sawEvent = false;
    for (let i = 0; i < 40; i++) {
      state.clearEvents();
      sys.tick(state);
      if (state.events.some((e) => e.type === 'resource_changed')) sawEvent = true;
    }
    expect(sawEvent).toBe(true);
  });
});
