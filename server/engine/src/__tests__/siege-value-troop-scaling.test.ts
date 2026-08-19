/**
 * ADR-069 (2026-08-19): a pre-placed SLG siege unit's `siegeValue` scales with the troops it carries.
 *
 * Bug this closes. Base damage is a one-shot `siegeValue` hit paid when a unit reaches the enemy base,
 * after which the unit despawns (MovementSystem). A card team is at most CARD_TEAM_MAX_SIZE = 12 units,
 * so a whole team's base damage used to be a fixed Σ siegeValue (~150-190) no matter how many troops it
 * carried: every troop above a card's blueprint HP capacity was silently dead weight (`Unit`'s
 * constructor clamps `hp_fp` to the blueprint cap), and any NPC tile whose base HP exceeded that ceiling
 * was unbreakable by ANY card team at ANY troop count — while the SIEGE_CHEAP_RATIO shortcut handed the
 * same tile over for free once nominal troops hit 10× garrison. Found from account `tao`'s production
 * level-3 occupy losses (s2-0, 2026-08-19), where a re-run of the stored replay inputs ended with the
 * defender base at 0.248/120 HP.
 *
 * The scaling is deliberately: (a) normalized on the GLOBAL `SIEGE_TROOPS_PER_UNIT` = 60 quantum, so
 * per-troop siege efficiency stays proportional to the blueprint's `siegeValue` and the wall-breaker
 * ordering survives; (b) unclamped in both directions; (c) attacker-side (`Side.Bottom`) only, since the
 * attacker's own base is just a battle terminator; (d) confined to units constructed with an explicit
 * `initialHp`, i.e. the SLG pre-placed paths — PvP and the wave-driven campaign must stay bit-for-bit.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Unit } from '../Unit';
import { SIEGE_TROOPS_PER_UNIT, UNIT_BLUEPRINTS, ATTACK_LANES } from '../config';
import { fromFp } from '../math/fixed';
import { Side, UnitType } from '../types';

const COL = ATTACK_LANES[0]!;
const infantry = UNIT_BLUEPRINTS[UnitType.Infantry];
const shieldbearer = UNIT_BLUEPRINTS[UnitType.ShieldBearer];

const attacker = (unitType: UnitType, troops?: number) =>
  new Unit(unitType, Side.Bottom, COL, 3, UNIT_BLUEPRINTS[unitType], troops);

test('ADR-069: a unit carrying exactly SIEGE_TROOPS_PER_UNIT troops deals its nominal siege value', () => {
  const u = attacker(UnitType.Infantry, SIEGE_TROOPS_PER_UNIT);
  assert.equal(u.siegeValue_fp, infantry.siegeValue_fp,
    'the 60-troop reference load must reproduce the blueprint value exactly');
});

test('ADR-069: siege value grows linearly with troops, unclamped past the HP capacity', () => {
  // 4× the reference load. Infantry HP capacity is 60, so hp is clamped — siege value must NOT be.
  const u = attacker(UnitType.Infantry, SIEGE_TROOPS_PER_UNIT * 4);
  assert.equal(fromFp(u.hp_fp), fromFp(infantry.hp_fp), 'hp is still clamped to the blueprint capacity');
  assert.equal(fromFp(u.siegeValue_fp), fromFp(infantry.siegeValue_fp) * 4,
    'siege value must scale with the troops actually carried, not with the clamped hp');
});

test('ADR-069: an under-filled card deals proportionally LESS, not a full-strength hit', () => {
  const u = attacker(UnitType.Infantry, SIEGE_TROOPS_PER_UNIT / 4);
  assert.equal(fromFp(u.siegeValue_fp), fromFp(infantry.siegeValue_fp) / 4,
    'a quarter-loaded card must deal a quarter of the base damage');
});

test('ADR-069: per-troop siege efficiency keeps the blueprint ordering (shieldbearer > infantry)', () => {
  // The regression this guards: normalizing on each unit type's OWN hp capacity instead of the global
  // quantum would invert the wall-breaker identity, because shieldbearer is an HP tank (240 vs 60) —
  // it would end up with ~4× WORSE per-troop siege value than infantry despite a higher blueprint value.
  const troops = 600;
  const inf = attacker(UnitType.Infantry, troops);
  const shield = attacker(UnitType.ShieldBearer, troops);
  assert.ok(shieldbearer.siegeValue_fp > infantry.siegeValue_fp, 'sanity: blueprint ordering');
  assert.ok(shield.siegeValue_fp > inf.siegeValue_fp,
    'at equal troops the higher-siegeValue unit type must still hit the base harder');
});

test('ADR-069: the defending (Top) side is NOT scaled — its base hit stays the flat blueprint value', () => {
  // A stationed defender card can hold hundreds of troops; scaling its leak damage would let two leaks
  // delete the attacker's 100-HP terminator base regardless of how the fight actually went.
  const defender = new Unit(UnitType.ShieldBearer, Side.Top, COL, 15, shieldbearer, 600);
  assert.equal(defender.siegeValue_fp, shieldbearer.siegeValue_fp,
    'garrison / defender units must keep the unscaled blueprint siege value');
});

test('ADR-069: units built without initialHp (PvP / campaign waves) are untouched', () => {
  for (const ut of [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer, UnitType.Mara]) {
    assert.equal(attacker(ut).siegeValue_fp, UNIT_BLUEPRINTS[ut].siegeValue_fp, `${ut} must keep its blueprint siege value`);
  }
});

test('ADR-069: scaling reads the injected blueprint, so card level / gear still multiply on top', () => {
  // Mirrors what buildSiegeBlueprints hands preplaced.ts: a buffed table. The scaling must apply to the
  // BUFFED siege value (progression is multiplicative with troop load), not silently fall back to baseline.
  const buffed = { ...infantry, siegeValue_fp: (infantry.siegeValue_fp * 2) as typeof infantry.siegeValue_fp };
  const u = new Unit(UnitType.Infantry, Side.Bottom, COL, 3, buffed, SIEGE_TROOPS_PER_UNIT * 3);
  assert.equal(fromFp(u.siegeValue_fp), fromFp(infantry.siegeValue_fp) * 2 * 3,
    'buffed blueprint value × troop multiple');
});
