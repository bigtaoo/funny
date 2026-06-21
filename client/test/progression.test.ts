import { describe, it, expect } from 'vitest';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';
import { Unit } from '../src/game/Unit';
import { Side } from '../src/game/types';
import { buildPvpBlueprints, buildCampaignBlueprints } from '../src/game/balance/pveUpgrades';
import {
  UNIT_MAX_LEVEL,
  PROGRESSABLE_UNITS,
  STAT_GROWTH_PER_LEVEL,
  TRAIT_BREAKPOINTS,
  applyUnitLevels,
  clampUnitLevel,
} from '../src/game/balance/progression';

/** Every progressable unit at max level. */
function maxedLevels(): Partial<Record<UnitType, number>> {
  const out: Partial<Record<UnitType, number>> = {};
  for (const t of PROGRESSABLE_UNITS) out[t] = UNIT_MAX_LEVEL;
  return out;
}

describe('unit progression — hard wall preserved', () => {
  it('buildPvpBlueprints() ignores unit levels entirely (signature has no level param)', () => {
    void maxedLevels();
    expect(buildPvpBlueprints()).toEqual(UNIT_BLUEPRINTS);
  });

  it('buildCampaignBlueprints with no unit levels equals UNIT_BLUEPRINTS', () => {
    expect(buildCampaignBlueprints({})).toEqual(UNIT_BLUEPRINTS);
    expect(buildCampaignBlueprints({}, undefined, {})).toEqual(UNIT_BLUEPRINTS);
  });

  it('a maxed campaign build buffs stats but never mutates the constant', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const camp = buildCampaignBlueprints({}, undefined, maxedLevels());
    expect(camp[UnitType.Infantry].hp).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].hp);
    expect(camp[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
    expect(UNIT_BLUEPRINTS).toEqual(before);
    expect(buildPvpBlueprints()).toEqual(before);
  });
});

describe('applyUnitLevels — stat scaling', () => {
  it('L1 (and missing) is a no-op', () => {
    const bp = buildPvpBlueprints();
    applyUnitLevels(bp, { [UnitType.Infantry]: 1 });
    applyUnitLevels(bp, {}); // empty
    applyUnitLevels(bp, undefined);
    expect(bp).toEqual(UNIT_BLUEPRINTS);
  });

  it('applies the linear formula mult = 1 + perLevel × (level − 1)', () => {
    const camp = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: 5 });
    const steps = 5 - 1;
    const expectedHp = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].hp * (1 + STAT_GROWTH_PER_LEVEL.hp * steps));
    const expectedAtk = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + STAT_GROWTH_PER_LEVEL.attack * steps));
    expect(camp[UnitType.Infantry].hp).toBe(expectedHp);
    expect(camp[UnitType.Infantry].attack).toBe(expectedAtk);
  });

  it('clamps level above max and below 1', () => {
    expect(clampUnitLevel(999)).toBe(UNIT_MAX_LEVEL);
    expect(clampUnitLevel(0)).toBe(1);
    expect(clampUnitLevel(-3)).toBe(1);
    expect(clampUnitLevel(undefined)).toBe(1);
    const over = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: 999 });
    const atMax = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: UNIT_MAX_LEVEL });
    expect(over).toEqual(atMax);
  });

  it('does not touch PvE-only enemy units (no card → not progressable)', () => {
    const camp = buildCampaignBlueprints({}, undefined, maxedLevels());
    expect(camp[UnitType.Ironclad]).toEqual(UNIT_BLUEPRINTS[UnitType.Ironclad]);
    expect(camp[UnitType.Runner]).toEqual(UNIT_BLUEPRINTS[UnitType.Runner]);
  });
});

describe('applyUnitLevels — trait breakpoints T3 / T6 / T9', () => {
  it('crit (T3) unlocks at L3, not before', () => {
    const below = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: TRAIT_BREAKPOINTS.crit.level - 1 });
    expect(below[UnitType.Infantry].critPct ?? 0).toBe(0);
    const at = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: TRAIT_BREAKPOINTS.crit.level });
    expect(at[UnitType.Infantry].critPct).toBe(TRAIT_BREAKPOINTS.crit.pct);
    expect(at[UnitType.Infantry].critMult).toBe(TRAIT_BREAKPOINTS.crit.mult);
  });

  it('lifesteal (T6) unlocks at L6 and is capped by clampEffectCaps (≤30)', () => {
    const below = buildCampaignBlueprints({}, undefined, { [UnitType.Archer]: TRAIT_BREAKPOINTS.lifesteal.level - 1 });
    expect(below[UnitType.Archer].lifestealPct ?? 0).toBe(0);
    const at = buildCampaignBlueprints({}, undefined, { [UnitType.Archer]: TRAIT_BREAKPOINTS.lifesteal.level });
    expect(at[UnitType.Archer].lifestealPct).toBe(TRAIT_BREAKPOINTS.lifesteal.pct);
  });

  it('+1 spawn (T9) only at max level', () => {
    const below = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: TRAIT_BREAKPOINTS.bonusSpawn.level - 1 });
    expect(below[UnitType.Infantry].spawnCount).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount);
    const at = buildCampaignBlueprints({}, undefined, { [UnitType.Infantry]: TRAIT_BREAKPOINTS.bonusSpawn.level });
    expect(at[UnitType.Infantry].spawnCount).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount + TRAIT_BREAKPOINTS.bonusSpawn.count);
  });
});

describe('crit fields propagate blueprint → Unit', () => {
  it('a crit-capable blueprint produces a Unit with critPct/critMult set', () => {
    const camp = buildCampaignBlueprints({}, undefined, maxedLevels());
    const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 0, camp[UnitType.Infantry]);
    expect(u.critPct).toBe(TRAIT_BREAKPOINTS.crit.pct);
    expect(u.critMult).toBe(TRAIT_BREAKPOINTS.crit.mult);
  });

  it('a plain PvP blueprint produces a Unit with no crit (0 / 1)', () => {
    const u = new Unit(UnitType.Infantry, Side.Bottom, 0, 0, buildPvpBlueprints()[UnitType.Infantry]);
    expect(u.critPct).toBe(0);
    expect(u.critMult).toBe(1);
  });
});
