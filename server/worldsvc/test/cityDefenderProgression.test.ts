// ADR-077 (SLG_CITY_SIEGE_DESIGN §12): a player-owned city garrison fortifies the position it holds, by
// its own card levels and equipment. Unit tests for the whole three-piece chain, pinned in one file
// because the pieces live in three packages and only make sense together:
//
//   @nw/engine  garrisonProgressionRatios  — what the defender's cards/gear WOULD have multiplied hp/attack by
//   @nw/shared  cityDefenderFortifyMult    — per-card conversion of those two ratios into one factor
//               cityDefenderTeamFortify    — troop-weighted aggregation into the team's single factor
//               cityDefenderBaseHp         — the rung's symbolic base HP, fortified
//   worldsvc    cityDefenders.ts           — feeds the chain from data getSaveFields already returns
//
// Background. The engine's cardInstances/equipmentInv are single-sided by construction, so before this
// ADR a real player's garrison fielded the exact same plain baseline blueprint as a tile's NPC waves —
// see buildSiegeGarrisonBlueprints' doc comment for the 2026-08-12 incident that made that isolation
// unconditional, which is correct for an NPC and wrong for a player.
//
// The lever was chosen by MEASUREMENT and the obvious answer lost. Scaling the garrison's own HP was
// implemented first; econ-sim gate ⑦ measured it as worth nothing (a garrison fielding 32,508 effective
// HP cost the reference attacker 1,209 troops against 1,245 on bare blueprints — inside the noise),
// because the objective is destroy_base against a deliberately small cityWaveBaseHp and one attacker
// unit slipping past ends the rung however fat the garrison is. Base HP is the lever that measured a
// real graded curve, so base HP is what ships.
import { describe, expect, it } from 'vitest';
import {
  cityDefenderFortifyMult,
  cityDefenderTeamFortify,
  cityDefenderBaseHp,
  cityWaveBaseHp,
  CITY_DEFENDER_ATK_AS_HP,
  CITY_DEFENDER_FORTIFY_MAX,
  CARD_DEFS,
} from '@nw/shared';
import { garrisonProgressionRatios, UnitType, type EngineCardInstance, type EngineEquipInv } from '@nw/engine';

const SHIELD = CARD_DEFS['chenshou']!.unitType as UnitType;
const INF = CARD_DEFS['lichuang']!.unitType as UnitType;

const card = (defId: string, level: number, gear: Record<string, string | undefined> = {}): EngineCardInstance => ({
  id: 'probe_' + defId + '_' + level,
  defId,
  unitType: CARD_DEFS[defId]!.unitType as UnitType,
  level,
  gear,
});

/** One item carrying every combat affix saturated at its EFFECT_CAPS ceiling (+60% hp/atk/siege, +40% atkspd). */
const MAXED_GEAR = 'probe_maxed';
const MAXED_INV = {
  [MAXED_GEAR]: {
    defId: 'probe', level: 0,
    affixes: [{ id: 's_atk', value: 60 }, { id: 's_hp', value: 60 }, { id: 's_siege', value: 60 }, { id: 's_atkspd', value: 40 }],
  },
} as unknown as EngineEquipInv;

describe('garrisonProgressionRatios (engine)', () => {
  it('a bare level-1 roster earns nothing — exactly 1.0 on both axes', () => {
    // The case that must stay byte-identical to the pre-ADR battle: an unprogressed garrison has to field
    // precisely the baseline it fielded before, or P3's "additive, never substitutive" rule breaks.
    const r = garrisonProgressionRatios([card('chenshou', 1)]);
    expect(r.hp[SHIELD]).toBe(1);
    expect(r.attack[SHIELD]).toBe(1);
  });

  it('an empty roster returns empty maps rather than defaults', () => {
    // The unreadable-save path: no ratios means every card resolves to a factor of 1, which is the
    // graceful degradation the rest of worldsvc's meta reads already use.
    const r = garrisonProgressionRatios([]);
    expect(Object.keys(r.hp)).toHaveLength(0);
    expect(Object.keys(r.attack)).toHaveLength(0);
  });

  it('level 9 earns exactly STAT_GROWTH_PER_LEVEL over 8 steps — hp 1.96, attack 1.80', () => {
    // Derived, not copied from a table: +12%/level hp and +10%/level attack, additive over level 1.
    const r = garrisonProgressionRatios([card('chenshou', 9)]);
    expect(r.hp[SHIELD]).toBeCloseTo(1 + 0.12 * 8, 6);
    expect(r.attack[SHIELD]).toBeCloseTo(1 + 0.10 * 8, 6);
  });

  it('saturated gear adds the capped +60% on top of level growth, on both axes', () => {
    const bare = garrisonProgressionRatios([card('chenshou', 9)]);
    const geared = garrisonProgressionRatios([card('chenshou', 9, { weapon: MAXED_GEAR })], MAXED_INV);
    expect(geared.hp[SHIELD]).toBeCloseTo(bare.hp[SHIELD]! * 1.6, 5);
    expect(geared.attack[SHIELD]).toBeCloseTo(bare.attack[SHIELD]! * 1.6, 5);
  });

  it('gear beyond the cap is clamped, not summed — two maxed items are worth the same as one', () => {
    // The reason to read the ratio off the real blueprint instead of summing affix values (which is what
    // @nw/shared cardPower does, deliberately loosely, for UI sorting): EFFECT_CAPS is applied inside
    // applyEquipment, and a hand-rolled affix sum would sail straight past it.
    const inv = {
      ...(MAXED_INV as unknown as Record<string, unknown>),
      probe_second: { defId: 'probe', level: 0, affixes: [{ id: 's_hp', value: 60 }, { id: 's_atk', value: 60 }] },
    } as unknown as EngineEquipInv;
    const one = garrisonProgressionRatios([card('chenshou', 9, { weapon: MAXED_GEAR })], MAXED_INV);
    const two = garrisonProgressionRatios([card('chenshou', 9, { weapon: MAXED_GEAR, armor: 'probe_second' })], inv);
    expect(two.hp[SHIELD]).toBeCloseTo(one.hp[SHIELD]!, 6);
    expect(two.attack[SHIELD]).toBeCloseTo(one.attack[SHIELD]!, 6);
  });

  it('keys only the unit types the roster actually fields, and reports each independently', () => {
    const r = garrisonProgressionRatios([card('chenshou', 9), card('lichuang', 1)]);
    expect(Object.keys(r.hp).sort()).toEqual([INF, SHIELD].sort());
    expect(r.hp[SHIELD]).toBeGreaterThan(1);
    expect(r.hp[INF]).toBe(1);          // a level-1 card in the same team earns nothing of its own
  });

  it('takes the highest-LEVEL card of a unit type, mirroring buildCampaignBlueprints', () => {
    // Not the highest-POWER one: the blueprint builder this reads through picks by level, and a ratio that
    // disagreed with the table the engine actually fields would be a silent lie.
    const r = garrisonProgressionRatios([card('chenshou', 3), card('chenshou', 9)]);
    expect(r.hp[SHIELD]).toBeCloseTo(1 + 0.12 * 8, 6);
  });
});

describe('the shared conversion, against REAL engine ratios', () => {
  it('a maxed card is worth the saturated factor, and it stays inside the ceiling', () => {
    // The ceiling's job: it does not bind today, so this asserts the strongest thing the game can
    // actually produce is still inside it. Raise a growth rate or an EFFECT_CAP elsewhere and this fails
    // loudly, instead of silently moving a number that was signed off by measurement.
    const r = garrisonProgressionRatios([card('chenshou', 9, { weapon: MAXED_GEAR })], MAXED_INV);
    const raw = r.hp[SHIELD]! * Math.pow(r.attack[SHIELD]!, CITY_DEFENDER_ATK_AS_HP);
    expect(raw).toBeLessThan(CITY_DEFENDER_FORTIFY_MAX);
    expect(cityDefenderFortifyMult(r.hp[SHIELD]!, r.attack[SHIELD]!)).toBeCloseTo(raw, 6);
    // ~9.03 at the current constants — the figure econ-sim gate ⑦ reports as the MAXED row's factor.
    expect(raw).toBeGreaterThan(9);
  });

  it('a bare level-1 team leaves the rung base HP exactly where the NPC waves have it', () => {
    // The continuity requirement, end to end through all three pieces.
    const r = garrisonProgressionRatios([card('chenshou', 1)]);
    const fortify = cityDefenderTeamFortify([
      { troops: 300, mult: cityDefenderFortifyMult(r.hp[SHIELD] ?? 1, r.attack[SHIELD] ?? 1) },
    ]);
    expect(fortify).toBe(1);
    for (const level of [3, 5, 10]) {
      expect(cityDefenderBaseHp(level, fortify)).toBe(cityWaveBaseHp(level));
    }
  });

  it('a maxed team multiplies the rung base HP by its factor', () => {
    const r = garrisonProgressionRatios([card('chenshou', 9, { weapon: MAXED_GEAR })], MAXED_INV);
    const mult = cityDefenderFortifyMult(r.hp[SHIELD]!, r.attack[SHIELD]!);
    const fortify = cityDefenderTeamFortify([{ troops: 300, mult }]);
    expect(cityDefenderBaseHp(3, fortify)).toBe(Math.floor(cityWaveBaseHp(3) * mult));
    expect(cityDefenderBaseHp(3, fortify)).toBeGreaterThan(cityWaveBaseHp(3));
  });
});

describe('cityDefenderTeamFortify — the anti-gaming property', () => {
  it('is troop-weighted, so empty strong cards cannot carry a full weak one', () => {
    // Without weighting, parking eleven empty level-9 cards behind one full level-1 card would collect
    // the maximum factor. worldsvc feeds this the RESOLVED army, i.e. real per-card troop allotments.
    const gamed = cityDefenderTeamFortify([
      { troops: 3000, mult: 1 },
      ...Array.from({ length: 11 }, () => ({ troops: 0, mult: 9 })),
    ]);
    expect(gamed).toBe(1);
  });

  it('a genuinely strong team gets close to its cards factor', () => {
    const honest = cityDefenderTeamFortify(Array.from({ length: 12 }, () => ({ troops: 300, mult: 6 })));
    expect(honest).toBeCloseTo(6, 6);
  });

  it('mixes proportionally to troops carried', () => {
    // Half the troops on a 5x card and half on a 1x card is worth 3x, not 5x and not the plain mean of a
    // per-card list that ignored how full each card was.
    expect(cityDefenderTeamFortify([{ troops: 100, mult: 5 }, { troops: 100, mult: 1 }])).toBeCloseTo(3, 6);
    expect(cityDefenderTeamFortify([{ troops: 900, mult: 5 }, { troops: 100, mult: 1 }])).toBeCloseTo(4.6, 6);
  });

  it('an empty or degenerate team is exactly 1', () => {
    expect(cityDefenderTeamFortify([])).toBe(1);
    expect(cityDefenderTeamFortify([{ troops: 0, mult: 9 }])).toBe(1);
    expect(cityDefenderTeamFortify([{ troops: Number.NaN, mult: 9 }])).toBe(1);
  });

  it('clamps a per-card factor at the ceiling before weighting, not after', () => {
    // Otherwise one absurd card could push the weighted mean past the ceiling that cityDefenderBaseHp
    // then re-clamps — same answer, but the team factor itself would be a lie in logs and tests.
    expect(cityDefenderTeamFortify([{ troops: 100, mult: 1e6 }])).toBe(CITY_DEFENDER_FORTIFY_MAX);
  });
});
