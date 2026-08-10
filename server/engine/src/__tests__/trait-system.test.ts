/**
 * TraitSystem — per-tick passive effects (§4.4c). Previously zero functional coverage:
 * only client-side VFX-id string checks existed, nothing that actually ran TraitSystem.tick()
 * against a real GameState/Unit and asserted the resulting state change. This file drives the
 * real system for several ticks and checks the numbers it produces.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { TraitSystem } from '../systems/TraitSystem';
import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, Side } from '../types';
import { TICK_RATE, type Fp } from '../math/fixed';

// ── aura_heal ────────────────────────────────────────────────────────────────────────────────

test('aura_heal: a wounded ally inside the radius is healed each tick; out-of-radius allies and enemies are untouched', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  // hps=30 -> healFpPerTick = round(30 * FP_SCALE / TICK_RATE) = round(30 * 1000 / 30) = 1000,
  // exactly FP_SCALE — the accumulator crosses the threshold on every single tick, so +1 HP is
  // observable immediately without needing multiple ticks to cross FP_SCALE.
  const healer = new Unit(UnitType.Medic, Side.Bottom, 5, 5, {
    ...UNIT_BLUEPRINTS[UnitType.Medic],
    traits: [{ type: 'aura_heal', radius: 2, hps: 30 }],
  });

  const nearAlly = new Unit(UnitType.Infantry, Side.Bottom, 6, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 100 });
  nearAlly.hp = 50; // Chebyshev distance 1 from healer — inside radius 2.

  const farAlly = new Unit(UnitType.Infantry, Side.Bottom, 9, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 100 });
  farAlly.hp = 50; // distance 4 — outside radius 2.

  const enemy = new Unit(UnitType.Infantry, Side.Top, 6, 6, { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 100 });
  enemy.hp = 50; // distance 1 — inside radius, but wrong side.

  state.board.addUnit(healer);
  state.board.addUnit(nearAlly);
  state.board.addUnit(farAlly);
  state.board.addUnit(enemy);

  traitSystem.tick(state);

  assert.equal(nearAlly.hp, 51, 'ally within the aura radius should gain 1 HP this tick');
  assert.equal(farAlly.hp, 50, 'ally outside the aura radius must not be healed');
  assert.equal(enemy.hp, 50, 'an enemy unit must never be healed by a friendly aura');
});

test('aura_heal: the healer itself is not healed by its own aura', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  const healer = new Unit(UnitType.Medic, Side.Bottom, 5, 5, {
    ...UNIT_BLUEPRINTS[UnitType.Medic],
    hp: 100,
    traits: [{ type: 'aura_heal', radius: 2, hps: 30 }],
  });
  healer.hp = 50;
  state.board.addUnit(healer);

  traitSystem.tick(state);

  assert.equal(healer.hp, 50, 'aura_heal excludes the source unit itself (ally === unit guard)');
});

// ── regen drain ──────────────────────────────────────────────────────────────────────────────

test('regen: healAccFp accumulates fp per tick and converts to integer HP once it crosses FP_SCALE, with a correct modulo remainder', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  // regenPerSec=45 -> regenFpPerTick = round(45 * 1000 / 30) = 1500 (1.5x FP_SCALE per tick),
  // so each tick crosses the threshold with a non-zero, non-trivial remainder.
  const unit = new Unit(UnitType.Infantry, Side.Bottom, 3, 3, {
    ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 100, regenPerSec: 45,
  });
  unit.hp = 50;
  assert.equal(unit.regenFpPerTick, 1500, 'sanity: constructor derives fp/tick from regenPerSec');

  state.board.addUnit(unit);

  traitSystem.tick(state); // healAccFp: 0 + 1500 = 1500 -> +1 HP, remainder 500
  const healAccAfterTick1 = unit.healAccFp;
  const hpAfterTick1 = unit.hp;
  assert.equal(healAccAfterTick1, 500);
  assert.equal(hpAfterTick1, 51);

  traitSystem.tick(state); // healAccFp: 500 + 1500 = 2000 -> +2 HP, remainder 0
  const healAccAfterTick2 = unit.healAccFp;
  const hpAfterTick2 = unit.hp;
  assert.equal(healAccAfterTick2, 0);
  assert.equal(hpAfterTick2, 53);

  traitSystem.tick(state); // healAccFp: 0 + 1500 = 1500 -> +1 HP, remainder 500 (cycle repeats)
  const healAccAfterTick3 = unit.healAccFp;
  const hpAfterTick3 = unit.hp;
  assert.equal(healAccAfterTick3, 500);
  assert.equal(hpAfterTick3, 54);
});

test('regen: healing never pushes hp above maxHp', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 3, 3, {
    ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 100, regenPerSec: 45,
  });
  unit.hp = 100; // already full
  state.board.addUnit(unit);

  traitSystem.tick(state);
  traitSystem.tick(state);

  assert.equal(unit.hp, 100, 'hp must be clamped at maxHp even while healAccFp keeps accumulating');
});

// ── slow expiry ──────────────────────────────────────────────────────────────────────────────

test('slow expiry: slowRemainingTicks counts down to 0, then resetSpeed() restores baseSpeed_fp', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 2, 2, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(unit);

  const baseSpeed = unit.baseSpeed_fp;
  unit.speed_fp = Math.round(baseSpeed * 0.5) as Fp; // simulate an already-applied slow
  unit.slowRemainingTicks = 2;

  traitSystem.tick(state); // 2 -> 1, not expired yet
  const slowTicksAfterTick1 = unit.slowRemainingTicks;
  assert.equal(slowTicksAfterTick1, 1);
  assert.notEqual(unit.speed_fp, baseSpeed, 'speed should still be reduced before the debuff expires');

  traitSystem.tick(state); // 1 -> 0, resetSpeed() fires on this tick
  const slowTicksAfterTick2 = unit.slowRemainingTicks;
  assert.equal(slowTicksAfterTick2, 0);
  assert.equal(unit.speed_fp, baseSpeed, 'resetSpeed() should restore baseSpeed_fp exactly on expiry');

  traitSystem.tick(state); // already 0 -> stays 0, no further mutation
  const slowTicksAfterTick3 = unit.slowRemainingTicks;
  assert.equal(slowTicksAfterTick3, 0);
  assert.equal(unit.speed_fp, baseSpeed);
});

// ── markedTicks expiry ───────────────────────────────────────────────────────────────────────

test('markedTicks counts down to 0 and never goes negative once expired', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 1, 1, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(unit);
  unit.markedTicks = 2;

  traitSystem.tick(state);
  const markedTicksAfterTick1 = unit.markedTicks;
  assert.equal(markedTicksAfterTick1, 1);

  traitSystem.tick(state);
  const markedTicksAfterTick2 = unit.markedTicks;
  assert.equal(markedTicksAfterTick2, 0);

  traitSystem.tick(state);
  const markedTicksAfterTick3 = unit.markedTicks;
  assert.equal(markedTicksAfterTick3, 0, 'markedTicks must not decrement past 0');
});

// ── summonOnTimer ────────────────────────────────────────────────────────────────────────────

test('summonOnTimer: spawns a unit at the summoner\'s position when the cooldown hits 0, pushes both events, resets the cooldown, and bumps unitsSent', () => {
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();

  // intervalSec chosen so intervalTicks = round(intervalSec * TICK_RATE) = 2.
  const summoner = new Unit(UnitType.Infantry, Side.Bottom, 4, 4, {
    ...UNIT_BLUEPRINTS[UnitType.Infantry],
    summonOnTimer: { type: UnitType.Runner, intervalSec: 2 / TICK_RATE },
  });
  state.board.addUnit(summoner);

  const intervalTicks = summoner.summonOnTimer?.intervalTicks;
  assert.equal(intervalTicks, 2);
  const cooldownAtStart = summoner.summonCooldownTicks;
  assert.equal(cooldownAtStart, 2);

  const unitsBefore = state.board.units.size;

  traitSystem.tick(state); // 2 -> 1, no spawn yet
  const cooldownAfterTick1 = summoner.summonCooldownTicks;
  const eventsAfterTick1 = state.events.length;
  assert.equal(cooldownAfterTick1, 1);
  assert.equal(state.board.units.size, unitsBefore, 'no spawn before the countdown reaches 0');
  assert.equal(eventsAfterTick1, 0);

  traitSystem.tick(state); // 1 -> 0 -> spawnSummon() fires, cooldown resets
  const cooldownAfterTick2 = summoner.summonCooldownTicks;
  assert.equal(cooldownAfterTick2, 2, 'cooldown should reset to intervalTicks after firing');
  assert.equal(state.board.units.size, unitsBefore + 1, 'a new unit should be added to the board');

  const spawned = [...state.board.units.values()].find((u) => u.id !== summoner.id);
  assert.ok(spawned, 'the spawned unit should be findable on the board');
  assert.equal(spawned!.unitType, UnitType.Runner);
  assert.equal(spawned!.side, summoner.side);
  assert.equal(spawned!.col, summoner.col, 'spawned unit appears at the summoner\'s column');
  assert.equal(spawned!.row, summoner.row, 'spawned unit appears at the summoner\'s row');

  assert.equal(state.stats[state.ownerOf(summoner.side)].unitsSent, 1);

  assert.equal(state.events.length, 2, 'unit_spawned + unit_move_start');
  assert.equal(state.events[0]!.type, 'unit_spawned');
  assert.equal((state.events[0] as { unitId: number }).unitId, spawned!.id);
  assert.equal(state.events[1]!.type, 'unit_move_start');
  assert.equal((state.events[1] as { unitId: number }).unitId, spawned!.id);
});
