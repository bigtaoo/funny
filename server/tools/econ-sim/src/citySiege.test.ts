// Regression coverage for the ADR-074 wild-city siege calibration (citySiege.ts / citySiegeRun.ts).
// citySiegeRun.ts is a human-read analysis script (this package's established pattern — run script, read
// printed verdict, register in ECONOMY_VERIFICATION_LOG.md); this file locks its verdict in as a real CI
// check, so an engine-balance or troop-curve change that silently opens the "one player takes a city"
// hole fails here instead of waiting for someone to remember to re-run the script.
//
// Precedent: strongholdCombat.test.ts does the same for the stronghold/crossing gates — and the reason
// both exist is ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5, where a calibration script kept
// printing a conclusion from a superseded baseline for months.
import { describe, expect, it } from 'vitest';
import {
  TIER_STARTER,
  TIER_MID,
  TIER_RAIDER,
  TIER_WHALE,
  TIERS,
  SIEGE_SYNTH_ARMY_MAX_TROOPS,
  MULTS_NONE,
  MULTS_MAX,
  marchTroops,
  poolTroops,
  damagePerSiege,
  measureSiege,
  damageProfile,
  simulateLadder,
  shouldUseCheapSiege,
  shippedLadder,
  attackersFor,
} from './citySiege';
import {
  WILD_CITY_MIN_LEVEL,
  WILD_CITY_MAX_LEVEL,
  CITY_WAVE_COUNT,
  CITY_WAVE_RESPAWN_MS,
  cityWaveGarrison,
  cityDurabilityMax,
  cityRegenPerHour,
  cityLadderGarrison,
  regenCityDurability,
  CARD_TEAM_MAX_SIZE,
  SLG_TEAM_INJURY_MS,
  TROOP_CAP_BASE,
  cardTroopCap,
} from '@nw/shared';

const SEEDS = [1, 2, 3];
/** The §6.2 table published in design/game/SLG_CITY_SIEGE_DESIGN.md. Kept in lockstep with citySiegeRun.ts. */
const DOC_ATTACKERS: Record<number, number> = { 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40 };
const DOC_ATTACKERS_WORLD_CENTER = 80;
const TOLERANCE = 0.25;

describe('citySiege: pure curve helpers', () => {
  it('the weakest wild city is the level the solo gate is measured at', () => {
    expect(WILD_CITY_MIN_LEVEL).toBe(3);
    expect(WILD_CITY_MAX_LEVEL).toBe(10);
  });

  it('durability and regen are base-dominated, not level-proportional (see citySiege.ts §durability)', () => {
    // The ratio between the weakest and strongest city must stay modest: per-siege troop cost rises
    // ~2.7x with city level, so a level-proportional wall would push the attackers-needed curve to ~L².
    const weak = cityDurabilityMax(WILD_CITY_MIN_LEVEL, 'garrison');
    const strong = cityDurabilityMax(WILD_CITY_MAX_LEVEL, 'garrison');
    expect(strong / weak).toBeLessThan(1.5);
    expect(cityRegenPerHour(WILD_CITY_MAX_LEVEL, 'garrison') / cityRegenPerHour(WILD_CITY_MIN_LEVEL, 'garrison')).toBeLessThan(1.5);
  });

  it('the world center doubles both durability and regen', () => {
    expect(cityDurabilityMax(10, 'worldCenter')).toBe(cityDurabilityMax(10, 'garrison') * 2);
    expect(cityRegenPerHour(10, 'worldCenter')).toBe(cityRegenPerHour(10, 'garrison') * 2);
    expect(cityDurabilityMax(10, 'capital')).toBe(cityDurabilityMax(10, 'garrison'));
  });

  it('regenCityDurability is lazy, monotone and clamped to max', () => {
    const max = cityDurabilityMax(3, 'garrison');
    const rate = cityRegenPerHour(3, 'garrison');
    expect(regenCityDurability(0, max, 0, 3_600_000, rate)).toBe(rate);
    expect(regenCityDurability(0, max, 0, 0, rate)).toBe(0);
    expect(regenCityDurability(0, max, 1_000, 0, rate)).toBe(0); // clock skew must never heal backwards
    expect(regenCityDurability(max, max, 0, 999_999_999, rate)).toBe(max);
    expect(regenCityDurability(0, max, 0, 100 * 3_600_000, rate)).toBe(max);
  });

  it('the wave ladder is flat in level; only its per-wave size scales', () => {
    for (const l of [3, 5, 8, 10]) expect(cityLadderGarrison(l)).toBe(CITY_WAVE_COUNT * cityWaveGarrison(l));
    expect(cityWaveGarrison(10)).toBeGreaterThan(cityWaveGarrison(3));
  });

  it('CITY_WAVE_RESPAWN_MS mirrors the main-base defender injury lockout it is modelled on', () => {
    expect(CITY_WAVE_RESPAWN_MS).toBe(SLG_TEAM_INJURY_MS);
  });
});

describe('citySiege: structural ceiling (gate ④ — keep every wave on the engine path)', () => {
  it('the largest wave stays under SIEGE_SYNTH_ARMY_MAX_TROOPS, so no wave is ever routed to the cheap linear path', () => {
    // Above the ceiling the attacker loses exactly the garrison's troop count and card quality stops
    // mattering — and the ladder becomes unclearable by any card team (see CITY_WAVE_GARRISON_PER_LEVEL).
    const largest = cityWaveGarrison(WILD_CITY_MAX_LEVEL);
    expect(largest).toBeLessThanOrEqual(SIEGE_SYNTH_ARMY_MAX_TROOPS);
    for (const tier of TIERS) {
      expect(
        shouldUseCheapSiege({ attackerTroops: marchTroops(tier), defenderTroops: largest, attackerSynthesized: false, defenderSynthesized: true }),
        tier.name,
      ).toBe(false);
    }
  });

  it("a card team's deployment is bound by the CARD troop caps, never by the troop pool or satchel", () => {
    // This is the fact the design doc's paper derivation of `p` missed. If a future card-catalogue change
    // lifts the card caps above the pool cap, the whole calibration has to be re-run.
    for (const tier of TIERS) {
      const cardSum = tier.team.reduce((a, defId) => a + cardTroopCap({ defId, level: tier.cardLevel }), 0);
      expect(marchTroops(tier), tier.name).toBe(cardSum);
      expect(cardSum, tier.name).toBeLessThan(poolTroops(tier) + TROOP_CAP_BASE);
    }
    expect(TIER_WHALE.team.length).toBe(CARD_TEAM_MAX_SIZE);
  });
});

describe('citySiege: determinism', () => {
  it('simulateLadder is deterministic for the same tier + ladder + seed', () => {
    const ladder = shippedLadder(5);
    expect(simulateLadder(TIER_RAIDER, ladder, 42)).toEqual(simulateLadder(TIER_RAIDER, ladder, 42));
  });
});

describe('citySiege: progression gates (gate ② — who can damage which city)', () => {
  it('a starter roster cannot clear any city ladder — a wild city is not early-game content', () => {
    for (const l of [WILD_CITY_MIN_LEVEL, 5, WILD_CITY_MAX_LEVEL]) {
      expect(measureSiege(TIER_STARTER, shippedLadder(l), SEEDS).clearRate, `L${l}`).toBe(0);
    }
  });

  it('an ungeared mid roster reaches only the weakest city — gear, not troops, is the gate', () => {
    expect(measureSiege(TIER_MID, shippedLadder(WILD_CITY_MIN_LEVEL), SEEDS).clearRate).toBe(1);
    expect(measureSiege(TIER_MID, shippedLadder(WILD_CITY_MIN_LEVEL + 1), SEEDS).clearRate).toBe(0);
  });

  it('the reference raider roster clears every level a wild city generates at', () => {
    for (const l of [3, 4, 5, 6, 7, 8, 10]) {
      expect(measureSiege(TIER_RAIDER, shippedLadder(l), SEEDS).clearRate, `L${l}`).toBe(1);
    }
  });

  it('per-siege troop cost rises with city level (difficulty never runs backwards)', () => {
    // 5% tolerance: the engine's defender formation geometry shifts with unit count, so adjacent levels
    // can wobble by a percent or two. Anything more is a real inverted gate.
    let prev = 0;
    for (const l of [3, 4, 5, 6, 7, 8, 10]) {
      const cost = measureSiege(TIER_RAIDER, shippedLadder(l), SEEDS).troopCost;
      expect(cost, `L${l} vs L${l - 1}`).toBeGreaterThanOrEqual(prev * 0.95);
      prev = cost;
    }
  });
});

describe('citySiege: gate ③ — a fully maxed SOLO attacker can never take the weakest wild city', () => {
  const ladder = shippedLadder(WILD_CITY_MIN_LEVEL);
  const H = cityDurabilityMax(WILD_CITY_MIN_LEVEL, 'garrison');
  const R = cityRegenPerHour(WILD_CITY_MIN_LEVEL, 'garrison');

  it('sustained solo damage stays below the regen rate, with every purchasable multiplier stacked', () => {
    // TIER_WHALE = maxed drillYard/satchel, Lv.9 cards, saturated gear, the shop train-speedup buff, and
    // the highest-siege-value roster in the catalogue. MULTS_MAX additionally stacks the +60% equipment
    // siege channel and the §8.3 sect-city channel — NEITHER of which teamSiegeValue reads today, so this
    // is deliberately harsher than production.
    const p = damageProfile(TIER_WHALE, ladder, SEEDS, MULTS_MAX);
    expect(p.sustained).toBeLessThan(R);
    expect(R / p.sustained).toBeGreaterThan(1.4); // margin, so a small retune elsewhere cannot flip it silently
  });

  it('a full pool dump stays below the durability — the tighter of the two conditions', () => {
    // The design doc only ever stated the sustained condition. Without this one a maxed account's standing
    // troop pool takes the city in a single sitting, before regen has any time to act.
    const p = damageProfile(TIER_WHALE, ladder, SEEDS, MULTS_MAX);
    expect(p.burst).toBeLessThan(H);
    expect(H / p.burst).toBeGreaterThan(1.3);
  });

  it('one attacker never finishes inside an hour, at ANY tier', () => {
    for (const tier of TIERS) {
      const p = damageProfile(tier, ladder, SEEDS, MULTS_MAX);
      expect(p.firstHour, tier.name).toBeLessThan(H + R);
    }
  });

  it('the gate holds at every city level, not just the weakest', () => {
    for (const l of [3, 4, 5, 6, 7, 8, 10]) {
      const p = damageProfile(TIER_WHALE, shippedLadder(l), SEEDS, MULTS_MAX);
      expect(p.sustained, `L${l} sustained`).toBeLessThan(cityRegenPerHour(l, 'garrison'));
      expect(p.burst, `L${l} burst`).toBeLessThan(cityDurabilityMax(l, 'garrison'));
    }
  });
});

describe('citySiege: gate ⑤ — attackers-needed matches the published design table', () => {
  it.each(Object.keys(DOC_ATTACKERS).map(Number))('L%i is within ±25% of the doc table', (level) => {
    const p = damageProfile(TIER_RAIDER, shippedLadder(level), SEEDS, MULTS_NONE);
    const measured = attackersFor(level, 'garrison', p.firstHour, 1);
    const doc = DOC_ATTACKERS[level]!;
    expect(Math.abs(measured - doc) / doc, `measured ${measured.toFixed(1)} vs doc ${doc}`).toBeLessThanOrEqual(TOLERANCE);
  });

  it('the world center is within ±25% of the doc table', () => {
    const p = damageProfile(TIER_RAIDER, shippedLadder(WILD_CITY_MAX_LEVEL), SEEDS, MULTS_NONE);
    const measured = attackersFor(WILD_CITY_MAX_LEVEL, 'worldCenter', p.firstHour, 1);
    expect(Math.abs(measured - DOC_ATTACKERS_WORLD_CENTER) / DOC_ATTACKERS_WORLD_CENTER).toBeLessThanOrEqual(TOLERANCE);
  });

  it('more attackers are needed for a higher-level city (the curve never inverts)', () => {
    let prev = 0;
    for (const level of [3, 4, 5, 6, 7, 8, 10]) {
      const p = damageProfile(TIER_RAIDER, shippedLadder(level), SEEDS, MULTS_NONE);
      const n = attackersFor(level, 'garrison', p.firstHour, 1);
      expect(n, `L${level}`).toBeGreaterThan(prev);
      prev = n;
    }
  });
});

describe('citySiege: code facts the design doc assumed otherwise', () => {
  it('teamSiegeValue ignores equipment — the +60% siege channel never reaches the durability hit', () => {
    // Not a bug to fix blind: gate ③ is measured WITH the hypothetical multiplier, so wiring it up later
    // stays inside the margin. This test exists so the assumption is stated, not silently discovered.
    const geared = { ...TIER_RAIDER, geared: true };
    const bare = { ...TIER_RAIDER, geared: false };
    expect(damagePerSiege(geared, MULTS_NONE)).toBe(damagePerSiege(bare, MULTS_NONE));
  });

  it('damage per siege depends only on card level and composition, never on troops carried', () => {
    // "单次伤害不随兵力放大" — the property the whole "many players, not one big player" design rests on.
    const small = { ...TIER_RAIDER, drillYard: 0, satchel: 0 };
    expect(damagePerSiege(small)).toBe(damagePerSiege(TIER_RAIDER));
    expect(marchTroops(small)).toBe(marchTroops(TIER_RAIDER)); // card caps bind, so troops do not even move
  });
});
