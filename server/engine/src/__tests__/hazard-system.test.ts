/**
 * HazardSystem — per-tick environmental effects applied to units standing inside hazard
 * zones (speed reduction, fog range reduction, lava damage-over-time). Previously only
 * 43.10% line coverage: the empty-hazards early-return, the per-tick reset-before-apply
 * behavior, and every branch of the col/row matching + effect switch were untested. This
 * file drives the real system against a real GameState/Board/Unit and asserts the
 * resulting speed_fp/rangeMod/hp_fp changes directly.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { HazardSystem } from '../systems/HazardSystem';
import { UnitType, Side } from '../types';
import { TICK_RATE, toFp, mulFp } from '../math/fixed';

test('empty hazards: tick() is a complete no-op, even for units with already-modified speed/rangeMod', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  // Simulate a previously-applied modifier that would be reset if the loop ran at all.
  unit.speed_fp = mulFp(unit.baseSpeed_fp, toFp(0.25));
  unit.rangeMod = -7;
  state.board.addUnit(unit);

  assert.equal(state.hazards.length, 0, 'sanity: no hazards configured by default');
  system.tick(state);

  assert.notEqual(unit.speed_fp, unit.baseSpeed_fp, 'early return: speed_fp must not be reset when hazards is empty');
  assert.equal(unit.rangeMod, -7, 'early return: rangeMod must not be reset when hazards is empty');
});

test('dead units are skipped entirely (not reset, not damaged)', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  unit.hp_fp = toFp(0); // isDead === true
  unit.rangeMod = -3;
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [4, 6], effect: 'lava', dps: 999 }];
  system.tick(state);

  assert.equal(unit.hp_fp, toFp(0), 'a dead unit must not take further hazard damage');
  assert.equal(unit.rangeMod, -3, 'a dead unit must be skipped before the per-tick reset');
});

test('hazard on a different column never affects the unit, but the per-tick reset still runs for every live unit', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  unit.speed_fp = mulFp(unit.baseSpeed_fp, toFp(0.25)); // pretend a slow was applied last tick
  state.board.addUnit(unit);

  state.hazards = [{ col: 3, rowRange: [0, 17], effect: 'speed', speedMult: 0.1 }];
  system.tick(state);

  assert.equal(unit.speed_fp, unit.baseSpeed_fp, 'reset-to-base happens unconditionally, before hazard matching');
  assert.equal(unit.rangeMod, 0, 'rangeMod resets to 0 even when no hazard matches');
});

test('hazard whose rowRange excludes the unit is ignored', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 10);
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [0, 5], effect: 'fog' }]; // unit.row=10 is outside [0,5]
  system.tick(state);

  assert.equal(unit.rangeMod, 0, 'fog outside the row range must not apply');
});

test('speed hazard: default speedMult (0.5) halves the unit\'s base speed', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'speed' }]; // no speedMult -> default 0.5
  system.tick(state);

  assert.equal(unit.speed_fp, mulFp(unit.baseSpeed_fp, toFp(0.5)));
});

test('speed hazard: custom speedMult is honored', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  const baseSpeed = unit.baseSpeed_fp;
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'speed', speedMult: 0.25 }];
  system.tick(state);

  assert.equal(unit.speed_fp, mulFp(baseSpeed, toFp(0.25)));
});

test('speed hazard never compounds across ticks — reset-then-reapply keeps the same value every tick', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  const baseSpeed = unit.baseSpeed_fp;
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'speed', speedMult: 0.5 }];
  system.tick(state);
  const afterTick1 = unit.speed_fp;
  system.tick(state);
  const afterTick2 = unit.speed_fp;
  system.tick(state);
  const afterTick3 = unit.speed_fp;

  assert.equal(afterTick1, mulFp(baseSpeed, toFp(0.5)));
  assert.equal(afterTick2, afterTick1, 'must not compound (0.5 * 0.5 * 0.5...) across ticks');
  assert.equal(afterTick3, afterTick1);
});

test('fog hazard: default rangeMod (-1) is applied', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'fog' }]; // no rangeMod -> default -1
  system.tick(state);

  assert.equal(unit.rangeMod, -1);
});

test('fog hazard: custom rangeMod stacks additively across multiple overlapping hazards', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  state.board.addUnit(unit);

  state.hazards = [
    { col: 5, rowRange: [5, 5], effect: 'fog', rangeMod: -2 },
    { col: 5, rowRange: [4, 6], effect: 'fog' }, // default -1, overlapping zone
  ];
  system.tick(state);

  assert.equal(unit.rangeMod, -3, 'fog effects on the same cell must be additive, not overwritten');
  assert.equal(unit.effectiveRange, Math.max(1, unit.range - 3), 'effectiveRange clamps at 1 but rangeMod itself keeps accumulating');
});

test('lava hazard: default dps (5) deals ceil(5/TICK_RATE) real HP per tick', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  const hpBefore = unit.hp_fp;
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'lava' }]; // no dps -> default 5
  system.tick(state);

  const expectedDmg = toFp(Math.ceil(5 / TICK_RATE));
  assert.equal(unit.hp_fp, hpBefore - expectedDmg);
});

test('lava hazard: custom dps honors the exact ceil-per-tick conversion (non-exact division)', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  const hpBefore = unit.hp_fp;
  state.board.addUnit(unit);

  state.hazards = [{ col: 5, rowRange: [5, 5], effect: 'lava', dps: 61 }]; // 61/30 = 2.03 -> ceil = 3
  system.tick(state);

  const expectedDmg = toFp(Math.ceil(61 / TICK_RATE));
  assert.equal(expectedDmg, toFp(3));
  assert.equal(unit.hp_fp, hpBefore - expectedDmg);
});

test('a unit standing where speed + fog + lava zones all overlap gets all three effects the same tick', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new HazardSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 5, 5);
  const baseSpeed = unit.baseSpeed_fp;
  const hpBefore = unit.hp_fp;
  state.board.addUnit(unit);

  // An untouched unit elsewhere must remain fully unaffected.
  const untouched = new Unit(UnitType.Infantry, Side.Bottom, 9, 9);
  state.board.addUnit(untouched);

  state.hazards = [
    { col: 5, rowRange: [5, 5], effect: 'speed', speedMult: 0.4 },
    { col: 5, rowRange: [5, 5], effect: 'fog', rangeMod: -1 },
    { col: 5, rowRange: [5, 5], effect: 'lava', dps: 30 },
  ];
  system.tick(state);

  assert.equal(unit.speed_fp, mulFp(baseSpeed, toFp(0.4)));
  assert.equal(unit.rangeMod, -1);
  assert.equal(unit.hp_fp, hpBefore - toFp(1), '30 dps / 30 TICK_RATE = exactly 1 real HP per tick');

  assert.equal(untouched.speed_fp, untouched.baseSpeed_fp, 'unit outside every hazard column keeps base speed');
  assert.equal(untouched.rangeMod, 0);
  assert.equal(untouched.hp_fp, hpBefore, 'unit outside every hazard column takes no damage');
});
