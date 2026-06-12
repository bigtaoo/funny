import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { MovementSystem } from '../src/game/systems/MovementSystem';
import { toFp } from '../src/game/math/fixed';
import { BASE_HP, BASE_COLS, TOP_BUILDING_ROW } from '../src/game/config';
import { Side, UnitType, UnitState } from '../src/game/types';

function tickN(state: GameState, sys: MovementSystem, n: number): void {
  for (let i = 0; i < n; i++) sys.tick(state);
}

describe('MovementSystem — forward movement', () => {
  it('advances a lone Swordsman toward the enemy at the fixed per-tick step', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    const u = new Unit(UnitType.Swordsman, Side.Bottom, 0, 1); // spawn row 1
    state.board.addUnit(u);

    const startY = u.y_fp;
    sys.tick(state);
    // speed 1.0 grid/s → 1000 fp/s → per tick mulFp(1000,33) = 33 fp
    expect((u.y_fp as number) - (startY as number)).toBe(33);
    expect(u.state).toBe(UnitState.Moving);

    tickN(state, sys, 9);
    expect((u.y_fp as number) - (startY as number)).toBe(330); // 10 ticks total
  });

  it('enters Crossing state upon reaching the enemy building row', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    // Place just below the top building row so it crosses quickly.
    const u = new Unit(UnitType.Swordsman, Side.Bottom, 0, TOP_BUILDING_ROW - 1);
    state.board.addUnit(u);

    // Advance until it snaps to the crossing threshold.
    tickN(state, sys, 60);
    expect(u.state).toBe(UnitState.Crossing);
    expect(u.y_fp).toBe(toFp(TOP_BUILDING_ROW));
  });

  it('a crossing unit reaches the base, damages the opponent, and despawns', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();
    const u = new Unit(UnitType.Swordsman, Side.Bottom, 0, TOP_BUILDING_ROW); // start at threshold
    state.board.addUnit(u);

    const before = state.topPlayer.baseHp;
    // From col 0 to base col 5 = 5000 fp at 33 fp/tick ≈ 152 ticks; give margin.
    tickN(state, sys, 220);

    expect(state.topPlayer.baseHp).toBeLessThan(before);
    expect(state.topPlayer.baseHp).toBe(before - u.attack);
    expect(state.board.units.has(u.id)).toBe(false); // despawned
    expect(BASE_COLS).toContain(5);
    expect(BASE_HP).toBe(100);
  });
});

describe('MovementSystem — friendly collision', () => {
  it('a faster unit never overtakes or overlaps a slower friendly unit ahead', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    const front = new Unit(UnitType.Guardian, Side.Bottom, 3, 3); // slow (speed 0.6)
    const back = new Unit(UnitType.Swordsman, Side.Bottom, 3, 1); // fast (speed 1.0)
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
