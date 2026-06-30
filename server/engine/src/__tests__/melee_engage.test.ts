/**
 * Melee units must not "pass through" an attackable enemy directly ahead (regression fix test).
 *
 * Background bug: MovementSystem advances using continuous fp coordinates while CombatSystem
 * determines engagement using integer-cell Chebyshev distance. Two melee units charging each
 * other in the same column would each round in opposite directions — for example Bottom at
 * y=5.49 (row 5) and Top at y=6.51 (row 7) have a continuous gap of only ~1.0 cells, but the
 * integer cell distance reads as 2, so range-1 melee does not engage; on the next tick both
 * advance to y≈6.0 → same cell (distance 0), but findTarget scans from dist=1 and never
 * finds distance 0, so they walk straight through each other.
 *
 * Fix: moveForward clamps before advancing — the centre-to-centre distance to an attackable
 * enemy ahead must not drop below 1 cell, guaranteeing a cell distance ≥ 1 so that
 * CombatSystem will always engage on the next tick.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { CombatSystem } from '../systems/CombatSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { fp } from '../math/fixed';
import { Side, UnitState, UnitType } from '../types';

/** Run one engine sim step in the real system order: combat → movement. */
function step(state: GameState, combat: CombatSystem, movement: MovementSystem): void {
  combat.tick(state);
  movement.tick(state);
  state.elapsedTicks++;
}

test('melee units engage instead of walking through each other (rounding-adverse approach)', () => {
  const state    = new GameState(1);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 5;

  // Bottom infantry (moves toward higher rows). Rounds DOWN to row 5.
  const bottom = new Unit(UnitType.Infantry, Side.Bottom, COL, 5);
  bottom.y_fp = fp(5490); // row = round(5.49) = 5

  // Top infantry (moves toward lower rows). Rounds UP to row 7.
  const top = new Unit(UnitType.Infantry, Side.Top, COL, 7);
  top.y_fp = fp(6510); // row = round(6.51) = 7

  // Sanity: continuous gap is ~1 cell, but the integer cell distance reads as 2,
  // so CombatSystem (range 1) will NOT engage on the first tick — the exact window
  // where the old code let them slip through.
  assert.equal(bottom.row, 5);
  assert.equal(top.row, 7);
  assert.equal(Math.abs(bottom.row - top.row), 2);

  // Add AFTER positioning so the grid cell + sorted column list match y_fp.
  state.board.addUnit(bottom);
  state.board.addUnit(top);

  // Drive several steps — more than enough for them to meet and fight.
  let engaged = false;
  for (let i = 0; i < 30; i++) {
    step(state, combat, movement);

    // Invariant: the Bottom unit must never cross past the Top unit. If it ever
    // walks through, bottom.y_fp would exceed top.y_fp.
    assert.ok(
      bottom.y_fp < top.y_fp,
      `tick ${i}: bottom (y=${bottom.y_fp}) walked through top (y=${top.y_fp})`,
    );

    if (bottom.state === UnitState.Attacking || top.state === UnitState.Attacking) {
      engaged = true;
    }
    if (bottom.isDead || top.isDead) break;
  }

  // They must have actually fought (someone took damage / a kill happened),
  // proving the unit didn't sail past a target it should attack.
  assert.ok(engaged, 'melee units never engaged — one walked past the other');
});

test('melee unit clamps to one cell behind an enemy ahead in its lane', () => {
  const state    = new GameState(2);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 4;

  const bottom = new Unit(UnitType.Infantry, Side.Bottom, COL, 5);
  bottom.y_fp = fp(5490);
  const top = new Unit(UnitType.Infantry, Side.Top, COL, 7);
  top.y_fp = fp(6510);

  state.board.addUnit(bottom);
  state.board.addUnit(top);

  // First step: combat sees cell-distance 2 → no engage; movement must clamp the
  // bottom unit so it stays at least one full cell (1000 fp) behind the top unit
  // instead of advancing into / past its cell.
  step(state, combat, movement);

  assert.ok(
    bottom.y_fp <= top.y_fp - 1000,
    `bottom (y=${bottom.y_fp}) not kept >= 1 cell behind top (y=${top.y_fp})`,
  );
  // After the clamp they sit exactly one cell apart, so the next step engages.
  step(state, combat, movement);
  assert.ok(
    bottom.state === UnitState.Attacking && top.state === UnitState.Attacking,
    'units did not engage on the tick after clamping to 1-cell distance',
  );
});
