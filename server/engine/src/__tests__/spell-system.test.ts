/**
 * SpellSystem — cast (Haste/Meteor/Rockslide/BridgeCollapse) and per-tick spell expiry.
 * Previously only 57.60% line / 42.86% function coverage: castHaste, the tail of
 * castMeteor (building damage + stats/event), castRockslide, castBridgeCollapse, and
 * tick()/expireSpell were all untested. This file drives the real system against a real
 * GameState/Board/Unit/Building and asserts the resulting state + event changes.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { SpellSystem } from '../systems/SpellSystem';
import {
  HASTE_DURATION_TICKS, HASTE_SPEED_MULT, ROCKSLIDE_DAMAGE,
  BRIDGE_COLLAPSE_DURATION_TICKS,
} from '../config';
import { fp, scaleFp, toFp } from '../math/fixed';
import { BuildingType, Side, SpellType, UnitType } from '../types';
import type { ActiveSpell } from '../types';

// ── castHaste ────────────────────────────────────────────────────────────────────────────────

test('castHaste: boosts every friendly unit\'s speed, leaves enemies untouched, records the spell + event + cast stat', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const ally1 = new Unit(UnitType.Infantry, Side.Bottom, 2, 2);
  const ally2 = new Unit(UnitType.Infantry, Side.Bottom, 3, 3);
  const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 4);
  const enemyBaseSpeed = enemy.baseSpeed_fp;
  state.board.addUnit(ally1);
  state.board.addUnit(ally2);
  state.board.addUnit(enemy);

  system.castHaste(Side.Bottom, state);

  assert.equal(ally1.speed_fp, scaleFp(HASTE_SPEED_MULT, ally1.baseSpeed_fp));
  assert.equal(ally2.speed_fp, scaleFp(HASTE_SPEED_MULT, ally2.baseSpeed_fp));
  assert.equal(enemy.speed_fp, enemyBaseSpeed, 'Haste must never affect the enemy side');

  assert.equal(state.activeSpells.length, 1);
  assert.equal(state.activeSpells[0]!.spellType, SpellType.Haste);
  assert.equal(state.activeSpells[0]!.side, Side.Bottom);
  assert.equal(state.activeSpells[0]!.remainingTicks, HASTE_DURATION_TICKS);

  assert.equal(state.stats[state.ownerOf(Side.Bottom)].castsByType[SpellType.Haste], 1);

  const events = state.events.filter((e) => e.type === 'spell_cast');
  assert.equal(events.length, 1);
  const ev = events[0] as { spellType: SpellType; owner: number; center: { col: number; y_fp: number } };
  assert.equal(ev.spellType, SpellType.Haste);
  assert.equal(ev.owner, state.ownerOf(Side.Bottom));
  assert.deepEqual(ev.center, { col: 3, y_fp: fp(0) });
});

test('castHaste: casting twice for the same side does not stack — the old entry is replaced, not duplicated', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const ally = new Unit(UnitType.Infantry, Side.Bottom, 2, 2);
  state.board.addUnit(ally);

  system.castHaste(Side.Bottom, state);
  system.castHaste(Side.Bottom, state);

  assert.equal(state.activeSpells.length, 1, 'no stacking: second cast must filter out the first');
  assert.equal(state.stats[state.ownerOf(Side.Bottom)].castsByType[SpellType.Haste], 2, 'but the cast-count stat still accumulates');
});

test('castHaste: casting for both sides keeps two independent active-spell entries', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 2));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 4, 4));

  system.castHaste(Side.Bottom, state);
  system.castHaste(Side.Top, state);

  assert.equal(state.activeSpells.length, 2);
  assert.ok(state.activeSpells.some((s) => s.side === Side.Bottom));
  assert.ok(state.activeSpells.some((s) => s.side === Side.Top));
});

// ── castMeteor ───────────────────────────────────────────────────────────────────────────────

test('castMeteor: damages enemy units inside the 2x2 area, spares friendlies and units outside it, and hits enemy buildings', () => {
  resetUnitIds();
  resetBuildingIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const centerCol = 4;
  const centerRow = 4;

  const enemyInside  = new Unit(UnitType.Infantry, Side.Top, centerCol + 1, centerRow + 1);
  const friendlyInside = new Unit(UnitType.Infantry, Side.Bottom, centerCol, centerRow);
  const enemyOutside = new Unit(UnitType.Infantry, Side.Top, centerCol + 2, centerRow);
  const enemyOutsideHp = enemyOutside.maxHp_fp;
  state.board.addUnit(enemyInside);
  state.board.addUnit(friendlyInside);
  state.board.addUnit(enemyOutside);

  const enemyBuilding = new Building(BuildingType.ArrowTower, Side.Top, centerCol, centerRow);
  const friendlyBuilding = new Building(BuildingType.ArrowTower, Side.Bottom, centerCol + 1, centerRow);
  const deadEnemyBuilding = new Building(BuildingType.ArrowTower, Side.Top, centerCol + 1, centerRow + 1);
  deadEnemyBuilding.hp_fp = toFp(0);
  state.board.addBuilding(enemyBuilding);
  state.board.addBuilding(friendlyBuilding);
  state.board.addBuilding(deadEnemyBuilding);

  system.castMeteor(Side.Bottom, centerCol, centerRow, state);

  assert.equal(enemyInside.hp_fp, 0, 'enemy unit inside the 2x2 area must take METEOR_DAMAGE (one-shot)');
  assert.equal(friendlyInside.hp_fp, friendlyInside.maxHp_fp, 'friendly units are never hit by their own Meteor');
  assert.equal(enemyOutside.hp_fp, enemyOutsideHp, 'enemy unit outside the 2x2 area must be untouched');

  assert.ok(enemyBuilding.hp_fp < enemyBuilding.maxHp_fp, 'enemy building inside the area must take damage');
  assert.equal(friendlyBuilding.hp_fp, friendlyBuilding.maxHp_fp, 'friendly building must never be hit');
  assert.equal(deadEnemyBuilding.hp_fp, toFp(0), 'an already-dead building must not be damaged again');

  const owner = state.ownerOf(Side.Bottom);
  assert.equal(state.stats[owner].spellHits, 1, 'spellHits counts only the one enemy UNIT actually hit');
  assert.equal(state.stats[owner].castsByType[SpellType.Meteor], 1);

  const events = state.events.filter((e) => e.type === 'spell_cast');
  assert.equal(events.length, 1);
  const ev = events[0] as { spellType: SpellType; owner: number; center: { col: number; y_fp: number } };
  assert.equal(ev.spellType, SpellType.Meteor);
  assert.equal(ev.owner, owner);
  assert.deepEqual(ev.center, { col: centerCol, y_fp: toFp(centerRow) });
});

test('castMeteor: a dead enemy unit inside the area is skipped and does not inflate spellHits', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const centerCol = 6;
  const centerRow = 6;
  const deadEnemy = new Unit(UnitType.Infantry, Side.Top, centerCol, centerRow);
  deadEnemy.hp_fp = toFp(0);
  state.board.addUnit(deadEnemy);

  system.castMeteor(Side.Bottom, centerCol, centerRow, state);

  const owner = state.ownerOf(Side.Bottom);
  assert.equal(state.stats[owner].spellHits, 0);
});

// ── castRockslide ────────────────────────────────────────────────────────────────────────────

test('castRockslide: damages every living unit in the column regardless of side, and skips dead units', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const COL = 5;
  // ShieldBearer (240 HP) so ROCKSLIDE_DAMAGE (80) leaves a clean positive remainder to assert on,
  // instead of one-shotting an Infantry (60 HP) and clamping at 0.
  const bottomUnit = new Unit(UnitType.ShieldBearer, Side.Bottom, COL, 2);
  const topUnit = new Unit(UnitType.ShieldBearer, Side.Top, COL, 10);
  const deadUnit = new Unit(UnitType.Infantry, Side.Bottom, COL, 14);
  deadUnit.hp_fp = toFp(0);
  const otherColUnit = new Unit(UnitType.Infantry, Side.Top, COL + 1, 5);
  const otherColHp = otherColUnit.maxHp_fp;

  state.board.addUnit(bottomUnit);
  state.board.addUnit(topUnit);
  state.board.addUnit(deadUnit);
  state.board.addUnit(otherColUnit);

  system.castRockslide(Side.Bottom, COL, state);

  assert.equal(bottomUnit.hp_fp, bottomUnit.maxHp_fp - toFp(ROCKSLIDE_DAMAGE), 'friendly units in the column are damaged too');
  assert.equal(topUnit.hp_fp, topUnit.maxHp_fp - toFp(ROCKSLIDE_DAMAGE), 'enemy units in the column are damaged');
  assert.equal(deadUnit.hp_fp, toFp(0), 'dead units are skipped, not re-damaged');
  assert.equal(otherColUnit.hp_fp, otherColHp, 'units in a different column are untouched');

  const owner = state.ownerOf(Side.Bottom);
  assert.equal(state.stats[owner].spellHits, 2, 'spellHits counts the two living units actually hit');
  assert.equal(state.stats[owner].castsByType[SpellType.Rockslide], 1);

  const events = state.events.filter((e) => e.type === 'spell_cast');
  assert.equal(events.length, 1);
  const ev = events[0] as { spellType: SpellType; owner: number; center: { col: number; y_fp: number } };
  assert.equal(ev.spellType, SpellType.Rockslide);
  assert.equal(ev.owner, owner);
  assert.deepEqual(ev.center, { col: COL, y_fp: fp(0) });
});

// ── castBridgeCollapse ───────────────────────────────────────────────────────────────────────

test('castBridgeCollapse: blocks the column until currentTick + BRIDGE_COLLAPSE_DURATION_TICKS, records cast + event', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const COL = 7;
  const currentTick = 1234;
  system.castBridgeCollapse(Side.Top, COL, state, currentTick);

  assert.equal(state.tempBlockedCols.get(COL), currentTick + BRIDGE_COLLAPSE_DURATION_TICKS);

  const owner = state.ownerOf(Side.Top);
  assert.equal(state.stats[owner].castsByType[SpellType.BridgeCollapse], 1);

  const events = state.events.filter((e) => e.type === 'spell_cast');
  assert.equal(events.length, 1);
  const ev = events[0] as { spellType: SpellType; owner: number; center: { col: number; y_fp: number } };
  assert.equal(ev.spellType, SpellType.BridgeCollapse);
  assert.equal(ev.owner, owner);
  assert.deepEqual(ev.center, { col: COL, y_fp: fp(0) });
});

// ── tick() / expireSpell ─────────────────────────────────────────────────────────────────────

test('tick: decrements remainingTicks but keeps a spell active until it reaches 0', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 2));
  system.castHaste(Side.Bottom, state);

  const initialTicks = state.activeSpells[0]!.remainingTicks;
  system.tick(state);

  assert.equal(state.activeSpells.length, 1, 'spell must still be active before its countdown reaches 0');
  assert.equal(state.activeSpells[0]!.remainingTicks, initialTicks - 1);
});

test('tick: when a Haste spell expires, affected units\' speed resets via resetSpeed() and the spell is removed', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const ally = new Unit(UnitType.Infantry, Side.Bottom, 2, 2);
  const otherSideUnit = new Unit(UnitType.Infantry, Side.Top, 3, 3);
  state.board.addUnit(ally);
  state.board.addUnit(otherSideUnit);

  system.castHaste(Side.Bottom, state);
  assert.notEqual(ally.speed_fp, ally.baseSpeed_fp, 'sanity: haste actually boosted the ally');

  // Force expiry on the very next tick.
  state.activeSpells[0]!.remainingTicks = 1;
  const otherSideSpeedBefore = otherSideUnit.speed_fp;

  system.tick(state);

  assert.equal(state.activeSpells.length, 0, 'expired spell must be removed from activeSpells');
  assert.equal(ally.speed_fp, ally.baseSpeed_fp, 'resetSpeed() must restore baseSpeed_fp exactly on expiry');
  assert.equal(otherSideUnit.speed_fp, otherSideSpeedBefore, 'expireSpell must only touch units on the expiring spell\'s side');
});

test('tick: expiring a non-Haste spell type does not touch any unit\'s speed (expireSpell no-op branch)', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 2, 2);
  unit.speed_fp = toFp(0.5); // arbitrary non-base value, must survive the tick untouched
  state.board.addUnit(unit);

  // Manually inject a non-Haste ActiveSpell to exercise expireSpell's non-Haste branch —
  // castRockslide/castMeteor/castBridgeCollapse never push to activeSpells themselves.
  const fakeSpell: ActiveSpell = { spellType: SpellType.Rockslide, side: Side.Bottom, remainingTicks: 1 };
  state.activeSpells.push(fakeSpell);

  system.tick(state);

  assert.equal(state.activeSpells.length, 0, 'the fake spell still expires and is removed from the list');
  assert.equal(unit.speed_fp, toFp(0.5), 'a non-Haste spell type must not reset anyone\'s speed');
});

test('tick: multiple simultaneously-expiring spells are all removed in the same tick', () => {
  resetUnitIds();
  const state = new GameState(1);
  const system = new SpellSystem();

  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 2));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 3, 3));

  system.castHaste(Side.Bottom, state);
  system.castHaste(Side.Top, state);
  state.activeSpells[0]!.remainingTicks = 1;
  state.activeSpells[1]!.remainingTicks = 1;

  system.tick(state);

  assert.equal(state.activeSpells.length, 0, 'both spells expiring on the same tick must both be removed');
});
