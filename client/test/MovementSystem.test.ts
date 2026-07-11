import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { Building } from '../src/game/Building';
import { MovementSystem } from '../src/game/systems/MovementSystem';
import { toFp, mulFp, TICK_DT_FP } from '../src/game/math/fixed';
import { BASE_HP, BASE_COLS, TOP_BUILDING_ROW } from '../src/game/config';
import { Side, UnitType, UnitState, BuildingType } from '../src/game/types';

function tickN(state: GameState, sys: MovementSystem, n: number): void {
  for (let i = 0; i < n; i++) sys.tick(state);
}

describe('MovementSystem — forward movement', () => {
  it('advances a lone Infantry toward the enemy at the fixed per-tick step', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 1); // spawn row 1
    state.board.addUnit(u);

    const startY = u.y_fp;
    // Per-tick step is derived from the unit's speed so this tracks blueprint tuning.
    const stepFp = mulFp(u.speed_fp, TICK_DT_FP) as number;
    sys.tick(state);
    expect((u.y_fp as number) - (startY as number)).toBe(stepFp);
    expect(u.state).toBe(UnitState.Moving);

    tickN(state, sys, 9);
    expect((u.y_fp as number) - (startY as number)).toBe(stepFp * 10); // 10 ticks total
  });

  it('enters Crossing state upon reaching the enemy building row', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    // Place just below the top building row so it crosses quickly.
    const u = new Unit(UnitType.Infantry, Side.Bottom, 0, TOP_BUILDING_ROW - 1);
    state.board.addUnit(u);

    // Advance until it snaps to the crossing threshold.
    tickN(state, sys, 60);
    expect(u.state).toBe(UnitState.Crossing);
    expect(u.y_fp).toBe(toFp(TOP_BUILDING_ROW));
  });

  it('a crossing unit reaches the base, damages the opponent, and despawns', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    const u = new Unit(UnitType.Infantry, Side.Bottom, 0, TOP_BUILDING_ROW); // start at threshold
    state.board.addUnit(u);

    const before = state.topPlayer.baseHp;
    // From col 0 to base col 5 = 5000 fp at 33 fp/tick ≈ 152 ticks; give margin.
    tickN(state, sys, 220);

    expect(state.topPlayer.baseHp).toBeLessThan(before);
    // Base damage on arrival is the unit's siege value, not combat attack (ADR-026).
    expect(state.topPlayer.baseHp).toBe(before - u.siegeValue);
    expect(state.board.units.has(u.id)).toBe(false); // despawned
    expect(BASE_COLS).toContain(5);
    expect(BASE_HP).toBe(100);
  });
});

describe('MovementSystem — friendly collision', () => {
  it('a faster unit never overtakes or overlaps a slower friendly unit ahead', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    const front = new Unit(UnitType.ShieldBearer, Side.Bottom, 3, 3); // slow (speed 0.6)
    const back = new Unit(UnitType.Infantry, Side.Bottom, 3, 1); // fast (speed 1.0)
    state.board.addUnit(front);
    state.board.addUnit(back);

    tickN(state, sys, 300);

    // Back unit stays strictly behind the front unit.
    expect((back.y_fp as number)).toBeLessThan(front.y_fp as number);

    // No significant overlap: gap between footprints stays >= -1 fp (truncation slack).
    const gap =
      (front.y_fp as number) - (front.radius_fp as number) -
      ((back.y_fp as number) + (back.radius_fp as number));
    expect(gap).toBeGreaterThanOrEqual(-1);

    // Having caught up, the trailing unit is blocked (Waiting), not Moving.
    expect(back.state).toBe(UnitState.Waiting);
  });
});

describe('MovementSystem — a crossing leader frees the lane behind it', () => {
  it('a trailing lane unit is not blocked once the leader crosses into another column', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Same column, leader near the crossing row, follower a few cells behind.
    const leader = new Unit(UnitType.Infantry, Side.Bottom, 0, TOP_BUILDING_ROW - 2);
    const follower = new Unit(UnitType.Infantry, Side.Bottom, 0, TOP_BUILDING_ROW - 5);
    state.board.addUnit(leader);
    state.board.addUnit(follower);

    // The leader reaches row 17, enters Crossing, and moves sideways out of col 0.
    // Before the columnUnits fix, the follower would wait forever behind a phantom
    // leader still listed in col 0. Now it advances all the way to the crossing row.
    tickN(state, sys, 400);

    expect(follower.row).toBe(TOP_BUILDING_ROW);
    expect([UnitState.Crossing, UnitState.Dead]).toContain(follower.state);
  });
});

describe('MovementSystem — crossing collision does not flap', () => {
  it('a unit jammed behind a frozen friendly crosser stays blocked (no Moving/Waiting flap)', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Freeze the leader: an enemy building one cell ahead in the crossing path
    // means the leader can never advance, so the follower behind it must stay put.
    const wall = new Building(BuildingType.Barracks, Side.Top, 3, TOP_BUILDING_ROW);
    state.board.addBuilding(wall);

    const leader = new Unit(UnitType.Infantry, Side.Bottom, 2, TOP_BUILDING_ROW);
    const follower = new Unit(UnitType.Infantry, Side.Bottom, 1, TOP_BUILDING_ROW);
    leader.state = UnitState.Crossing;
    follower.state = UnitState.Crossing;
    state.board.addUnit(leader);
    state.board.addUnit(follower);

    // Let the follower close the gap and jam up against the frozen leader.
    tickN(state, sys, 30);
    expect(follower.crossingBlocked).toBe(true);

    // Over a long window it must remain blocked (the leader is frozen): it never
    // flaps back to advancing on a sub-footprint gap, and never overruns the leader.
    let unblockedTicks = 0;
    for (let i = 0; i < 60; i++) {
      sys.tick(state);
      if (!follower.crossingBlocked) unblockedTicks++;
    }
    expect(unblockedTicks).toBe(0);
    expect(follower.x_fp).toBeLessThan(leader.x_fp);
  });
});
