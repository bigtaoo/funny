/**
 * `balance/equipment.ts` — the affix → blueprint injection table, driven one AFFIX KIND at a time.
 *
 * `equip_crit.test.ts` already covers the crit pair (m_crit / s_critmult) and the enhancement
 * multiplier table end to end. What had never been driven is the rest of `accumInstance`'s
 * switch — `mult_siege`, `mult_atkspd`, `mult_spd`, `flat_armor`, `flat_lifesteal`, `flat_regen`,
 * `noncombat` — plus `applyEquipment`'s four "silently ignore" guards (empty slot, dangling
 * instance id, nothing worn, unknown unit type) and the `?? base` fallbacks on the four absolute
 * fields. That is 23 uncovered branches, the second-largest cluster in the engine.
 *
 * Why the switch arms are worth pinning individually rather than "one item with every affix":
 * every arm targets a DIFFERENT blueprint field, and an arm wired to the wrong field is invisible
 * in aggregate (the item still makes the unit stronger, just not in the way the item says). Two
 * of them are also the only places the fp domain is left on purpose — `mult_atkspd` and `mult_spd`
 * unscale back to plain decimals because `attackInterval`/`speed` are outside ADR-065 — so a
 * copy-paste that leaves them in fp would silently apply a 1000× speed bonus.
 *
 * Everything asserts against the field's own pre-call value computed with the same fp helpers the
 * source uses, so a future re-tune of ENHANCE_LEVEL_MULTIPLIER or EFFECT_CAPS moves the source and
 * the expectation together instead of leaving a hand-copied literal behind.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AFFIX_FIELD_MAP,
  EFFECT_CAPS,
  applyEquipment,
  clampEffectCaps,
  enhanceMultiplier,
  type EngineCardInstance,
  type EngineEquipInv,
} from '../balance/equipment';
import { buildCampaignBlueprints, buildPvpBlueprints } from '../balance/pveUpgrades';
import { TRAIT_BREAKPOINTS } from '../balance/progression';
import { addFp, clampFp, divFpByInt, fromFp, mulFp, toFp, type Fp } from '../math/fixed';
import { UnitType, type UnitBlueprint } from '../types';

/** A clean L1 blueprint table (no levels, no gear) — `applyEquipment`'s documented input state. */
function table(): Record<UnitType, UnitBlueprint> {
  return buildPvpBlueprints();
}

/** One card of `unitType` wearing `slots`. */
function card(unitType: UnitType, slots: Record<string, string | undefined>): EngineCardInstance {
  return { id: `c_${unitType}`, defId: unitType, unitType, level: 1, gear: slots };
}

/** One equipment instance at enhancement `level` carrying exactly one affix. */
function item(id: string, value: number, level = 0): EngineEquipInv {
  return { eq1: { defId: 'test_item', level, affixes: [{ id, value }] } };
}

/** The fp value one affix contributes after enhancement scaling (mirrors accumInstance). */
function effective(affixId: string, value: number, level = 0): Fp {
  const def = AFFIX_FIELD_MAP[affixId]!;
  return def.main ? mulFp(toFp(value), enhanceMultiplier(level)) : toFp(value);
}

/** Apply one single-affix item to `unitType` and return (before, after) for that unit. */
function inject(
  affixId: string,
  value: number,
  level = 0,
  unitType: UnitType = UnitType.Infantry,
): { before: UnitBlueprint; after: UnitBlueprint } {
  const bp = table();
  const before = { ...bp[unitType] };
  applyEquipment(bp, card(unitType, { weapon: 'eq1' }), item(affixId, value, level));
  return { before, after: bp[unitType] };
}

// ── The multiplicative arms (fp domain, clamped at the equipment contribution) ──────────────

test('mult_atk scales attack_fp by 1 + value/100, and s_atk does it without enhancement scaling', () => {
  const main = inject('m_atk', 20, 3);
  const pct = divFpByInt(effective('m_atk', 20, 3), 100);
  assert.equal(main.after.attack_fp, mulFp(main.before.attack_fp, addFp(toFp(1), pct)));
  assert.ok(main.after.attack_fp > main.before.attack_fp);

  // s_atk is a secondary affix: `main` is absent, so the enhancement level must NOT scale it.
  const sub = inject('s_atk', 20, 9);
  assert.equal(
    sub.after.attack_fp,
    mulFp(sub.before.attack_fp, addFp(toFp(1), divFpByInt(toFp(20), 100))),
    'a secondary affix ignores the +9 enhancement level',
  );
});

test('mult_siege scales siegeValue_fp on its own gear channel and leaves attack alone', () => {
  const { before, after } = inject('m_siege', 30);
  const pct = divFpByInt(effective('m_siege', 30), 100);
  assert.equal(after.siegeValue_fp, mulFp(before.siegeValue_fp, addFp(toFp(1), pct)));
  assert.equal(after.attack_fp, before.attack_fp, 'the siege channel must not leak into attack');

  const sub = inject('s_siege', 10);
  assert.equal(sub.after.siegeValue_fp, mulFp(sub.before.siegeValue_fp, addFp(toFp(1), divFpByInt(toFp(10), 100))));
});

test('mult_hp scales hp_fp only', () => {
  const { before, after } = inject('m_hp', 25);
  const pct = divFpByInt(effective('m_hp', 25), 100);
  assert.equal(after.hp_fp, mulFp(before.hp_fp, addFp(toFp(1), pct)));
  assert.equal(after.attack_fp, before.attack_fp);

  const sub = inject('s_hp', 5);
  assert.equal(sub.after.hp_fp, mulFp(sub.before.hp_fp, addFp(toFp(1), divFpByInt(toFp(5), 100))));
});

test('the three percentage caps clamp the equipment contribution, not the base value', () => {
  const capped = (affixId: string) => {
    const bp = table();
    const before = { ...bp[UnitType.Infantry] };
    applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq1' }), item(affixId, 999));
    return { before, after: bp[UnitType.Infantry] };
  };
  const atk = capped('m_atk');
  assert.equal(atk.after.attack_fp, mulFp(atk.before.attack_fp, addFp(toFp(1), EFFECT_CAPS.atkPct_fp)));
  const siege = capped('m_siege');
  assert.equal(
    siege.after.siegeValue_fp,
    mulFp(siege.before.siegeValue_fp, addFp(toFp(1), EFFECT_CAPS.siegePct_fp)),
  );
  const hp = capped('m_hp');
  assert.equal(hp.after.hp_fp, mulFp(hp.before.hp_fp, addFp(toFp(1), EFFECT_CAPS.hpPct_fp)));
});

// ── The two arms that deliberately LEAVE the fp domain ──────────────────────────────────────

test('mult_atkspd divides attackInterval by 1 + pct as a PLAIN decimal (attackInterval is not fp)', () => {
  const { before, after } = inject('m_atkspd', 20);
  const pct = fromFp(effective('m_atkspd', 20)) / 100; // 0.2 — plain, not 200
  assert.equal(after.attackInterval, before.attackInterval / (1 + pct));
  assert.ok(after.attackInterval < before.attackInterval, 'more attack speed = shorter interval');
  // The unscaling is the whole point: leaving it in fp would divide by 201 instead of 1.2.
  assert.ok(after.attackInterval > before.attackInterval / 2, 'a 20% bonus must not halve the interval');

  const sub = inject('s_atkspd', 10);
  assert.equal(sub.after.attackInterval, sub.before.attackInterval / 1.1);
});

test('mult_atkspd is capped, and a 0 contribution leaves attackInterval untouched', () => {
  const { before, after } = inject('m_atkspd', 999);
  assert.equal(after.attackInterval, before.attackInterval / (1 + EFFECT_CAPS.atkspdPct));
  // An affix that contributes nothing must not even touch the field (the `atkspd > 0` guard).
  const zero = inject('m_atkspd', 0);
  assert.equal(zero.after.attackInterval, zero.before.attackInterval);

  // A NEGATIVE roll floors at 0 rather than lengthening the interval. `clamp`'s lower bound is
  // the only thing between a dirty/hostile save and `attackInterval / (1 + -2)` = a negative
  // interval, which downstream reads as "attacks every frame, forever".
  const negative = inject('m_atkspd', -200);
  assert.equal(negative.after.attackInterval, negative.before.attackInterval);
  assert.ok(negative.after.attackInterval > 0);
});

test('mult_spd multiplies speed as a plain decimal and has NO cap (per §7.7)', () => {
  const { before, after } = inject('m_spd', 15);
  const pct = fromFp(effective('m_spd', 15)) / 100;
  assert.equal(after.speed, before.speed * (1 + pct));

  // Uncapped: an absurd roll scales all the way through, unlike atk/hp/atkspd.
  const huge = inject('m_spd', 999);
  assert.equal(huge.after.speed, huge.before.speed * (1 + fromFp(effective('m_spd', 999)) / 100));

  const sub = inject('s_spd', 10);
  assert.equal(sub.after.speed, sub.before.speed * 1.1);
  // ...and a 0 contribution leaves speed alone (the `spdPct !== 0` guard).
  const zero = inject('m_spd', 0);
  assert.equal(zero.after.speed, zero.before.speed);
});

// ── The absolute arms, including the `?? base` fallback on both sides ────────────────────────

test('flat_armor adds to armor_fp, starting from 0 on a unit with no base armor', () => {
  const { before, after } = inject('m_armor', 4);
  assert.equal(before.armor_fp, undefined, 'Infantry has no base armor — the ?? 0 fallback arm');
  assert.equal(after.armor_fp, effective('m_armor', 4));

  // ...and adds ON TOP of an existing base armor rather than replacing it (Lena has armor 2).
  const lena = inject('m_armor', 4, 0, UnitType.Lena);
  assert.ok(lena.before.armor_fp !== undefined && lena.before.armor_fp > 0);
  assert.equal(lena.after.armor_fp, addFp(lena.before.armor_fp, effective('m_armor', 4)));

  const sub = inject('s_armor', 2);
  assert.equal(sub.after.armor_fp, toFp(2));
  // A 0-value armor affix must not materialise the field at all (the `!== 0` guard).
  assert.equal(inject('m_armor', 0).after.armor_fp, undefined);
});

test('flat_lifesteal adds to lifestealPct_fp, and stacks on a second item rather than replacing', () => {
  const bp = table();
  const inv: EngineEquipInv = {
    eq1: { defId: 'i1', level: 0, affixes: [{ id: 's_lifesteal', value: 5 }] },
    eq2: { defId: 'i2', level: 0, affixes: [{ id: 's_lifesteal', value: 7 }] },
  };
  assert.equal(bp[UnitType.Infantry].lifestealPct_fp, undefined);
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq1' }), inv);
  assert.equal(bp[UnitType.Infantry].lifestealPct_fp, toFp(5), 'first item: ?? 0 fallback arm');
  // A second injection pass sees the field already set — the other arm of the same `??`.
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq2' }), inv);
  assert.equal(bp[UnitType.Infantry].lifestealPct_fp, toFp(12), 'second item: adds on top');
  assert.equal(inject('s_lifesteal', 0).after.lifestealPct_fp, undefined);
});

test('flat_lifesteal stacks with the T6 trait and the SUM is what clampEffectCaps caps', () => {
  // A level-6 card already carries the T6 lifesteal trait, so the `??` sees a defined field
  // that came from progression rather than from another item.
  const inv: EngineEquipInv = { eq1: { defId: 'i1', level: 0, affixes: [{ id: 's_lifesteal', value: 5 }] } };
  const bp = buildCampaignBlueprints(
    [{ id: 'c', defId: UnitType.Infantry, unitType: UnitType.Infantry, level: 6, gear: { weapon: 'eq1' } }],
    inv,
  );
  assert.equal(bp[UnitType.Infantry].lifestealPct_fp, addFp(TRAIT_BREAKPOINTS.lifesteal.pct, toFp(5)));

  // ...and an oversized roll clamps the all-source sum, not the equipment half.
  const big: EngineEquipInv = { eq1: { defId: 'i1', level: 0, affixes: [{ id: 's_lifesteal', value: 999 }] } };
  const bpBig = buildCampaignBlueprints(
    [{ id: 'c', defId: UnitType.Infantry, unitType: UnitType.Infantry, level: 6, gear: { weapon: 'eq1' } }],
    big,
  );
  assert.equal(bpBig[UnitType.Infantry].lifestealPct_fp, EFFECT_CAPS.lifestealPct_fp);
});

test('flat_regen adds HP/s as a PLAIN number, from 0 and then on top of itself', () => {
  const bp = table();
  const inv: EngineEquipInv = {
    eq1: { defId: 'i1', level: 0, affixes: [{ id: 's_regen', value: 3 }] },
    eq2: { defId: 'i2', level: 0, affixes: [{ id: 's_regen', value: 2 }] },
  };
  assert.equal(bp[UnitType.Infantry].regenPerSec, undefined);
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq1' }), inv);
  assert.equal(bp[UnitType.Infantry].regenPerSec, 3, 'unscaled back to HP/s, not 3000');
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq2' }), inv);
  assert.equal(bp[UnitType.Infantry].regenPerSec, 5);
  assert.equal(inject('s_regen', 0).after.regenPerSec, undefined);
});

test('s_critmult alone establishes the 1× base before adding its bonus (no m_crit present)', () => {
  // equip_crit.test.ts always pairs s_critmult with m_crit, which sets critMult_fp first; alone,
  // the `?? toFp(1)` fallback arm is what decides whether a lone s_critmult reads as 1.2× or 0.2×.
  const { before, after } = inject('s_critmult', 20);
  assert.equal(before.critMult_fp, undefined);
  assert.equal(after.critMult_fp, toFp(1.2));
  assert.equal(after.critPct_fp, undefined, 'crit DAMAGE without crit CHANCE never fires — but is still stored');
  assert.equal(inject('s_critmult', 0).after.critMult_fp, undefined);
});

// ── Affixes that must NOT reach the blueprint ───────────────────────────────────────────────

test('noncombat affixes (material drop / stamina refund) leave the blueprint byte-identical', () => {
  for (const affixId of ['s_matdrop', 's_stamina']) {
    const bp = table();
    const before = JSON.stringify(bp[UnitType.Infantry]);
    applyEquipment(bp, card(UnitType.Infantry, { trinket: 'eq1' }), item(affixId, 50));
    assert.equal(
      JSON.stringify(bp[UnitType.Infantry]),
      before,
      `${affixId} is read by pveRewards, never injected into combat stats (§7.5)`,
    );
    assert.equal(AFFIX_FIELD_MAP[affixId]!.kind, 'noncombat');
  }
});

test('an unknown affix id is silently ignored, so a newer item cannot break an older engine', () => {
  const bp = table();
  const before = JSON.stringify(bp[UnitType.Infantry]);
  applyEquipment(
    bp,
    card(UnitType.Infantry, { weapon: 'eq1' }),
    { eq1: { defId: 'i1', level: 0, affixes: [{ id: 's_from_a_future_release', value: 99 }] } },
  );
  assert.equal(JSON.stringify(bp[UnitType.Infantry]), before);
  assert.equal(AFFIX_FIELD_MAP['s_from_a_future_release'], undefined);
});

test('an item with no level and no affixes is accepted (both ?? defaults) and changes nothing', () => {
  const bp = table();
  const before = JSON.stringify(bp[UnitType.Infantry]);
  // `level` and `affixes` are REQUIRED on EngineEquipInstance, so the `inst.level ?? 0` and
  // `inst.affixes ?? []` defaults in accumInstance only ever see data the type system says
  // cannot exist — i.e. a save written by an older/newer client, which is exactly what the
  // cast below models. Without the defaults this is a `TypeError: not iterable` on load.
  const dirty = { eq1: { defId: 'i1' } } as unknown as EngineEquipInv;
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq1' }), dirty);
  assert.equal(JSON.stringify(bp[UnitType.Infantry]), before);
});

test('the enhancement level is clamped into the table at both ends before it scales anything', () => {
  // level 99 must behave exactly like +9, and a negative level exactly like +0.
  const overMax = inject('m_atk', 10, 99);
  const atMax = inject('m_atk', 10, 9);
  assert.equal(overMax.after.attack_fp, atMax.after.attack_fp);
  const negative = inject('m_atk', 10, -5);
  const atZero = inject('m_atk', 10, 0);
  assert.equal(negative.after.attack_fp, atZero.after.attack_fp);
});

// ── applyEquipment's four "silently ignore" guards ──────────────────────────────────────────

test('an empty gear slot and a dangling instance id are both skipped without throwing', () => {
  const bp = table();
  const before = JSON.stringify(bp[UnitType.Infantry]);
  const inv: EngineEquipInv = { eq1: { defId: 'i1', level: 0, affixes: [{ id: 'm_atk', value: 10 }] } };

  // `undefined` slot value → the `!instId` guard.
  applyEquipment(bp, card(UnitType.Infantry, { weapon: undefined }), inv);
  assert.equal(JSON.stringify(bp[UnitType.Infantry]), before, 'an empty slot wears nothing');

  // An id with no matching instance → the `!inst` guard (a save whose item was deleted).
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq_deleted' }), inv);
  assert.equal(JSON.stringify(bp[UnitType.Infantry]), before, 'a dangling id wears nothing');

  // ...and the same card with a real id in ANOTHER slot still gets its bonus, i.e. the guards
  // skip the bad slot rather than abandoning the whole card.
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq_deleted', armor: 'eq1' }), inv);
  assert.notEqual(JSON.stringify(bp[UnitType.Infantry]), before);
});

test('a card with no gear at all returns before touching the blueprint (worn === 0)', () => {
  const bp = table();
  const before = JSON.stringify(bp);
  applyEquipment(bp, card(UnitType.Infantry, {}), {});
  assert.equal(JSON.stringify(bp), before, 'no gear means not even a ×1 multiplication');
});

test('gear on a unit type absent from the blueprint table is silently ignored', () => {
  // The PvE-only enemy types have no cards, but a hand-edited save (or a future card whose unit
  // type this engine build does not know) must not crash the blueprint bake.
  const bp = table();
  delete (bp as Partial<Record<UnitType, UnitBlueprint>>)[UnitType.Infantry];
  applyEquipment(bp, card(UnitType.Infantry, { weapon: 'eq1' }), item('m_atk', 10));
  assert.equal(bp[UnitType.Infantry], undefined, 'nothing was resurrected into the table');
});

// ── clampEffectCaps on a table that has none of the optional fields ─────────────────────────

test('clampEffectCaps leaves a table with no absolute fields untouched', () => {
  const bp = table();
  // Infantry carries none of the four capped fields, so every `!== undefined` guard takes its
  // other arm — the pass must be a no-op rather than materialising zeros.
  const before = JSON.stringify(bp);
  clampEffectCaps(bp);
  assert.equal(JSON.stringify(bp), before);
  assert.equal(bp[UnitType.Infantry].lifestealPct_fp, undefined);
  assert.equal(bp[UnitType.Infantry].critPct_fp, undefined);
  assert.equal(bp[UnitType.Infantry].critMult_fp, undefined);
});

test('clampEffectCaps caps armor across all sources (base + progression + equipment)', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'i1', level: 9, affixes: [{ id: 'm_armor', value: 12 }] } };
  const bp = buildCampaignBlueprints(
    [
      {
        id: 'c',
        defId: UnitType.ShieldBearer,
        unitType: UnitType.ShieldBearer,
        level: 9,
        gear: { armor: 'eq1' },
      },
    ],
    inv,
  );
  assert.equal(bp[UnitType.ShieldBearer].armor_fp, EFFECT_CAPS.armorFlat_fp);
  // Sanity: the cap is doing real work here — the uncapped sum is well above it.
  assert.ok(clampFp(toFp(999), EFFECT_CAPS.armorFlat_fp) === EFFECT_CAPS.armorFlat_fp);
});
