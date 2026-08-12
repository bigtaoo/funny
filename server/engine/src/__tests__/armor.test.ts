/**
 * A1 armor mechanism unit tests.
 *
 * Verifies:
 *  1. Unit.takeDamage armor=0 ⟹ behavior identical to pre-armor engine (golden-replay constraint).
 *  2. Unit.takeDamage armor>0 ⟹ flat reduction, minimum 1 per hit.
 *  3. Building.takeDamage armor=0 ⟹ backward-compatible (old behavior).
 *  4. Building.takeDamage armor>0 ⟹ flat reduction, minimum 1 per hit.
 *  5. All PvP blueprints have armor=0 (PvP fairness / golden-replay hard wall).
 *
 * ADR-065: hp/maxHp/armor are fp (scale = FP_SCALE = 1000); every literal below goes through
 * toFp() rather than a bare scaled integer, so the intent ("10 damage", not "10000 fp") stays
 * legible at the call site.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { BuildingType, Side, UnitType } from '../types';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../config';
import { buildPvpBlueprints } from '../balance/pveUpgrades';
import { toFp } from '../math/fixed';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeUnit(armor: number): Unit {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.Infantry], armor_fp: toFp(armor) };
  return new Unit(UnitType.Infantry, Side.Bottom, 0, 1, bp);
}

function makeBuilding(armor: number): Building {
  resetBuildingIds();
  const bp = { ...BUILDING_BLUEPRINTS[BuildingType.ArrowTower], armor_fp: toFp(armor) };
  return new Building(BuildingType.ArrowTower, Side.Bottom, 0, 0, bp);
}

// ── Unit armor=0 (backward-compat) ───────────────────────────────────────────

test('Unit armor=0: takeDamage returns full rawDamage when hp sufficient', () => {
  const u = makeUnit(0);
  const lost = u.takeDamage(toFp(10));
  assert.equal(lost, toFp(10));
  assert.equal(u.hp_fp, u.maxHp_fp - toFp(10));
});

test('Unit armor=0: takeDamage caps at current hp', () => {
  const u = makeUnit(0);
  u.hp_fp = toFp(5);
  const lost = u.takeDamage(toFp(10));
  assert.equal(lost, toFp(5));
  assert.equal(u.hp_fp, 0);
});

// ── Unit armor>0 ─────────────────────────────────────────────────────────────

test('Unit armor=5: reduces damage by 5', () => {
  const u = makeUnit(5);
  const lost = u.takeDamage(toFp(12));
  assert.equal(lost, toFp(7));        // max(1, 12-5) = 7
  assert.equal(u.hp_fp, u.maxHp_fp - toFp(7));
});

test('Unit armor: minimum 1 damage per hit even when damage <= armor', () => {
  const u = makeUnit(20);
  const lost = u.takeDamage(toFp(3)); // max(1, 3-20) = 1
  assert.equal(lost, toFp(1));
  assert.equal(u.hp_fp, u.maxHp_fp - toFp(1));
});

test('Unit armor: exact match (damage === armor) ⟹ 1 damage', () => {
  const u = makeUnit(8);
  const lost = u.takeDamage(toFp(8));
  assert.equal(lost, toFp(1));
});

// ── Building armor=0 (backward-compat) ───────────────────────────────────────

test('Building armor=0: takeDamage returns full rawDamage', () => {
  const b = makeBuilding(0);
  const lost = b.takeDamage(toFp(15));
  assert.equal(lost, toFp(15));
  assert.equal(b.hp_fp, b.maxHp_fp - toFp(15));
});

test('Building armor=0: takeDamage caps at current hp', () => {
  const b = makeBuilding(0);
  b.hp_fp = toFp(4);
  const lost = b.takeDamage(toFp(15));
  assert.equal(lost, toFp(4));
  assert.equal(b.hp_fp, 0);
});

// ── Building armor>0 ─────────────────────────────────────────────────────────

test('Building armor=3: reduces damage by 3', () => {
  const b = makeBuilding(3);
  const lost = b.takeDamage(toFp(12));
  assert.equal(lost, toFp(9));        // max(1, 12-3) = 9
  assert.equal(b.hp_fp, b.maxHp_fp - toFp(9));
});

test('Building armor: minimum 1 damage per hit', () => {
  const b = makeBuilding(20);
  const lost = b.takeDamage(toFp(5)); // max(1, 5-20) = 1
  assert.equal(lost, toFp(1));
});

// ── PvP hard wall: all PvP blueprints have armor=0 ───────────────────────────

test('buildPvpBlueprints: all PvP unit blueprints have armor=0', () => {
  const pvpBp = buildPvpBlueprints();
  const pvpUnits = [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer];
  for (const ut of pvpUnits) {
    const armor_fp = pvpBp[ut].armor_fp ?? toFp(0);
    assert.equal(armor_fp, 0, `PvP unit ${ut} must have armor=0, got ${armor_fp}`);
  }
});

test('BUILDING_BLUEPRINTS: all base buildings have armor=0', () => {
  for (const bt of Object.values(BuildingType)) {
    const armor_fp = BUILDING_BLUEPRINTS[bt].armor_fp ?? toFp(0);
    assert.equal(armor_fp, 0, `Building ${bt} base armor must be 0, got ${armor_fp}`);
  }
});
