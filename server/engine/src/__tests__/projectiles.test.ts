/**
 * Ranged-attack projectile lifecycle: spawn (fireProjectile → targetRef's three target
 * kinds), per-tick homing advance (tickProjectiles), and impact/fizzle resolution.
 * Existing tests only ever exercise Archer/ArrowTower fire-and-forget through
 * CombatSystem.tick(); this file drives fireProjectile/tickProjectiles directly so
 * every target kind (Unit/Building/EscortUnit) and every tick outcome (expired /
 * still-traveling / impact) gets its own deterministic assertion.
 *
 * Imported from '../systems/CombatSystem' (the re-export shell), not the combat/
 * projectiles submodule, so the barrel's forwarding exports get direct function-
 * coverage credit too.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { EscortUnit } from '../EscortUnit';
import type { EscortSpec } from '../campaign/LevelDefinition';
import type { ProjectilePayload } from '../Projectile';
import { fireProjectile, tickProjectiles } from '../systems/CombatSystem';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../config';
import { toFp } from '../math/fixed';
import { BuildingType, Side, UnitType } from '../types';

function basePayload(overrides: Partial<ProjectilePayload> = {}): ProjectilePayload {
  return {
    attackerId: 1,
    side: Side.Bottom,
    rawDamage: toFp(10),
    splashRadius: 0,
    piercing: false,
    lifestealPct: toFp(0),
    slowOnHit: null,
    burstOnSingle: false,
    burstOnSingleMult: toFp(2),
    markEnemies: false,
    ...overrides,
  };
}

// ── fireProjectile: targetRef's three target kinds ──────────────────────────

test('fireProjectile: targets a Unit — spawns with targetKind "unit" and emits projectile_fired', () => {
  resetUnitIds();
  const state = new GameState(1);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  fireProjectile(state, toFp(5), toFp(3), { speed: 14, kind: 'arrow' }, target, basePayload());

  assert.equal(state.projectiles.length, 1);
  assert.equal(state.projectiles[0]!.targetKind, 'unit');
  assert.equal(state.projectiles[0]!.targetId, target.id);
  assert.ok(state.events.some(e => e.type === 'projectile_fired'));
});

test('fireProjectile: targets a Building — spawns with targetKind "building"', () => {
  resetBuildingIds();
  const state = new GameState(2);
  const target = new Building(BuildingType.ArrowTower, Side.Top, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(target);

  fireProjectile(state, toFp(5), toFp(5), { speed: 14, kind: 'arrow' }, target, basePayload());

  assert.equal(state.projectiles[0]!.targetKind, 'building');
  assert.equal(state.projectiles[0]!.targetId, target.id);
});

test('fireProjectile: targets an EscortUnit — spawns with targetKind "escort" and its numeric id', () => {
  const state = new GameState(3);
  const spec: EscortSpec = { id: 'esc1', hp: 50, speed: 1, startCol: 5, startRow: 5 };
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);

  fireProjectile(state, toFp(5), toFp(3), { speed: 14, kind: 'arrow' }, escort, basePayload());

  assert.equal(state.projectiles[0]!.targetKind, 'escort');
  assert.equal(state.projectiles[0]!.targetId, escort.numericId);
});

// ── tickProjectiles: empty queue, fizzle (expired) ──────────────────────────

test('tickProjectiles: a no-op on an empty projectile list', () => {
  const state = new GameState(4);
  assert.doesNotThrow(() => tickProjectiles(state));
  assert.equal(state.projectiles.length, 0);
});

test('tickProjectiles: a projectile whose Unit target died mid-flight fizzles (projectile_expired)', () => {
  resetUnitIds();
  const state = new GameState(5);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  fireProjectile(state, toFp(0), toFp(5), { speed: 14, kind: 'arrow' }, target, basePayload());

  // Dies mid-flight (not yet swept off the board — matches the real per-tick order,
  // where tickProjectiles runs before the dead-unit sweep).
  target.hp_fp = toFp(0);

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0, 'expired projectile is dropped, not kept as a survivor');
  assert.ok(state.events.some(e => e.type === 'projectile_expired'));
  assert.ok(!state.events.some(e => e.type === 'projectile_hit'));
});

test('tickProjectiles: a projectile whose Building target was destroyed fizzles', () => {
  resetBuildingIds();
  const state = new GameState(6);
  const target = new Building(BuildingType.ArrowTower, Side.Top, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(target);
  fireProjectile(state, toFp(0), toFp(3), { speed: 14, kind: 'arrow' }, target, basePayload());

  target.hp_fp = toFp(0);

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0);
  assert.ok(state.events.some(e => e.type === 'projectile_expired'));
});

test('tickProjectiles: a projectile whose escort target stopped moving (arrived) fizzles', () => {
  const state = new GameState(7);
  const spec: EscortSpec = { id: 'esc2', hp: 50, speed: 1, startCol: 5, startRow: 5 };
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);
  fireProjectile(state, toFp(0), toFp(5), { speed: 14, kind: 'arrow' }, escort, basePayload());

  escort.status = 'arrived';

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0);
  assert.ok(state.events.some(e => e.type === 'projectile_expired'));
});

// ── tickProjectiles: still traveling vs impact ──────────────────────────────

test('tickProjectiles: a projectile still short of its target moves toward it and survives the tick', () => {
  resetUnitIds();
  const state = new GameState(8);
  const target = new Unit(UnitType.Infantry, Side.Top, 11, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  // Slow projectile, far away (11 cells) — guarantees dist > step on the first tick.
  fireProjectile(state, toFp(0), toFp(5), { speed: 1, kind: 'arrow' }, target, basePayload());
  const startX = state.projectiles[0]!.x_fp;

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 1, 'still in flight');
  assert.ok(state.projectiles[0]!.x_fp > startX, 'advanced toward the target');
  assert.ok(state.events.some(e => e.type === 'projectile_moved'));
  assert.ok(!state.events.some(e => e.type === 'unit_attack_hit'));
});

test('tickProjectiles: a projectile that reaches its Unit target resolves the frozen payload on impact', () => {
  resetUnitIds();
  const state = new GameState(9);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  // Spawned exactly at the target's position — dist is 0 on the very first tick.
  fireProjectile(state, toFp(5), toFp(5), { speed: 14, kind: 'arrow' }, target, basePayload({ rawDamage: toFp(15) }));

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0, 'the arrow is retired on impact');
  assert.equal(target.hp_fp, target.maxHp_fp - toFp(15));
  assert.ok(state.events.some(e => e.type === 'projectile_hit'));
  assert.ok(state.events.some(e => e.type === 'unit_attack_hit'));
});

test('tickProjectiles: impact against a Building target uses the building\'s (col,row) as its position', () => {
  resetBuildingIds();
  const state = new GameState(10);
  const target = new Building(BuildingType.ArrowTower, Side.Top, 7, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(target);
  fireProjectile(state, toFp(7), toFp(3), { speed: 14, kind: 'arrow' }, target, basePayload({ rawDamage: toFp(20) }));

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0);
  assert.equal(target.hp_fp, target.maxHp_fp - toFp(20));
});

test('tickProjectiles: impact against an EscortUnit target uses the escort\'s live col_fp/row_fp', () => {
  const state = new GameState(11);
  const spec: EscortSpec = { id: 'esc3', hp: 50, speed: 1, startCol: 4, startRow: 4 };
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);
  fireProjectile(state, toFp(4), toFp(4), { speed: 14, kind: 'arrow' }, escort, basePayload({ rawDamage: toFp(12) }));

  tickProjectiles(state);

  assert.equal(state.projectiles.length, 0);
  assert.equal(escort.hp_fp, toFp(50) - toFp(12));
  assert.ok(state.events.some(e => e.type === 'escort_hp_changed'));
});
