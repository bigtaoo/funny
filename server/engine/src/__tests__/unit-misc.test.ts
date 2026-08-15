/**
 * Unit.ts coverage gaps: rowExact/colExact render-only getters (never called by any
 * existing test — game logic never uses them, only rendering would), the berserker
 * attack-speed-boost branch of effectiveAttackIntervalTicks (no shipped blueprint sets
 * berserkerThreshold_fp today, same as unit_t9_traits.test.ts's approach of injecting a
 * custom blueprint override for undying/armorEnrage-style fields), and takeDamage's
 * `undying` survive-first-lethal-hit branch.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Unit, resetUnitIds } from '../Unit';
import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, Side } from '../types';
import { toFp, fromFp } from '../math/fixed';

test('Unit.rowExact / colExact return the fractional grid position (render-only getters)', () => {
  resetUnitIds();
  const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);

  assert.equal(u.rowExact, fromFp(u.y_fp));
  assert.equal(u.colExact, fromFp(u.x_fp));
  assert.equal(u.rowExact, 5);
  assert.equal(u.colExact, 3);
});

test('Unit.effectiveAttackIntervalTicks speeds up (x1.5) once HP drops below berserkerThreshold_fp', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.Infantry], berserkerThreshold_fp: toFp(0.5) };
  const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 0, bp);
  const baseInterval = u.attackIntervalTicks;

  // Full HP: berserker not active.
  assert.equal(u.effectiveAttackIntervalTicks, baseInterval, 'full HP should not trigger berserker');

  // Below the 50% threshold: berserker active, interval shortened by 2/3.
  u.hp_fp = toFp(1); // well under 50% of maxHp
  const expected = Math.max(1, Math.round(baseInterval * 2 / 3));
  assert.equal(u.effectiveAttackIntervalTicks, expected, 'below threshold should apply the berserker speed-up');
});

test('Unit.takeDamage (undying): survives a lethal hit at 1 HP once, then dies normally on the next lethal hit', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp_fp: toFp(10), armor_fp: toFp(0), undying: true };
  const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 0, bp);
  u.hp_fp = toFp(10);

  assert.equal(u.undyingTriggered, false);
  const lost = u.takeDamage(toFp(9999)); // would be lethal several times over

  assert.equal(u.hp_fp, toFp(1), 'undying clamps HP to 1 instead of 0');
  assert.equal(u.isDead, false, 'unit survives the first lethal hit');
  assert.equal(u.undyingTriggered, true, 'undying is consumed after triggering');
  assert.equal(lost, toFp(9), 'reports the actual HP lost (10 -> 1), not the raw incoming damage');

  // Second lethal hit: undying already triggered, dies normally.
  u.takeDamage(toFp(9999));
  assert.equal(u.isDead, true, 'a second lethal hit kills normally once undying is spent');
});

test('Unit.takeDamage (undying) does not clamp when the hit is not lethal', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.Infantry], armor_fp: toFp(0), undying: true };
  const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 0, bp);
  const before = u.hp_fp;

  u.takeDamage(toFp(1));

  assert.equal(u.hp_fp, before - toFp(1), 'a non-lethal hit is unaffected by undying');
  assert.equal(u.undyingTriggered, false);
});
