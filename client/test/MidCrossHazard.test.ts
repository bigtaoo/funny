/**
 * Tests for MidCross (§4.8.1: crossWaypoints + blocked auto-detour)
 * and HazardSystem (§4.8.3: speed / fog / lava effects).
 * Required by design doc §4.8.5.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit, resetUnitIds } from '../src/game/Unit';
import { MovementSystem } from '../src/game/systems/MovementSystem';
import { HazardSystem } from '../src/game/systems/HazardSystem';
import { toFp, fromFp, mulFp, TICK_DT_FP } from '../src/game/math/fixed';
import { Side, UnitState, UnitType } from '../src/game/types';

beforeEach(() => {
  resetUnitIds();
});

function tickN(state: GameState, sys: MovementSystem, n: number): void {
  for (let i = 0; i < n; i++) sys.tick(state);
}

// ─── crossWaypoints lane-switch ──────────────────────────────────────────────

describe('MidCross — crossWaypoints lane-switch', () => {
  it('unit transitions to Detour when its row reaches wp.atRow', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Spawn Bottom Infantry at row 5, col 3; waypoint triggers at row 8 → col 6.
    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
    u.pendingWaypoints = [{ atRow: 8, toCol: 6 }];
    state.board.addUnit(u);

    // Advance until the unit should reach row 8 (17 rows/game, step ≈ 47 fp/tick).
    // Row 5 → 8 = 3 rows = 3000 fp; at ~47 fp/tick ≈ 64 ticks; give margin.
    tickN(state, sys, 100);

    expect(u.state).toBe(UnitState.Detour);
    expect(u.detourTargetCol).toBe(6);
    expect(u.detourDir).toBe(1); // 6 > 3 → right
  });

  it('unit resumes Moving after arriving at the target col', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Put the unit at row 7 so the waypoint triggers almost immediately.
    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 7);
    u.pendingWaypoints = [{ atRow: 8, toCol: 5 }];
    state.board.addUnit(u);

    // Enough ticks for trigger + lateral travel (2 cols × ~1000 fp / 47 fp/tick ≈ 43 ticks)
    tickN(state, sys, 200);

    // Once the unit has arrived at col 5 and forward is clear, it should be Moving.
    expect(u.col).toBe(5);
    expect(u.state).toBe(UnitState.Moving);
    expect(u.detourTargetCol).toBeNull();
  });

  it('consumes only the first waypoint, leaving the rest pending', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 2, 6);
    u.pendingWaypoints = [
      { atRow: 8,  toCol: 4 },
      { atRow: 13, toCol: 7 },
    ];
    state.board.addUnit(u);

    // Advance past row 8 but not row 13.
    tickN(state, sys, 100);

    // First waypoint consumed; second still in queue.
    expect(u.pendingWaypoints.length).toBe(1);
    expect(u.pendingWaypoints[0]!.atRow).toBe(13);
  });
});

// ─── blocked auto-detour ────────────────────────────────────────────────────

describe('MidCross — blocked auto-detour', () => {
  it('unit enters Detour when next row is blocked', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Block the cell directly ahead.
    state.board.setBlocked([{ col: 4, row: 6 }]);

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
    state.board.addUnit(u);

    sys.tick(state); // row 5 → tries row 6, blocked
    expect(u.state).toBe(UnitState.Detour);
    expect(u.detourTargetCol).not.toBeNull();
  });

  it('auto-detour prefers the direction toward board center (col < 5.5 → right)', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    state.board.setBlocked([{ col: 2, row: 6 }]);

    const u = new Unit(UnitType.Infantry, Side.Bottom, 2, 5);
    state.board.addUnit(u);

    sys.tick(state);
    expect(u.state).toBe(UnitState.Detour);
    // col 2 < 5.5 → prefer right (+1), so target should be col 3
    expect(u.detourTargetCol).toBe(3);
    expect(u.detourDir).toBe(1);
  });

  it('auto-detour prefers left for cols above center (col > 5.5)', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    state.board.setBlocked([{ col: 8, row: 6 }]);

    const u = new Unit(UnitType.Infantry, Side.Bottom, 8, 5);
    state.board.addUnit(u);

    sys.tick(state);
    expect(u.detourDir).toBe(-1);
    expect(u.detourTargetCol).toBe(7);
  });

  it('unit resumes Moving once it reaches a clear column', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Block col 4 but not col 5.
    state.board.setBlocked([{ col: 4, row: 6 }]);

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
    state.board.addUnit(u);

    tickN(state, sys, 100);

    // After detouring to col 5 (which is clear) it should be Moving again.
    expect(u.state).toBe(UnitState.Moving);
  });

  it('extends detour col if the detouring destination is also blocked', () => {
    const state = new GameState(1);
    const sys = new MovementSystem();

    // Block both col 4 and col 5 (unit starts col 3, blocked ahead at col 3 row 6).
    // So: blocked at [3,6], [4,6] — auto-detour right: target=4, then 4 also blocked → target=5.
    state.board.setBlocked([
      { col: 3, row: 6 },
      { col: 4, row: 6 },
    ]);

    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
    state.board.addUnit(u);

    // One tick to enter Detour (blocked at row 6).
    sys.tick(state);
    expect(u.state).toBe(UnitState.Detour);

    // Many ticks to reach col 4 and then extend to col 5.
    tickN(state, sys, 200);

    // Should eventually reach col 5 where forward is clear.
    expect(u.col).toBe(5);
    expect(u.state).toBe(UnitState.Moving);
  });
});

// ─── HazardSystem ────────────────────────────────────────────────────────────

describe('HazardSystem — speed zone', () => {
  it('halves unit speed when inside a speed hazard zone', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
    state.board.addUnit(u);
    const baseSpeed = u.baseSpeed_fp as number;

    state.hazards = [{
      col: 3,
      rowRange: [3, 8],
      effect: 'speed',
      speedMult: 0.5,
    }];

    hazSys.tick(state);

    expect(u.speed_fp as number).toBe(Math.round(baseSpeed * 0.5));
  });

  it('restores base speed when outside the zone', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 2); // row 2, zone is rows 3-8
    state.board.addUnit(u);
    const baseSpeed = u.baseSpeed_fp as number;

    state.hazards = [{
      col: 3,
      rowRange: [3, 8],
      effect: 'speed',
      speedMult: 0.5,
    }];

    hazSys.tick(state);

    // Not in zone — speed stays at base.
    expect(u.speed_fp as number).toBe(baseSpeed);
  });

  it('resets speed to base if unit moves out of zone next tick', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
    state.board.addUnit(u);

    state.hazards = [{ col: 3, rowRange: [3, 6], effect: 'speed', speedMult: 0.25 }];

    hazSys.tick(state); // inside zone
    const slowed = u.speed_fp as number;
    expect(slowed).toBeLessThan(u.baseSpeed_fp as number);

    // Manually move unit out of zone row range.
    u.y_fp = toFp(7);
    hazSys.tick(state); // outside zone now
    expect(u.speed_fp as number).toBe(u.baseSpeed_fp as number);
  });
});

describe('HazardSystem — fog zone', () => {
  it('applies negative rangeMod inside a fog hazard', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Archer, Side.Bottom, 5, 5);
    state.board.addUnit(u);

    state.hazards = [{ col: 5, rowRange: [4, 7], effect: 'fog', rangeMod: -1 }];

    hazSys.tick(state);

    expect(u.rangeMod).toBe(-1);
    expect(u.effectiveRange).toBe(Math.max(1, u.range - 1));
  });

  it('rangeMod resets to 0 outside the fog zone', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Archer, Side.Bottom, 5, 2); // row 2, zone rows 4-7
    state.board.addUnit(u);

    state.hazards = [{ col: 5, rowRange: [4, 7], effect: 'fog', rangeMod: -2 }];

    hazSys.tick(state);

    expect(u.rangeMod).toBe(0);
  });

  it('effectiveRange never falls below 1', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    // Archer with range 2; apply -5 fog
    const u = new Unit(UnitType.Archer, Side.Bottom, 5, 5);
    state.board.addUnit(u);

    state.hazards = [{ col: 5, rowRange: [3, 8], effect: 'fog', rangeMod: -5 }];

    hazSys.tick(state);

    expect(u.effectiveRange).toBe(1);
  });
});

describe('HazardSystem — lava zone (DoT)', () => {
  it('applies damage per tick when unit is inside a lava zone', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
    state.board.addUnit(u);
    const startHp = u.hp;

    state.hazards = [{ col: 4, rowRange: [5, 8], effect: 'lava', dps: 30 }];

    hazSys.tick(state);

    // TICK_RATE = 30, so dmgPerTick = ceil(30/30) = 1
    expect(u.hp).toBe(startHp - 1);
  });

  it('lava does not damage units outside its row range', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 2);
    state.board.addUnit(u);
    const startHp = u.hp;

    state.hazards = [{ col: 4, rowRange: [5, 8], effect: 'lava', dps: 30 }];

    hazSys.tick(state);

    expect(u.hp).toBe(startHp);
  });

  it('accumulates lava damage over multiple ticks until unit dies', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    // Use low-HP Runner: hp=30 in blueprints.
    const u = new Unit(UnitType.Runner, Side.Bottom, 3, 5);
    state.board.addUnit(u);

    // High DPS: ceil(600/30) = 20 dmg/tick. Runner hp=30 → dead after 2 ticks.
    state.hazards = [{ col: 3, rowRange: [3, 8], effect: 'lava', dps: 600 }];

    hazSys.tick(state); // 30 - 20 = 10 hp
    expect(u.hp).toBe(10);
    hazSys.tick(state); // 10 - 20 = dead (takeDamage clamps hp to 0 / sets isDead)
    expect(u.isDead).toBe(true);
  });

  it('dead units are skipped by HazardSystem', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
    u.hp = 0;
    // Force isDead — takeDamage will do it; simulate by setting hp then calling takeDamage(0):
    u.takeDamage(0); // hp already 0, sets isDead via the check
    const preHp = u.hp;
    state.board.addUnit(u);

    state.hazards = [{ col: 4, rowRange: [4, 8], effect: 'lava', dps: 900 }];

    hazSys.tick(state);

    // hp unchanged (dead units skipped)
    expect(u.hp).toBe(preHp);
  });
});

// ─── HazardSystem — no hazards (fast path) ──────────────────────────────────

describe('HazardSystem — no-op when state.hazards is empty', () => {
  it('does not mutate any unit when hazards list is empty', () => {
    const state = new GameState(1);
    const hazSys = new HazardSystem();

    const u = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
    state.board.addUnit(u);
    const speedBefore = u.speed_fp;
    const hpBefore = u.hp;

    // state.hazards defaults to [] — no hazards configured.
    hazSys.tick(state);

    expect(u.speed_fp).toBe(speedBefore);
    expect(u.hp).toBe(hpBefore);
    expect(u.rangeMod).toBe(0);
  });
});
