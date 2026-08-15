/**
 * Direct unit coverage for systems/ai/meteorTargeting.ts — the ink-value gating branch
 * (`minCostForValue > 0`, used by AISystem's offensive-meteor step at useValueTrades
 * levels) and estimateUnitCost's public-cost lookup, neither of which was exercised by
 * ai_difficulty.test.ts (its only meteor scenario calls findMeteorTarget with
 * minCostForValue === 0, the defensive path).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Side, UnitType } from '../types';
import { findMeteorTarget, estimateUnitCost } from '../systems/ai/meteorTargeting';

function place2x2(state: GameState, unitType: UnitType, col: number, row: number): void {
  state.board.addUnit(new Unit(unitType, Side.Bottom, col, row));
  state.board.addUnit(new Unit(unitType, Side.Bottom, col + 1, row));
  state.board.addUnit(new Unit(unitType, Side.Bottom, col, row + 1));
  state.board.addUnit(new Unit(unitType, Side.Bottom, col + 1, row + 1));
}

// ─── estimateUnitCost ────────────────────────────────────────────────────────────────

test('estimateUnitCost returns the cheapest pool card cost for a unit type', () => {
  assert.equal(estimateUnitCost(UnitType.Runner), 3);
  assert.equal(estimateUnitCost(UnitType.Ironclad), 8);
  assert.equal(estimateUnitCost(UnitType.Infantry), 4);
});

test('estimateUnitCost returns 0 for a unit type with no matching card in the pool', () => {
  assert.equal(estimateUnitCost('not_a_real_unit_type' as UnitType), 0);
});

// ─── findMeteorTarget: ink-value gating (minCostForValue > 0) ───────────────────────

test('findMeteorTarget rejects a cluster whose total public cost does not clear 1.3x the spell cost', () => {
  resetUnitIds();
  const state = new GameState(1);
  // 4 Runners (cost 3 each = 12 total). Spell cost 12 -> threshold 12*1.3 = 15.6, 12 < 15.6: reject.
  place2x2(state, UnitType.Runner, 2, 2);

  const target = findMeteorTarget(state, 4, /*preferNearBase*/ false, 12);
  assert.equal(target, null, 'cheap cluster must not clear the value-trade threshold');
});

test('findMeteorTarget accepts a cluster whose total public cost clears 1.3x the spell cost', () => {
  resetUnitIds();
  const state = new GameState(1);
  // 4 Infantry (cost 4 each = 16 total). Spell cost 12 -> threshold 15.6, 16 >= 15.6: accept.
  place2x2(state, UnitType.Infantry, 2, 2);

  const target = findMeteorTarget(state, 4, /*preferNearBase*/ false, 12);
  assert.deepEqual(target, { col: 2, row: 2 });
});

test('findMeteorTarget value-gating: a rejected cheap cluster still lets a separate cluster that clears the threshold win', () => {
  resetUnitIds();
  const state = new GameState(1);
  place2x2(state, UnitType.Runner, 0, 0);   // cost 12 total -> rejected
  place2x2(state, UnitType.Ironclad, 6, 6); // cost 32 total -> accepted

  const target = findMeteorTarget(state, 4, /*preferNearBase*/ false, 12);
  assert.deepEqual(target, { col: 6, row: 6 });
});
