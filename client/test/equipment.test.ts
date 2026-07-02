// Unit tests for equipment → blueprint injection (EQUIPMENT_DESIGN §9 E1). Guards three invariants:
//   ① Ladder hard wall (L1): even with a full equipment loadout, buildPvpBlueprints() still equals UNIT_BLUEPRINTS verbatim.
//   ② Combat-power monotonicity: higher equipment → higher campaign/siege blueprint power (main affixes scale with enhancement; sub affixes are fixed).
//   ③ Cross-system cap (§7.7): multiplicative equipment contributions + absolute fields summed from all sources are clamped to EFFECT_CAPS.
//
// CC-1: gear is now a per-card slot map (EngineCardInstance.gear) + a shared instance inventory,
// replacing the old global/byUnit GearLoadout. `equipAll` puts one item on every player card
// (the analog of the old "global" loadout); `buildCampaignBlueprints(cards, inv)` injects it.
import { describe, it, expect } from 'vitest';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';
import {
  buildPvpBlueprints,
  buildCampaignBlueprints,
  buildSiegeBlueprints,
} from '../src/game/balance/pveUpgrades';
import { PROGRESSABLE_UNITS } from '../src/game/balance/progression';
import { pvpExpectedBlueprints } from './pvpBlueprintExpected';
import {
  applyEquipment,
  clampEffectCaps,
  EFFECT_CAPS,
  ENHANCE_COEFF_PER_LEVEL,
  type EngineCardInstance,
  type EngineEquipInv,
  type EngineAffix,
} from '../src/game/balance/equipment';
import { card } from './cardHelpers';

/** Equip one item (id 'i1') in the weapon slot of every player card — the CC-1 analog of the old "global" loadout. */
function equipAll(
  affixes: EngineAffix[],
  enh = 0,
): { cards: EngineCardInstance[]; inv: EngineEquipInv } {
  const cards = PROGRESSABLE_UNITS.map((ut) => card(ut, 1, { weapon: 'i1' }));
  return { cards, inv: { i1: { defId: 'wp_pencil', level: enh, affixes } } };
}

/** Player cards at L1 with no gear (baseline: campaign build with no equipment effect). */
function bareCards(): EngineCardInstance[] {
  return PROGRESSABLE_UNITS.map((ut) => card(ut, 1));
}

describe('Equipment hard wall — PvP blueprints never see equipment', () => {
  it('with full equipment in memory, buildPvpBlueprints() still equals UNIT_BLUEPRINTS verbatim', () => {
    // Construct an extreme equipment set, but the PvP builder signature has no equipment parameter → cannot read it at compile time.
    void equipAll([{ id: 'm_atk', value: 999 }], 9);
    expect(buildPvpBlueprints()).toEqual(pvpExpectedBlueprints());
  });

  it('after injecting equipment into campaign, the rebuilt PvP blueprints still equal the constant (+ static §5 override; no cross-contamination, no constant mutation)', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const { cards, inv } = equipAll([{ id: 'm_atk', value: 50 }], 9);
    buildCampaignBlueprints(cards, inv);
    expect(UNIT_BLUEPRINTS).toEqual(before);
    expect(buildPvpBlueprints()).toEqual(pvpExpectedBlueprints());
  });

  it('omitting equipmentInv equals passing undefined (injection chain is a no-op for absent equipment)', () => {
    const cards = [card(UnitType.Infantry, 3)];
    expect(buildCampaignBlueprints(cards)).toEqual(buildCampaignBlueprints(cards, undefined));
    expect(buildSiegeBlueprints(cards)).toEqual(buildSiegeBlueprints(cards, undefined));
  });
});

describe('Equipment combat-power monotonicity (§8)', () => {
  it('equipping one attack main affix → player unit attack > base', () => {
    const { cards, inv } = equipAll([{ id: 'm_atk', value: 20 }]);
    const camp = buildCampaignBlueprints(cards, inv);
    expect(camp[UnitType.Infantry].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].attack);
    expect(camp[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('campaign and siege share the same injection chain → same equipment yields same result', () => {
    const { cards, inv } = equipAll([{ id: 'm_hp', value: 30 }], 2);
    expect(buildSiegeBlueprints(cards, inv)).toEqual(buildCampaignBlueprints(cards, inv));
  });

  it('main affix scales with enhancement level: +5 attack > +0 attack', () => {
    const lv0 = equipAll([{ id: 'm_atk', value: 20 }], 0);
    const lv5 = equipAll([{ id: 'm_atk', value: 20 }], 5);
    const bp0 = buildCampaignBlueprints(lv0.cards, lv0.inv);
    const bp5 = buildCampaignBlueprints(lv5.cards, lv5.inv);
    expect(bp5[UnitType.Infantry].attack).toBeGreaterThan(bp0[UnitType.Infantry].attack);
  });

  it('main affix scaling follows base × (1 + value/100 × (1 + coefficient×level))', () => {
    const value = 20;
    const level = 5;
    const { cards, inv } = equipAll([{ id: 'm_atk', value }], level);
    const camp = buildCampaignBlueprints(cards, inv);
    const effPct = (value / 100) * (1 + ENHANCE_COEFF_PER_LEVEL * level);
    const expected = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + effPct));
    expect(camp[UnitType.Infantry].attack).toBe(expected);
  });

  it('sub affixes are fixed and do not scale with enhancement level', () => {
    const lv0 = equipAll([{ id: 's_atk', value: 20 }], 0);
    const lv9 = equipAll([{ id: 's_atk', value: 20 }], 9);
    const bp0 = buildCampaignBlueprints(lv0.cards, lv0.inv);
    const bp9 = buildCampaignBlueprints(lv9.cards, lv9.inv);
    expect(bp9[UnitType.Infantry].attack).toBe(bp0[UnitType.Infantry].attack);
  });

  it('attack-speed main affix reduces attack interval (§7.4 multiplicative interval reduction)', () => {
    const { cards, inv } = equipAll([{ id: 'm_atkspd', value: 20 }]);
    const camp = buildCampaignBlueprints(cards, inv);
    expect(camp[UnitType.Infantry].attackInterval).toBeLessThan(
      UNIT_BLUEPRINTS[UnitType.Infantry].attackInterval,
    );
  });

  it('siege affix buffs siegeValue only, not attack (ADR-026 gear channel is orthogonal to attack)', () => {
    const { cards, inv } = equipAll([{ id: 'm_siege', value: 20 }]);
    const camp = buildCampaignBlueprints(cards, inv);
    expect(camp[UnitType.Infantry].siegeValue).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].siegeValue);
    expect(camp[UnitType.Infantry].attack).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].attack);
  });

  it('siege sub affix (s_siege) also scales siegeValue', () => {
    const { cards, inv } = equipAll([{ id: 's_siege', value: 20 }]);
    const camp = buildCampaignBlueprints(cards, inv);
    expect(camp[UnitType.Archer].siegeValue).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].siegeValue);
  });
});

describe('Cross-system cap (§7.7)', () => {
  it('attack% equipment contribution clamped to EFFECT_CAPS.atkPct (sky-high affixes cannot break the cap)', () => {
    const { cards, inv } = equipAll([{ id: 'm_atk', value: 100000 }], 9);
    const camp = buildCampaignBlueprints(cards, inv);
    const capped = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + EFFECT_CAPS.atkPct));
    expect(camp[UnitType.Infantry].attack).toBe(capped);
  });

  it('siege% equipment contribution clamped to EFFECT_CAPS.siegePct', () => {
    const { cards, inv } = equipAll([{ id: 'm_siege', value: 100000 }], 9);
    const camp = buildCampaignBlueprints(cards, inv);
    const capped = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].siegeValue * (1 + EFFECT_CAPS.siegePct));
    expect(camp[UnitType.Infantry].siegeValue).toBe(capped);
  });

  it('lifesteal summed from all sources clamped to EFFECT_CAPS.lifestealPct (clampEffectCaps applies a unified cross-source clamp)', () => {
    const { cards, inv } = equipAll([{ id: 's_lifesteal', value: 999 }]);
    const camp = buildCampaignBlueprints(cards, inv);
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
    const { cards, inv } = equipAll([{ id: 'm_atk', value: 50 }], 9);
    const camp = buildCampaignBlueprints(cards, inv);
    expect(camp[UnitType.Ironclad]).toEqual(UNIT_BLUEPRINTS[UnitType.Ironclad]);
    expect(camp[UnitType.Runner]).toEqual(UNIT_BLUEPRINTS[UnitType.Runner]);
  });

  it('unknown affix id / missing instance reference / empty gear are all safe no-ops', () => {
    const unknown = equipAll([{ id: 'not_a_real_affix', value: 50 }]);
    expect(buildCampaignBlueprints(unknown.cards, unknown.inv)).toEqual(
      buildCampaignBlueprints(unknown.cards),
    );
    const missingCards = PROGRESSABLE_UNITS.map((ut) => card(ut, 1, { weapon: 'ghost' }));
    expect(buildCampaignBlueprints(missingCards, {})).toEqual(buildCampaignBlueprints(missingCards));
    expect(buildCampaignBlueprints(bareCards(), {})).toEqual(buildCampaignBlueprints(bareCards()));
  });

  it('utility sub-affixes (material drop / stamina) do not enter combat blueprints', () => {
    const util = equipAll([{ id: 's_matdrop', value: 50 }]);
    expect(buildCampaignBlueprints(util.cards, util.inv)).toEqual(
      buildCampaignBlueprints(util.cards),
    );
  });

  it('applyEquipment does not mutate global constants', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const bp = buildPvpBlueprints();
    const inst = card(UnitType.Infantry, 1, { weapon: 'i1' });
    applyEquipment(bp, inst, { i1: { defId: 'wp_pencil', level: 9, affixes: [{ id: 'm_atk', value: 50 }] } });
    expect(UNIT_BLUEPRINTS).toEqual(before);
  });

  it('each card\'s gear applies to its own unit type (per-card gear)', () => {
    const cards = [
      card(UnitType.Archer, 1, { weapon: 'a' }),
      card(UnitType.Infantry, 1, { weapon: 'g' }),
    ];
    const inv: EngineEquipInv = {
      g: { defId: 'wp_pencil', level: 0, affixes: [{ id: 'm_atk', value: 10 }] },
      a: { defId: 'wp_marker', level: 0, affixes: [{ id: 'm_atk', value: 50 }] },
    };
    const camp = buildCampaignBlueprints(cards, inv);
    // Archer's card (+50%), Infantry's card (+10%).
    const arc = Math.round(UNIT_BLUEPRINTS[UnitType.Archer].attack * 1.5);
    const inf = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * 1.1);
    expect(camp[UnitType.Archer].attack).toBe(arc);
    expect(camp[UnitType.Infantry].attack).toBe(inf);
  });
});

describe('Academy siege buff (ADR-026 §5 P2 — siege path only)', () => {
  it('siegeAcademy.siege multiplies siegeValue on the siege path; campaign (no academy param) is unaffected', () => {
    const cards = bareCards();
    const withAcademy = buildSiegeBlueprints(cards, undefined, { hp: 0, damage: 0, siege: 0.2 });
    expect(withAcademy[UnitType.Infantry].siegeValue).toBe(
      Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].siegeValue * 1.2),
    );
    // Campaign path never receives the academy buff.
    expect(buildCampaignBlueprints(cards)[UnitType.Infantry].siegeValue).toBe(
      UNIT_BLUEPRINTS[UnitType.Infantry].siegeValue,
    );
  });

  it('academy siege buff stacks on top of gear siege (post-cap layer)', () => {
    const cards = PROGRESSABLE_UNITS.map((ut) => card(ut, 1, { weapon: 'i1' }));
    const inv: EngineEquipInv = { i1: { defId: 'wp_pencil', level: 0, affixes: [{ id: 's_siege', value: 20 }] } };
    const gearOnly = buildSiegeBlueprints(cards, inv);
    const gearPlusAcademy = buildSiegeBlueprints(cards, inv, { hp: 0, damage: 0, siege: 0.2 });
    expect(gearPlusAcademy[UnitType.Infantry].siegeValue).toBeGreaterThan(gearOnly[UnitType.Infantry].siegeValue);
  });
});
