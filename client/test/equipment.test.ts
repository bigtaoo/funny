// Unit tests for equipment → blueprint injection (EQUIPMENT_DESIGN §9 E1). Guards three invariants:
//   ① Ladder hard wall (L1): even with a full equipment loadout, buildPvpBlueprints() still equals UNIT_BLUEPRINTS verbatim.
//   ② Combat-power monotonicity: higher equipment → higher campaign/siege blueprint power (main affixes scale with enhancement; sub affixes are fixed).
//   ③ Cross-system cap (§7.7): multiplicative equipment contributions + absolute fields summed from all sources are clamped to EFFECT_CAPS.
import { describe, it, expect } from 'vitest';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';
import {
  buildPvpBlueprints,
  buildCampaignBlueprints,
  buildSiegeBlueprints,
} from '../src/game/balance/pveUpgrades';
import { pvpExpectedBlueprints } from './pvpBlueprintExpected';
import {
  applyEquipment,
  clampEffectCaps,
  EFFECT_CAPS,
  ENHANCE_COEFF_PER_LEVEL,
  type EngineEquipmentInput,
  type EngineAffix,
} from '../src/game/balance/equipment';

/** Single global equipment item: equip one instance with affixes into the weapon slot (applies army-wide). */
function equipOne(affixes: EngineAffix[], level = 0): EngineEquipmentInput {
  return {
    gear: { global: { weapon: 'i1' } },
    inv: { i1: { defId: 'wp_pencil', level, affixes } },
  };
}

describe('Equipment hard wall — PvP blueprints never see equipment', () => {
  it('with full equipment in memory, buildPvpBlueprints() still equals UNIT_BLUEPRINTS verbatim', () => {
    // Construct an extreme equipment set, but the PvP builder signature has no equipment parameter → cannot read it at compile time.
    void equipOne([{ id: 'm_atk', value: 999 }], 9);
    expect(buildPvpBlueprints()).toEqual(pvpExpectedBlueprints());
  });

  it('after injecting equipment into campaign, the rebuilt PvP blueprints still equal the constant (+ static §5 override; no cross-contamination, no constant mutation)', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(UNIT_BLUEPRINTS).toEqual(before);
    expect(buildPvpBlueprints()).toEqual(pvpExpectedBlueprints());
  });

  it('without equipment, campaign/siege blueprints equal upgrades-only blueprints (injection chain is a no-op for empty equipment)', () => {
    expect(buildCampaignBlueprints({})).toEqual(buildCampaignBlueprints({}, undefined));
    expect(buildSiegeBlueprints({ inf_hp: 3 })).toEqual(buildSiegeBlueprints({ inf_hp: 3 }, undefined));
  });
});

describe('Equipment combat-power monotonicity (§8)', () => {
  it('equipping one attack main affix → player unit attack > base', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }]));
    expect(camp[UnitType.Infantry].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].attack);
    expect(camp[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('campaign and siege share the same injection chain → same equipment yields same result', () => {
    const equip = equipOne([{ id: 'm_hp', value: 30 }], 2);
    expect(buildSiegeBlueprints({}, equip)).toEqual(buildCampaignBlueprints({}, equip));
  });

  it('main affix scales with enhancement level: +5 attack > +0 attack', () => {
    const lv0 = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }], 0));
    const lv5 = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }], 5));
    expect(lv5[UnitType.Infantry].attack).toBeGreaterThan(lv0[UnitType.Infantry].attack);
  });

  it('main affix scaling follows base × (1 + value/100 × (1 + coefficient×level))', () => {
    const value = 20;
    const level = 5;
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value }], level));
    const effPct = (value / 100) * (1 + ENHANCE_COEFF_PER_LEVEL * level);
    const expected = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + effPct));
    expect(camp[UnitType.Infantry].attack).toBe(expected);
  });

  it('sub affixes are fixed and do not scale with enhancement level', () => {
    const lv0 = buildCampaignBlueprints({}, equipOne([{ id: 's_atk', value: 20 }], 0));
    const lv9 = buildCampaignBlueprints({}, equipOne([{ id: 's_atk', value: 20 }], 9));
    expect(lv9[UnitType.Infantry].attack).toBe(lv0[UnitType.Infantry].attack);
  });

  it('attack-speed main affix reduces attack interval (§7.4 multiplicative interval reduction)', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atkspd', value: 20 }]));
    expect(camp[UnitType.Infantry].attackInterval).toBeLessThan(
      UNIT_BLUEPRINTS[UnitType.Infantry].attackInterval,
    );
  });
});

describe('Cross-system cap (§7.7)', () => {
  it('attack% equipment contribution clamped to EFFECT_CAPS.atkPct (sky-high affixes cannot break the cap)', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 100000 }], 9));
    const capped = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + EFFECT_CAPS.atkPct));
    expect(camp[UnitType.Infantry].attack).toBe(capped);
  });

  it('lifesteal summed from all sources clamped to EFFECT_CAPS.lifestealPct (clampEffectCaps applies a unified cross-source clamp)', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 's_lifesteal', value: 999 }]));
    expect(camp[UnitType.Infantry].lifestealPct).toBe(EFFECT_CAPS.lifestealPct);
  });

  it('clampEffectCaps clamps directly: base-provided + excess lifesteal → clamped to cap', () => {
    const bp = buildPvpBlueprints();
    bp[UnitType.Infantry].lifestealPct = 80; // simulate an over-cap value after trait + equipment sum
    clampEffectCaps(bp);
    expect(bp[UnitType.Infantry].lifestealPct).toBe(EFFECT_CAPS.lifestealPct);
  });
});

describe('Scope and error tolerance', () => {
  it('only buffs player unit types; PvE-exclusive enemy types are unaffected', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(camp[UnitType.Ironclad]).toEqual(UNIT_BLUEPRINTS[UnitType.Ironclad]);
    expect(camp[UnitType.Runner]).toEqual(UNIT_BLUEPRINTS[UnitType.Runner]);
  });

  it('unknown affix id / missing instance reference / empty loadout are all safe no-ops', () => {
    expect(buildCampaignBlueprints({}, equipOne([{ id: 'not_a_real_affix', value: 50 }]))).toEqual(
      buildCampaignBlueprints({}),
    );
    const missing: EngineEquipmentInput = { gear: { global: { weapon: 'ghost' } }, inv: {} };
    expect(buildCampaignBlueprints({}, missing)).toEqual(buildCampaignBlueprints({}));
    const empty: EngineEquipmentInput = { gear: {}, inv: {} };
    expect(buildCampaignBlueprints({}, empty)).toEqual(buildCampaignBlueprints({}));
  });

  it('utility sub-affixes (material drop / stamina) do not enter combat blueprints', () => {
    expect(buildCampaignBlueprints({}, equipOne([{ id: 's_matdrop', value: 50 }]))).toEqual(
      buildCampaignBlueprints({}),
    );
  });

  it('applyEquipment does not mutate global constants', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const bp = buildPvpBlueprints();
    applyEquipment(bp, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(UNIT_BLUEPRINTS).toEqual(before);
  });

  it('byUnit takes priority over global (phase-two per-unit override)', () => {
    const equip: EngineEquipmentInput = {
      gear: { global: { weapon: 'g' }, byUnit: { [UnitType.Archer]: { weapon: 'a' } } },
      inv: {
        g: { defId: 'wp_pencil', level: 0, affixes: [{ id: 'm_atk', value: 10 }] },
        a: { defId: 'wp_marker', level: 0, affixes: [{ id: 'm_atk', value: 50 }] },
      },
    };
    const camp = buildCampaignBlueprints({}, equip);
    // Archer uses byUnit (+50%), Infantry uses global (+10%).
    const arc = Math.round(UNIT_BLUEPRINTS[UnitType.Archer].attack * 1.5);
    const inf = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * 1.1);
    expect(camp[UnitType.Archer].attack).toBe(arc);
    expect(camp[UnitType.Infantry].attack).toBe(inf);
  });
});
