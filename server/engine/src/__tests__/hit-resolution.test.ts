/**
 * Direct coverage of the shared hit-resolution pipeline (resolveAttackHit) and its two
 * callers (performUnitAttack / performBuildingAttack). Existing tests only exercise the
 * "no traits" melee happy path indirectly through CombatSystem.tick() (melee_engage,
 * ghost_untargetable, trait-system, …); this file drives every payload branch directly
 * and deterministically: crit rolls, burstOnSingle, markEnemies, the three take-damage
 * target kinds (Unit / Building / EscortUnit) and their event shapes, lifesteal, slow-
 * on-hit, reflect, splash and piercing.
 *
 * All functions are imported from '../systems/CombatSystem' (the thin re-export shell),
 * not the combat/hitResolution submodule directly, so the barrel's forwarding exports
 * get direct function-coverage credit too — CombatSystem.ts previously had only its
 * `tick()` method exercised.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { EscortUnit } from '../EscortUnit';
import type { EscortSpec } from '../campaign/LevelDefinition';
import type { ProjectilePayload } from '../Projectile';
import { performBuildingAttack, performUnitAttack, resolveAttackHit } from '../systems/CombatSystem';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../config';
import { toFp, mulFp, subFp, divFpByInt, fp, type Fp } from '../math/fixed';
import { BuildingType, Side, UnitType } from '../types';

/** A minimal, inert payload — individual tests override only the fields they exercise. */
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

// ── crit roll (performUnitAttack) ───────────────────────────────────────────

test('performUnitAttack: a guaranteed crit (critPct_fp=100) multiplies rawDamage by critMult_fp', () => {
  resetUnitIds();
  const state = new GameState(1);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 5, 5, {
    ...UNIT_BLUEPRINTS[UnitType.Infantry], critPct_fp: toFp(100), critMult_fp: toFp(2),
  });
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 6, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  state.board.addUnit(target);

  performUnitAttack(attacker, target, state, 1);

  const hit = state.events.find(e => e.type === 'unit_attack_hit') as { damage_fp: Fp } | undefined;
  assert.ok(hit, 'expected a unit_attack_hit event');
  assert.equal(hit!.damage_fp, toFp(24), 'critMult 2x on attack 12 = 24');
});

test('performUnitAttack: critPct_fp=0 never crits (plain rawDamage)', () => {
  resetUnitIds();
  const state = new GameState(2);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 6, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  state.board.addUnit(target);

  performUnitAttack(attacker, target, state, 1);

  const hit = state.events.find(e => e.type === 'unit_attack_hit') as { damage_fp: Fp } | undefined;
  assert.equal(hit!.damage_fp, toFp(12));
});

// ── performBuildingAttack: projectile vs instant branches ───────────────────

test('performBuildingAttack: a projectile-armed building (ArrowTower) fires a projectile instead of hitting instantly', () => {
  resetBuildingIds();
  const state = new GameState(3);
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addBuilding(tower);
  state.board.addUnit(target);

  performBuildingAttack(tower, target, state, 1);

  assert.equal(state.projectiles.length, 1, 'a projectile should be spawned instead of an instant hit');
  assert.ok(state.events.some(e => e.type === 'projectile_fired'));
  assert.ok(!state.events.some(e => e.type === 'unit_attack_hit'), 'no instant hit yet — resolves on impact');
});

test('performBuildingAttack: a building with no projectile hits instantly', () => {
  resetBuildingIds();
  const state = new GameState(4);
  const meleeBuildingBp = { ...BUILDING_BLUEPRINTS[BuildingType.ArrowTower], projectile: undefined };
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, meleeBuildingBp);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addBuilding(tower);
  state.board.addUnit(target);

  performBuildingAttack(tower, target, state, 1);

  assert.equal(state.projectiles.length, 0);
  assert.ok(state.events.some(e => e.type === 'unit_attack_hit'));
});

// ── burstOnSingle ────────────────────────────────────────────────────────────

test('resolveAttackHit: burstOnSingle doubles damage when exactly one live enemy remains on the target side', () => {
  resetUnitIds();
  const state = new GameState(5);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target); // the ONLY live Top unit

  const payload = basePayload({ rawDamage: toFp(10), burstOnSingle: true, burstOnSingleMult: toFp(2) });
  resolveAttackHit(state, payload, target);

  const hit = state.events.find(e => e.type === 'unit_attack_hit') as { damage_fp: Fp };
  assert.equal(hit.damage_fp, toFp(20), 'sole survivor takes double damage');
});

test('resolveAttackHit: burstOnSingle does NOT double damage when more than one enemy is alive', () => {
  resetUnitIds();
  const state = new GameState(6);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const ally   = new Unit(UnitType.Infantry, Side.Top, 6, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  state.board.addUnit(ally);

  const payload = basePayload({ rawDamage: toFp(10), burstOnSingle: true, burstOnSingleMult: toFp(2) });
  resolveAttackHit(state, payload, target);

  const hit = state.events.find(e => e.type === 'unit_attack_hit') as { damage_fp: Fp };
  assert.equal(hit.damage_fp, toFp(10), 'two live enemies ⟹ no burst bonus');
});

// ── markEnemies (bonus damage on an already-marked target + applying the mark) ──

test('resolveAttackHit: a marked target takes +25% bonus damage', () => {
  resetUnitIds();
  const state = new GameState(7);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  target.markedTicks = 45;
  state.board.addUnit(target);

  const payload = basePayload({ rawDamage: toFp(10) });
  resolveAttackHit(state, payload, target);

  const hit = state.events.find(e => e.type === 'unit_attack_hit') as { damage_fp: Fp };
  assert.equal(hit.damage_fp, toFp(12.5), '10 * 1.25 = 12.5');
});

test('resolveAttackHit: payload.markEnemies applies a 90-tick mark to a target that survives the hit', () => {
  resetUnitIds();
  const state = new GameState(8);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  assert.equal(target.markedTicks, 0);

  const payload = basePayload({ rawDamage: toFp(5), markEnemies: true });
  resolveAttackHit(state, payload, target);

  assert.equal(target.markedTicks, 90);
});

test('resolveAttackHit: payload.markEnemies does not mark a target that the hit kills', () => {
  resetUnitIds();
  const state = new GameState(9);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  const payload = basePayload({ rawDamage: target.maxHp_fp, markEnemies: true }); // lethal
  resolveAttackHit(state, payload, target);

  assert.ok(target.isDead);
  assert.equal(target.markedTicks, 0, 'a dead target is never marked');
});

// ── target kinds: EscortUnit / Building event shapes ────────────────────────

test('resolveAttackHit: an EscortUnit target takes damage and emits unit_attack_hit + escort_hp_changed', () => {
  const state = new GameState(10);
  const spec: EscortSpec = { id: 'esc1', hp: 100, speed: 1, startCol: 5, startRow: 5 };
  const escort = new EscortUnit(spec);

  const payload = basePayload({ rawDamage: toFp(30) });
  resolveAttackHit(state, payload, escort);

  assert.equal(escort.hp_fp, toFp(70));
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0]!.type, 'unit_attack_hit');
  assert.equal((state.events[0] as { targetId: number }).targetId, escort.numericId);
  assert.equal((state.events[0] as { damage_fp: Fp }).damage_fp, toFp(30));
  assert.equal(state.events[1]!.type, 'escort_hp_changed');
  assert.equal((state.events[1] as { escortId: string }).escortId, escort.id);
  assert.equal((state.events[1] as { hp_fp: Fp }).hp_fp, toFp(70));
});

test('resolveAttackHit: a surviving Building target emits unit_attack_hit + building_hp_changed', () => {
  resetBuildingIds();
  const state = new GameState(11);
  const building = new Building(BuildingType.ArrowTower, Side.Top, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(building);

  const payload = basePayload({ rawDamage: toFp(20) });
  resolveAttackHit(state, payload, building);

  assert.equal(state.events.length, 2);
  assert.equal(state.events[0]!.type, 'unit_attack_hit');
  assert.equal(state.events[1]!.type, 'building_hp_changed');
  assert.ok(!building.isDead);
});

test('resolveAttackHit: a Building target killed by the hit does NOT emit building_hp_changed', () => {
  resetBuildingIds();
  const state = new GameState(12);
  const building = new Building(BuildingType.ArrowTower, Side.Top, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(building);

  const payload = basePayload({ rawDamage: building.maxHp_fp }); // lethal
  resolveAttackHit(state, payload, building);

  assert.ok(building.isDead);
  assert.equal(state.events.length, 1, 'only unit_attack_hit — no building_hp_changed for a destroyed building');
  assert.equal(state.events[0]!.type, 'unit_attack_hit');
});

// ── lifesteal ────────────────────────────────────────────────────────────────

test('resolveAttackHit: lifesteal heals the live attacker by a % of actual damage dealt', () => {
  resetUnitIds();
  const state = new GameState(13);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 4, 4, UNIT_BLUEPRINTS[UnitType.Infantry]);
  attacker.hp_fp = toFp(30); // wounded, room to heal
  state.board.addUnit(attacker);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  const payload = basePayload({ attackerId: attacker.id, rawDamage: toFp(20), lifestealPct: toFp(50) });
  resolveAttackHit(state, payload, target);

  const expectedHeal = divFpByInt(mulFp(toFp(20), toFp(50)), 100); // 50% of 20 = 10
  assert.equal(attacker.hp_fp, toFp(30) + expectedHeal);
});

test('resolveAttackHit: lifesteal heal is clamped to maxHp_fp', () => {
  resetUnitIds();
  const state = new GameState(14);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 4, 4, UNIT_BLUEPRINTS[UnitType.Infantry]);
  attacker.hp_fp = subFp(attacker.maxHp_fp, toFp(2)); // nearly full
  state.board.addUnit(attacker);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  // heal = 100% of 20 = 20, way more than the 2 missing HP.
  const payload = basePayload({ attackerId: attacker.id, rawDamage: toFp(20), lifestealPct: toFp(100) });
  resolveAttackHit(state, payload, target);

  assert.equal(attacker.hp_fp, attacker.maxHp_fp, 'heal must not push hp above maxHp_fp');
});

test('resolveAttackHit: lifesteal is a no-op when the firing unit is no longer on the board', () => {
  resetUnitIds();
  const state = new GameState(15);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  const payload = basePayload({ attackerId: 999999, rawDamage: toFp(20), lifestealPct: toFp(50) });
  assert.doesNotThrow(() => resolveAttackHit(state, payload, target));
});

// ── slow on hit ──────────────────────────────────────────────────────────────

test('resolveAttackHit: slowOnHit reduces target speed and sets slowRemainingTicks', () => {
  resetUnitIds();
  const state = new GameState(16);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);
  const baseSpeed = target.baseSpeed_fp;

  const payload = basePayload({ rawDamage: toFp(1), slowOnHit: { mult_fp: toFp(0.5), durationTicks: 30 } });
  resolveAttackHit(state, payload, target);

  assert.equal(target.slowRemainingTicks, 30);
  assert.equal(target.speed_fp, mulFp(baseSpeed, toFp(0.5)));
});

test('resolveAttackHit: slowOnHit speed floor is 1 fp — never fully stops a unit', () => {
  resetUnitIds();
  const state = new GameState(17);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(target);

  const payload = basePayload({ rawDamage: toFp(1), slowOnHit: { mult_fp: toFp(0), durationTicks: 10 } });
  resolveAttackHit(state, payload, target);

  assert.equal(target.speed_fp, fp(1), 'mult 0 would give speed 0 — clamped to the 1fp floor');
});

// ── reflect ──────────────────────────────────────────────────────────────────

test('resolveAttackHit: reflect damages the live attacker Unit for a % of actual damage taken', () => {
  resetUnitIds();
  const state = new GameState(18);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 4, 4, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], reflectPct_fp: toFp(50) });
  state.board.addUnit(target);

  const payload = basePayload({ attackerId: attacker.id, rawDamage: toFp(20) });
  resolveAttackHit(state, payload, target);

  const expectedReflect = divFpByInt(mulFp(toFp(20), toFp(50)), 100); // 10
  assert.equal(attacker.hp_fp, attacker.maxHp_fp - expectedReflect);
});

test('resolveAttackHit: reflect damages a live attacker Building when no attacker Unit exists for that id', () => {
  resetBuildingIds();
  resetUnitIds();
  const state = new GameState(19);
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(tower);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], reflectPct_fp: toFp(50) });
  state.board.addUnit(target);

  const payload = basePayload({ attackerId: tower.id, rawDamage: toFp(20) });
  resolveAttackHit(state, payload, target);

  const expectedReflect = divFpByInt(mulFp(toFp(20), toFp(50)), 100);
  assert.equal(tower.hp_fp, tower.maxHp_fp - expectedReflect);
});

test('resolveAttackHit: reflect is skipped when the hit kills the target', () => {
  resetUnitIds();
  const state = new GameState(20);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 4, 4, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const target = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], reflectPct_fp: toFp(50) });
  state.board.addUnit(target);

  const payload = basePayload({ attackerId: attacker.id, rawDamage: target.maxHp_fp }); // lethal
  resolveAttackHit(state, payload, target);

  assert.ok(target.isDead);
  assert.equal(attacker.hp_fp, attacker.maxHp_fp, 'no reflect once the target itself is dead');
});

// ── splash ───────────────────────────────────────────────────────────────────

test('resolveAttackHit: splash damages nearby enemies within Chebyshev radius but skips allies/self/dead/out-of-range', () => {
  resetUnitIds();
  const state = new GameState(21);
  const target    = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const nearEnemy = new Unit(UnitType.Infantry, Side.Top, 6, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);    // dist 1
  const farEnemy  = new Unit(UnitType.Infantry, Side.Top, 8, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);    // dist 3
  const friendly  = new Unit(UnitType.Infantry, Side.Bottom, 6, 6, UNIT_BLUEPRINTS[UnitType.Infantry]); // dist 1, attacker's own side
  const deadEnemy = new Unit(UnitType.Infantry, Side.Top, 5, 6, UNIT_BLUEPRINTS[UnitType.Infantry]);    // dist 1
  deadEnemy.hp_fp = toFp(0);

  state.board.addUnit(target);
  state.board.addUnit(nearEnemy);
  state.board.addUnit(farEnemy);
  state.board.addUnit(friendly);
  state.board.addUnit(deadEnemy);

  const payload = basePayload({ attackerId: 1, side: Side.Bottom, rawDamage: toFp(10), splashRadius: 1 });
  resolveAttackHit(state, payload, target);

  assert.equal(nearEnemy.hp_fp, nearEnemy.maxHp_fp - toFp(10), 'within radius, enemy side — hit');
  assert.equal(farEnemy.hp_fp, farEnemy.maxHp_fp, 'outside radius — untouched');
  assert.equal(friendly.hp_fp, friendly.maxHp_fp, 'friendly side — never splashed');
  assert.equal(deadEnemy.hp_fp, toFp(0), 'already dead — skipped');

  const splashHits = state.events.filter(
    e => e.type === 'unit_attack_hit' && (e as { targetId: number }).targetId === nearEnemy.id,
  );
  assert.equal(splashHits.length, 1);
});

// ── piercing ─────────────────────────────────────────────────────────────────

test('resolveAttackHit: piercing damages every enemy in the same column but skips other columns and allies', () => {
  resetUnitIds();
  const state = new GameState(22);
  const target        = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const sameColEnemy  = new Unit(UnitType.Infantry, Side.Top, 5, 9, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const otherColEnemy = new Unit(UnitType.Infantry, Side.Top, 6, 5, UNIT_BLUEPRINTS[UnitType.Infantry]);
  const sameColAlly   = new Unit(UnitType.Infantry, Side.Bottom, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);

  state.board.addUnit(target);
  state.board.addUnit(sameColEnemy);
  state.board.addUnit(otherColEnemy);
  state.board.addUnit(sameColAlly);

  const payload = basePayload({ attackerId: 1, side: Side.Bottom, rawDamage: toFp(10), piercing: true });
  resolveAttackHit(state, payload, target);

  assert.equal(sameColEnemy.hp_fp, sameColEnemy.maxHp_fp - toFp(10), 'same column, enemy side — pierced');
  assert.equal(otherColEnemy.hp_fp, otherColEnemy.maxHp_fp, 'different column — untouched');
  assert.equal(sameColAlly.hp_fp, sameColAlly.maxHp_fp, 'same column but friendly — never pierced');
});
