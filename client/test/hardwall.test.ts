import { describe, it, expect } from 'vitest';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';
import {
  PVE_UPGRADE_DEFS,
  buildPvpBlueprints,
  buildCampaignBlueprints,
  applyPveUpgrades,
  upgradeCost,
  getUpgradeDef,
} from '../src/game/balance/pveUpgrades';
import { createGameEngine } from '../src/game/GameEngine';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { pvpExpectedBlueprints as pvpExpected } from './pvpBlueprintExpected';

/** A SaveData.pveUpgrades map with every upgrade maxed. */
function maxedUpgrades(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of PVE_UPGRADE_DEFS) out[def.id] = def.maxLevel;
  return out;
}

describe('hard wall — PvP blueprints never see PvE upgrades', () => {
  it('buildPvpBlueprints() equals UNIT_BLUEPRINTS + static PvP overrides, never PvE upgrades', () => {
    // The maxed save exists in memory; the PvP builder must ignore it entirely
    // (only the fixed §5 Medic override differs from the raw constants).
    void maxedUpgrades();
    expect(buildPvpBlueprints()).toEqual(pvpExpected());
  });

  it('buildCampaignBlueprints({}) with no upgrades equals UNIT_BLUEPRINTS', () => {
    expect(buildCampaignBlueprints({})).toEqual(UNIT_BLUEPRINTS);
  });

  it('buildCampaignBlueprints(maxed) buffs at least one stat above the constant', () => {
    const camp = buildCampaignBlueprints(maxedUpgrades());
    expect(camp[UnitType.Infantry].hp).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].hp);
    expect(camp[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('builders return fresh clones — never mutate the global constant', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const camp = buildCampaignBlueprints(maxedUpgrades());
    camp[UnitType.Infantry].hp = 99999; // tamper with the clone
    expect(UNIT_BLUEPRINTS).toEqual(before); // constant untouched
    // A PvP build after a campaign build is still pristine (constants + static §5 overrides).
    expect(buildPvpBlueprints()).toEqual(pvpExpected());
  });

  it('a PvP engine built after a maxed campaign engine still uses constant stats', () => {
    const cfg2 = { seed: 7, players: [{ id: 0 as const }, { id: 1 as const }] };
    // Build a campaign engine with maxed upgrades first.
    const lvl = CAMPAIGN_LEVELS[CAMPAIGN_LEVEL_ORDER[0]];
    createGameEngine({ ...cfg2, mode: 'campaign', level: lvl, pveUpgrades: maxedUpgrades() });
    // Now a PvP engine — its blueprints must equal the constants.
    const pvp = createGameEngine({ ...cfg2, mode: 'pvp' }) as unknown as {
      state: { unitBlueprints: typeof UNIT_BLUEPRINTS };
    };
    expect(pvp.state.unitBlueprints).toEqual(pvpExpected());
  });
});

describe('applyPveUpgrades — clamping & math', () => {
  it('ignores unknown ids and 0 / negative levels', () => {
    const bp = buildPvpBlueprints();
    applyPveUpgrades(bp, { not_a_real_id: 9, inf_hp: 0, inf_dmg: -3 });
    expect(bp).toEqual(pvpExpected());
  });

  it('clamps levels above maxLevel to maxLevel', () => {
    const over = buildCampaignBlueprints({ inf_hp: 999 });
    const atMax = buildCampaignBlueprints({ inf_hp: getUpgradeDef('inf_hp')!.maxLevel });
    expect(over).toEqual(atMax);
  });

  it('applies the documented multiplicative formula (1 + effectPerLevel × level)', () => {
    const def = getUpgradeDef('inf_hp')!;
    const camp = buildCampaignBlueprints({ inf_hp: 3 });
    const expected = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].hp * (1 + def.effectPerLevel * 3));
    expect(camp[UnitType.Infantry].hp).toBe(expected);
  });
});

describe('upgradeCost', () => {
  it('scales linearly with level and returns null at max', () => {
    const def = getUpgradeDef('inf_hp')!;
    expect(upgradeCost(def, 0)).toEqual({ material: def.material, amount: def.baseCost });
    expect(upgradeCost(def, 2)).toEqual({ material: def.material, amount: def.baseCost * 3 });
    expect(upgradeCost(def, def.maxLevel)).toBeNull();
  });
});
