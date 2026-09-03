/**
 * `blueprintDefs.ts`'s two bake functions — the real-unit → fp-scaled conversion (ADR-065) that
 * runs once per table entry at module load.
 *
 * They were at 59% branch coverage for a structural reason, not a missing test: each optional
 * stat is a `field !== undefined ? toFp(field) : undefined` ternary, and which side runs is
 * decided entirely by which optional fields today's `RAW_UNIT_BLUEPRINTS` sets. Eight of them
 * — armorEnrageBonus, armorEnrageThreshold, reflectPct, critPct, critMult, lifestealPct,
 * burstOnSingleMult, slowOnHit — are set by NO unit, and `armor` by no building, so the
 * fp-scaling half of each had no reachable caller. The functions are now exported as a test
 * seam (see their doc comments) so a raw entry can be baked directly.
 *
 * Why these arms are worth reaching rather than writing off as "not used yet": every one of the
 * eight fields IS consumed at runtime (TraitSystem's enrage/reflect/burst, CombatSystem's crit
 * and lifesteal, MovementSystem's slow), and adding one to a raw entry is exactly how a designer
 * turns it on. The failure mode is silent: the renamed `*_fp` fields are excluded from `...rest`,
 * so a field dropped from the destructuring — or scaled with the wrong helper — ships a unit
 * whose new stat is simply absent. Nothing throws, no golden replay changes (no unit has the
 * field), and every other suite stays green.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  bakeBuildingBlueprint,
  bakeUnitBlueprint,
  type RawBuildingBlueprint,
  type RawUnitBlueprint,
} from '../blueprintDefs';
import { BUILDING_BLUEPRINTS, UNIT_BLUEPRINTS } from '../config';
import { fromFp, toFp } from '../math/fixed';
import { BuildingType, UnitType } from '../types';

/** A minimal valid raw unit entry: the three mandatory stats plus the non-scaled essentials. */
function rawUnit(extra: Partial<RawUnitBlueprint> = {}): RawUnitBlueprint {
  return {
    type: UnitType.Infantry,
    hp: 100,
    attack: 20,
    siegeValue: 10,
    attackInterval: 1.5,
    speed: 1,
    range: 1,
    spawnCount: 1,
    radius_fp: 400,
    ...extra,
  } as RawUnitBlueprint;
}

test('bakeUnitBlueprint scales the three mandatory stats and leaves plain fields verbatim', () => {
  const baked = bakeUnitBlueprint(rawUnit());
  assert.equal(baked.hp_fp, toFp(100));
  assert.equal(baked.attack_fp, toFp(20));
  assert.equal(baked.siegeValue_fp, toFp(10));
  // attackInterval / speed / range / spawnCount are outside ADR-065's fp scope — they must come
  // through `...rest` unchanged, not scaled.
  assert.equal(baked.attackInterval, 1.5);
  assert.equal(baked.speed, 1);
  assert.equal(baked.range, 1);
  assert.equal(baked.type, UnitType.Infantry);
  // And the real-unit source names must NOT survive alongside the fp ones.
  assert.equal((baked as unknown as Record<string, unknown>).hp, undefined);
  assert.equal((baked as unknown as Record<string, unknown>).attack, undefined);
  assert.equal((baked as unknown as Record<string, unknown>).siegeValue, undefined);
});

test('every optional unit stat is undefined when absent', () => {
  const baked = bakeUnitBlueprint(rawUnit());
  for (const field of [
    'armor_fp',
    'armorEnrageBonus_fp',
    'berserkerThreshold_fp',
    'armorEnrageThreshold_fp',
    'reflectPct_fp',
    'critPct_fp',
    'critMult_fp',
    'lifestealPct_fp',
    'burstOnSingleMult_fp',
    'slowOnHit',
  ] as const) {
    assert.equal(baked[field], undefined, `${field} must stay absent, not become toFp(undefined)`);
  }
});

test('every optional unit stat is fp-scaled when present, under its renamed key', () => {
  const baked = bakeUnitBlueprint(
    rawUnit({
      armor: 3,
      armorEnrageBonus: 2,
      berserkerThreshold: 0.4,
      armorEnrageThreshold: 0.5,
      reflectPct: 25,
      critPct: 10,
      critMult: 1.5,
      lifestealPct: 15,
      burstOnSingleMult: 2,
    }),
  );
  assert.equal(baked.armor_fp, toFp(3));
  assert.equal(baked.armorEnrageBonus_fp, toFp(2));
  assert.equal(baked.berserkerThreshold_fp, toFp(0.4));
  assert.equal(baked.armorEnrageThreshold_fp, toFp(0.5));
  assert.equal(baked.reflectPct_fp, toFp(25));
  assert.equal(baked.critPct_fp, toFp(10));
  assert.equal(baked.critMult_fp, toFp(1.5));
  assert.equal(baked.lifestealPct_fp, toFp(15));
  assert.equal(baked.burstOnSingleMult_fp, toFp(2));

  // The raw names must be gone in every case, or the blueprint would carry both a real-unit and
  // an fp copy of the same stat and the consumers would disagree about which is authoritative.
  const asRecord = baked as unknown as Record<string, unknown>;
  for (const raw of [
    'armor',
    'armorEnrageBonus',
    'berserkerThreshold',
    'armorEnrageThreshold',
    'reflectPct',
    'critPct',
    'critMult',
    'lifestealPct',
    'burstOnSingleMult',
  ]) {
    assert.equal(asRecord[raw], undefined, `${raw} must not survive next to its _fp form`);
  }
});

test('slowOnHit scales only its multiplier and keeps durationSec in seconds', () => {
  // The one optional field that is an OBJECT rather than a scalar: the mult crosses into fp,
  // the duration deliberately does not (it is converted to ticks downstream).
  const baked = bakeUnitBlueprint(rawUnit({ slowOnHit: { mult: 0.6, durationSec: 2 } }));
  assert.deepEqual(baked.slowOnHit, { mult_fp: toFp(0.6), durationSec: 2 });

  // A falsy-but-present shape would be a designer typo; the guard is truthiness, so `undefined`
  // is the only "absent" and an object always converts.
  assert.equal(bakeUnitBlueprint(rawUnit({ slowOnHit: undefined })).slowOnHit, undefined);
});

test('a 0 value is scaled, not treated as absent (the guard is !== undefined, not truthiness)', () => {
  // This is the distinction that decides whether "armor 0" means "no armor field" (so a later
  // additive bonus starts from the blueprint default) or "explicitly zero armor". The source
  // says the latter, and `armor_fp: 0` is falsy, so a truthiness guard would silently flip it.
  const baked = bakeUnitBlueprint(rawUnit({ armor: 0, critPct: 0 }));
  assert.equal(baked.armor_fp, toFp(0));
  assert.equal(baked.critPct_fp, toFp(0));
  assert.notEqual(baked.armor_fp, undefined);
});

test('bakeBuildingBlueprint scales hp always, and attack / armor only when present', () => {
  const base: RawBuildingBlueprint = {
    type: BuildingType.Barracks,
    hp: 200,
    spawnUnit: UnitType.Infantry,
    spawnInterval: 6,
  } as RawBuildingBlueprint;

  const spawner = bakeBuildingBlueprint(base);
  assert.equal(spawner.hp_fp, toFp(200));
  assert.equal(spawner.attack_fp, undefined, 'a barracks has no attack');
  assert.equal(spawner.armor_fp, undefined, 'no building in the table sets armor');

  const armed = bakeBuildingBlueprint({ ...base, attack: 15, armor: 4 } as RawBuildingBlueprint);
  assert.equal(armed.attack_fp, toFp(15));
  assert.equal(armed.armor_fp, toFp(4));
  const asRecord = armed as unknown as Record<string, unknown>;
  assert.equal(asRecord.hp, undefined);
  assert.equal(asRecord.attack, undefined);
  assert.equal(asRecord.armor, undefined);
});

test('the shipped tables agree with a fresh bake of the same numbers', () => {
  // Ties the seam back to the real product: if the exported function ever diverged from the one
  // the module actually uses at load, these would disagree.
  const infantry = UNIT_BLUEPRINTS[UnitType.Infantry];
  assert.equal(infantry.hp_fp, bakeUnitBlueprint(rawUnit({ hp: fromFp(infantry.hp_fp) })).hp_fp);
  assert.equal(BUILDING_BLUEPRINTS[BuildingType.ArrowTower].attack_fp, toFp(15));
  assert.equal(BUILDING_BLUEPRINTS[BuildingType.Barracks].attack_fp, undefined);
  assert.equal(BUILDING_BLUEPRINTS[BuildingType.ArrowTower].armor_fp, undefined);
});
