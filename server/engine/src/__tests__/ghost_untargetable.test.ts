/**
 * Repro: a live unit can vanish from the spatial grid and become untargetable.
 *
 * Board.unitGrid holds ONE unit id per (col,row) cell; setUnitCell overwrites and
 * clearUnitCell nulls without checking which id owns the cell. Units are positioned
 * with continuous fp coordinates and snapped to an integer cell via Math.round, and
 * the collision systems only guarantee a surface gap of (r1+r2) between two units in
 * a lane. For small-radius units (Runner r=0.25 → 0.5-cell centre gap) two stacked
 * same-side units routinely round to the SAME integer cell — e.g. leader at y=4.8,
 * follower pushed to y=5.3, both round to row 5.
 *
 * When that happens the second occupant overwrites the grid slot, orphaning the first:
 * it stays alive in board.units (so MovementSystem/CombatSystem still move & fire it)
 * but board.getUnitAt no longer returns it. Every defender's target scan goes through
 * getUnitAt (CombatSystem.findTarget for units, findTargetForBuilding for arrow towers),
 * so the orphaned enemy is invisible to all defenders while it keeps sieging — exactly
 * the reported "this enemy can't be attacked but destroys my barracks and tower".
 *
 * Invariant this test pins: every live unit in board.units must be retrievable via
 * getUnitAt at its own (col,row).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Building } from '../Building';
import { CombatSystem } from '../systems/CombatSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { fp } from '../math/fixed';
import { BuildingType, Side, UnitType } from '../types';

function step(state: GameState, combat: CombatSystem, movement: MovementSystem): void {
  combat.tick(state);
  movement.tick(state);
  state.elapsedTicks++;
}

/** Assert every living unit is findable via the spatial grid at its own cell. */
function assertAllLiveUnitsIndexed(state: GameState, tick: number): void {
  for (const u of state.board.units.values()) {
    if (u.isDead) continue;
    const here = state.board.getUnitsAt(u.col, u.row);
    assert.ok(
      here.includes(u),
      `tick ${tick}: live unit id=${u.id} at (col=${u.col},row=${u.row}) is NOT in the grid `
      + `(cell holds ${here.map(x => x.id).join(',') || 'none'}) — it is a ghost: `
      + `active but untargetable`,
    );
  }
}

test('stacked same-side units stay targetable (no ghost in the grid)', () => {
  const state    = new GameState(1);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 5;

  // Two Top-side Runners in the same lane, follower just behind the leader. Runner
  // radius 0.25 → friendly-collision keeps a 0.5-cell centre gap, which straddles a
  // rounding boundary for part of every advance → both snap to the same cell.
  const leader   = new Unit(UnitType.Runner, Side.Top, COL, 8);
  leader.y_fp    = fp(8000);
  const follower = new Unit(UnitType.Runner, Side.Top, COL, 9);
  follower.y_fp  = fp(8600); // 0.6 behind; collision will settle it to ~0.5

  state.board.addUnit(leader);
  state.board.addUnit(follower);

  let sawSameCell = false;
  for (let i = 0; i < 200; i++) {
    step(state, combat, movement);
    if (leader.isDead || follower.isDead) break;
    if (!leader.isDead && !follower.isDead && leader.col === follower.col && leader.row === follower.row) {
      sawSameCell = true;
    }
    assertAllLiveUnitsIndexed(state, i);
  }

  // Guard: the scenario must actually have exercised the same-cell overlap, else the
  // test would pass vacuously.
  assert.ok(sawSameCell, 'two stacked Runners never shared a cell — repro did not trigger');
});

test('an arrow tower can damage a stacked enemy that would otherwise be a ghost', () => {
  const state    = new GameState(3);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 5;

  // Two stationary Top Runners stacked on the same cell (in range of a Bottom tower).
  // Before the fix, one overwrote the other in the grid → the tower's findTargetForBuilding
  // could only ever see one of them; the other took zero fire forever.
  const a = new Unit(UnitType.Runner, Side.Top, COL, 5);
  a.y_fp  = fp(4800); // rounds to row 5
  const b = new Unit(UnitType.Runner, Side.Top, COL, 5);
  b.y_fp  = fp(5300); // also rounds to row 5 — same cell as `a`
  state.board.addUnit(a);
  state.board.addUnit(b);

  assert.equal(a.row, 5);
  assert.equal(b.row, 5);
  assert.equal(state.board.getUnitsAt(COL, 5).length, 2, 'both units must occupy the cell');

  // Bottom arrow tower two cells away — both stacked runners are within its range.
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, COL, 3);
  state.board.addBuilding(tower);
  assert.ok(tower.isDefender && tower.attackRange >= 2, 'tower must be a defender with range');

  const aStartHp = a.hp;
  const bStartHp = b.hp;

  // Freeze the units in place so the test isolates targeting, not movement: keep
  // re-pinning their positions each tick and only run the combat phase.
  for (let i = 0; i < 400; i++) {
    a.y_fp = fp(4800); b.y_fp = fp(5300);
    combat.tick(state);
    state.elapsedTicks++;
    if (a.isDead && b.isDead) break;
  }

  assert.ok(a.hp < aStartHp, 'stacked unit A never took tower fire (still a ghost)');
  assert.ok(b.hp < bStartHp, 'stacked unit B never took tower fire (still a ghost)');
});

test('a unit engages an enemy that shares a cell with a lower-id friendly', () => {
  const state    = new GameState(4);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 5;

  // Friendly Bottom body added FIRST → lower id. A lowest-id-wins single lookup would
  // return this friendly for the enemy's cell and hide the actual target behind it.
  const friendly = new Unit(UnitType.Infantry, Side.Bottom, COL, 5);
  friendly.y_fp  = fp(5000);
  const enemy    = new Unit(UnitType.Infantry, Side.Top, COL, 5);
  enemy.y_fp     = fp(5000); // same cell as friendly
  // Bottom attacker one cell below the shared cell (melee range 1).
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, COL, 4);
  attacker.y_fp  = fp(4000);

  state.board.addUnit(friendly);
  state.board.addUnit(enemy);
  state.board.addUnit(attacker);
  assert.ok(enemy.id > friendly.id, 'test setup: enemy must have the higher id');

  const enemyStartHp    = enemy.hp;
  const friendlyStartHp = friendly.hp;

  // Freeze positions and run only combat: isolates target selection from movement.
  for (let i = 0; i < 60; i++) {
    friendly.y_fp = fp(5000); enemy.y_fp = fp(5000); attacker.y_fp = fp(4000);
    combat.tick(state);
    state.elapsedTicks++;
    if (enemy.isDead) break;
  }

  assert.ok(enemy.hp < enemyStartHp, 'attacker never hit the enemy hidden behind a friendly');
  assert.equal(friendly.hp, friendlyStartHp, 'attacker must never damage its own side');
  (void movement);
});
