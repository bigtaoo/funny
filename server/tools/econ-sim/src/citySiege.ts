// ADR-074 wild-city siege calibration model (`design/game/SLG_CITY_SIEGE_DESIGN.md` §6/§10-P2).
// Companion of strongholdCombat.ts (single-tile PvE gate) and occupyCardTeamRun.ts (card-team occupy
// thresholds); this module answers the one question those two cannot:
//
//   "How much durability damage per hour can ONE player actually inflict on a wild city, and how many
//    players does it take to out-race the city's regen inside an hour?"
//
// Why it cannot be derived on paper (the design doc tried, twice, and was wrong both times):
//
//  1. **A card team's troop ceiling is not the troop POOL.** SLG_CITY_SIEGE_DESIGN §6.1 derived the
//     solo damage rate `p` by dividing the whole troop pool (5,000-20,000) by an assumed ~2,000-troop
//     cost per siege. But an attacking march carries a 12-card team, and each card's troop allotment is
//     capped at `cardTroopCap` — 4x600 + 8x300 = **4,800 troops** for a Lv.9 roster, 1,600 for a fresh
//     one. The pool only bounds how many sieges you can REFILL, never how big one is.
//  2. **The per-wave garrison decides which combat model runs.** worldsvc routes any siege where a
//     synthesized side exceeds `SIEGE_SYNTH_ARMY_MAX_TROOPS` (9,600) to the cheap linear `resolveSiege`,
//     where the attacker loses exactly the garrison's troop count and card quality is irrelevant. The
//     design's DRAFT 1180/level crosses that line at level 9 — see CITY_WAVE_GARRISON_PER_LEVEL.
//  3. **Troop cost per siege is an engine measurement, not an estimate.** A 12-card Lv.9 team beats a
//     wave losing far less than the wave's own size; a Lv.1 team loses everything. That ratio is what
//     converts an hourly troop budget into an hourly damage rate, and only the engine knows it.
//
// Model: mirrors worldsvc's `applyBaseSiege` wave loop exactly (attacker survivors carry over between
// waves scaled by each wave's honest survival ratio, ADR-069; a wave's engine "base" is pinned to
// defenderBaseLevel 0 so the fight is decided team-vs-garrison), plus the same `shouldUseCheapSiege`
// dispatch mirror strongholdCombat.ts keeps in lockstep with siegeEngine.ts.
import {
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  UnitType,
  Side,
  ATTACK_LANES,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
  parseLevelDefinition,
  fromFp,
  garrisonProgressionRatios,
  type GarrisonEntry,
  type EngineCardInstance,
  type EngineEquipInv,
} from '@nw/engine';
import {
  buildSiegeBattle,
  resolveSiege,
  teamSiegeValue,
  cityWaveCount,
  cityWaveGarrison,
  cityWaveBaseHp,
  cityDurabilityMax,
  cityRegenPerHour,
  cityDefenderFortifyMult,
  cityDefenderTeamFortify,
  cityDefenderBaseHp,
  SIEGE_CHEAP_RATIO,
  cardTroopCap,
  type CityKind,
  type CardInstance,
} from '@nw/shared';
import {
  TIERS,
  TIER_STARTER,
  TIER_MID,
  TIER_MID_GEARED,
  TIER_RAIDER,
  TIER_VETERAN,
  TIER_WHALE,
  TEAM_MIX,
  TEAM_SIEGE_MAX,
  engineCards,
  gearInv,
  sharedCards,
  MAXED_GEAR_ID,
  MAXED_GEAR_INV,
  marchTroops,
  perCardTroops,
  teamArmy,
  poolTroops,
  trainPerHour,
  type RosterTier,
} from './citySiegeRosters';

// Re-exported so the runner and the spec keep importing the whole calibration surface from one module —
// they read as one tool, and the split above is an internal file-size boundary, not a new public seam.
export {
  TIERS, TIER_STARTER, TIER_MID, TIER_MID_GEARED, TIER_RAIDER, TIER_VETERAN, TIER_WHALE,
  TEAM_MIX, TEAM_SIEGE_MAX,
  engineCards, gearInv, sharedCards,
  marchTroops, perCardTroops, teamArmy, poolTroops, trainPerHour,
};
export type { RosterTier };

const HP_PER_UNIT = fromFp(UNIT_BLUEPRINTS[UnitType.Infantry].hp_fp);
const TICK_MARGIN = 600;

/** Board-placement capacity of `synthesizeArmy`'s round-robin — mirrors siegeEngine.ts. */
export const SIEGE_SYNTH_ARMY_MAX_TROOPS = ATTACK_LANES.length * (TOP_SPAWN_ROW - BOTTOM_SPAWN_ROW + 1) * HP_PER_UNIT;

/** Mirrors worldsvc/src/siegeEngine.ts `shouldUseCheapSiege` exactly. Keep in lockstep. */
export function shouldUseCheapSiege(opts: {
  attackerTroops: number; defenderTroops: number; attackerSynthesized: boolean; defenderSynthesized: boolean;
}): boolean {
  const { attackerTroops, defenderTroops, attackerSynthesized, defenderSynthesized } = opts;
  if (attackerSynthesized && attackerTroops > SIEGE_SYNTH_ARMY_MAX_TROOPS) return true;
  if (defenderSynthesized && defenderTroops > SIEGE_SYNTH_ARMY_MAX_TROOPS) return true;
  if (attackerTroops <= 0) return false;
  return defenderTroops > 0 ? attackerTroops >= defenderTroops * SIEGE_CHEAP_RATIO : true;
}

/** Deterministic defender synthesis from a flat troop count (mirrors siegeEngine.ts synthesizeArmy). */
function synthesizeDefender(troops: number): GarrisonEntry[] {
  let remaining = Math.max(0, Math.floor(troops));
  const army: GarrisonEntry[] = [];
  for (let i = 0; remaining > 0; i++) {
    const hp = Math.min(HP_PER_UNIT, remaining);
    remaining -= hp;
    const col = ATTACK_LANES[i % ATTACK_LANES.length]!;
    const depth = Math.floor(i / ATTACK_LANES.length);
    army.push({ unitType: UnitType.Infantry, col, row: Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - depth), initialHp: hp });
  }
  return army;
}

// -- Damage per siege ----------------------------------------------------------------------------
/**
 * `teamSiegeValue` — the function worldsvc actually calls to size the durability hit — is gear-aware
 * as of 2026-08-29 (SLG_CITY_SIEGE_DESIGN §12.7 twin item): it reads each card's equipped gear's
 * `m_siege`/`s_siege` affixes through `equipmentInv`, the same +60% `EFFECT_CAPS.siegePct_fp` ceiling
 * `applyEquipment` enforces on the engine blueprint's `siegeValue_fp` (in-battle damage). `equipment`
 * below stays a switch, decoupled from `tier.geared`, so the calibration can still show a bare number
 * next to the saturated one on the SAME tier (`sharedCards`'s cards never carry gear on their own —
 * `mults.equipment` is what equips {@link MAXED_GEAR_ID} onto them here).
 *
 * `sect` (2026-08-27, ADR-074 P3): `applyCitySiege` multiplies teamSiegeValue by
 * `(1 + sectPayoff.siegeBonus)` on its own channel, never summed into the capped equipment
 * accumulator. It stays a switch here for the same before/after-channel comparison.
 */
export interface DamageMults {
  /** Equips {@link MAXED_GEAR_ID} (EFFECT_CAPS.siegePct_fp saturated, +60%) before calling teamSiegeValue. */
  equipment: boolean;
  /** SLG_CITY_SIEGE_DESIGN §8.3 sect city bonus, saturated: 9 capitals x +3% + world center +5%. */
  sect: boolean;
}
export const SECT_SIEGE_MULT = 1 + 9 * 0.03 + 0.05;
export const MULTS_NONE: DamageMults = { equipment: false, sect: false };
export const MULTS_MAX: DamageMults = { equipment: true, sect: true };

/** Durability damage one cleared siege deals. */
export function damagePerSiege(tier: RosterTier, mults: DamageMults = MULTS_NONE): number {
  const bareInv = sharedCards(tier);
  let inv: Record<string, CardInstance> = bareInv;
  if (mults.equipment) {
    inv = {};
    for (const [id, c] of Object.entries(bareInv)) inv[id] = { ...c, gear: { weapon: MAXED_GEAR_ID } };
  }
  const army = Object.keys(inv).map((id) => ({ cardInstanceId: id }));
  const base = teamSiegeValue(army, inv, mults.equipment ? MAXED_GEAR_INV : undefined);
  return base * (mults.sect ? SECT_SIEGE_MULT : 1);
}

// -- One siege: the whole wave ladder ------------------------------------------------------------
export interface LadderResult {
  /** All rungs defeated -> the durability hit is scheduled (mirrors applyBaseSiege's `cleared`). */
  cleared: boolean;
  wavesCleared: number;
  waves: number;
  /** ADR-077: player-garrison rungs beaten before the NPC ladder was reached. */
  defendersCleared: number;
  /** How many player-garrison rungs the city had. */
  defenders: number;
  /** Nominal troops the march left home with. */
  deployed: number;
  /** Troops that did not come back (`deployed x (1 - product of wave survival ratios)`). */
  lost: number;
  /** True if any wave was routed to the cheap linear path instead of the engine. */
  usedCheapPath: boolean;
}

/**
 * One attacking march against a city's full NPC wave ladder. Mirrors `applyBaseSiege`: waves are fought
 * in order, the attacker's surviving army carries over scaled by that wave's honest survival ratio
 * (ADR-069), each wave's engine base is pinned to level 0 so the fight is decided team-vs-garrison, and
 * a repelled attacker deals no durability damage at all.
 *
 * **The ladder is per-march** — every attacking march faces every wave. The design doc's original model
 * (waves are shared city state; a defeated wave respawns after `CITY_WAVE_RESPAWN_MS`) cannot work: once
 * the ladder is empty, every march arriving inside the respawn window clears "no defenders" for FREE
 * (`applyBaseSiege` schedules the full durability hit when `defenders.length === 0`), so a lone player
 * with 5 teams and a 24-second round trip lands dozens of zero-cost hits per window. Per-march removes
 * that hole and is what makes the troop cost measured here the real bound on damage per hour.
 */
export interface CityLadder {
  cityLevel: number;
  /** Number of NPC defender waves one march must fight through. */
  waves: number;
  /** NPC troops in each wave. */
  waveGarrison: number;
  /**
   * Engine base-HP ceiling for each wave (`defenderBaseHp`). This is the dominant attrition lever, not the
   * garrison: it decides how long the attacker has to stand in the garrison's fire before the wave ends.
   */
  waveBaseHp: number;
  /**
   * ADR-074 P3 / ADR-077: sect garrison teams parked inside the city, fought AHEAD of the NPC waves and
   * never in place of them (P3's rule — a city defended by weak teams must not be EASIER than an NPC-held
   * one). Empty/omitted = every NPC-held city, which is the overwhelmingly common case and the one gates
   * ③-⑤ are calibrated on.
   */
  defenders?: readonly DefenderRung[];
  /** Which lever the defender rungs' progression factor is spent on (measurement harness — see {@link DefenderLever}). */
  defenderLever?: DefenderLever;
}

/** One player-owned garrison team standing in the city (ADR-077). */
export interface DefenderRung {
  label: string;
  /** The rung's army as the engine fields it: one entry per card, `initialHp` = that card's troops. */
  army: GarrisonEntry[];
  /** Per-unit-type factor from `cityDefenderFortifyMult` (all 1.0 for a bare level-1 roster). */
  perUnit: Partial<Record<UnitType, number>>;
  /** The team's single troop-weighted factor from `cityDefenderTeamFortify` — what worldsvc actually spends. */
  fortify: number;
}

/** Mirrors worldsvc `toDefenderFormation`: an attack-authored team re-placed onto DEFENDER spawn rows. */
function toDefenderFormation(army: readonly GarrisonEntry[]): GarrisonEntry[] {
  return army.map((e, i) => ({
    unitType: e.unitType,
    col: ATTACK_LANES[i % ATTACK_LANES.length]!,
    row: Math.max(BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW - Math.floor(i / ATTACK_LANES.length)),
    ...(e.initialHp != null ? { initialHp: e.initialHp } : {}),
  }));
}

/**
 * A garrison team the given roster tier can park in a city — the same 12-card team it would attack with,
 * re-placed on the defender side, plus the ADR-077 effective-HP factors its own level/gear earn it.
 *
 * Mirrors `cityDefenders.ts` `eligibleDefenders` exactly: the army is the REAL troop truth and the factor
 * is carried separately, because worldsvc settles troop losses against the unscaled figure and only the
 * battle sees the scaled one.
 */
export function defenderRung(tier: RosterTier, label = tier.name): DefenderRung {
  const ratios = garrisonProgressionRatios(engineCards(tier), gearInv(tier));
  const perUnit: Partial<Record<UnitType, number>> = {};
  for (const ut of Object.keys(ratios.hp) as UnitType[]) {
    perUnit[ut] = cityDefenderFortifyMult(ratios.hp[ut] ?? 1, ratios.attack[ut] ?? 1);
  }
  const army = toDefenderFormation(teamArmy(tier));
  // Troop-weighted over the real per-card allotments, exactly as `eligibleDefenders` does it.
  const fortify = cityDefenderTeamFortify(
    army.map((e) => ({ troops: e.initialHp ?? 0, mult: perUnit[e.unitType] ?? 1 })),
  );
  return { label, army, perUnit, fortify };
}

/**
 * The REJECTED 'hp' lever, kept only so gate ⑦ can keep printing why it was rejected: scale each garrison
 * entry by its own unit type's factor. Never what worldsvc does.
 */
function scaleRungHp(rung: DefenderRung): GarrisonEntry[] {
  return rung.army.map((e) => {
    const own = rung.perUnit[e.unitType];
    const mult = own !== undefined && own > 1 ? own : 1;
    if (mult <= 1) return { ...e };
    return { ...e, initialHp: Math.max(1, Math.floor((e.initialHp ?? 0) * mult)) };
  });
}

/** Total HP the REJECTED 'hp' lever would have made a rung field. Printed by gate ⑦ as the counter-example. */
export function rungFieldedHp(rung: DefenderRung): number {
  return scaleRungHp(rung).reduce((a, e) => a + (e.initialHp ?? 0), 0);
}

/**
 * Which lever a defender rung's progression factor is spent on. Not a shipped switch — a measurement
 * harness, so `citySiegeRun.ts` can print all three side by side and the ADR can be decided on numbers
 * rather than on the plausibility of the mechanism.
 *
 *   'none'    the pre-ADR-077 baseline: a player garrison fights on plain baseline blueprints.
 *   'hp'      the factor scales each garrison entry's `initialHp`.
 *   'baseHp'  the factor scales the rung's symbolic `defenderBaseHp` — WHAT SHIPS.
 *
 * The distinction matters far more than it looks: the objective is `destroy_base` against a
 * deliberately small {@link cityWaveBaseHp}, so a single attacker unit slipping past the garrison ends
 * the battle regardless of how much HP that garrison still has. `simulateLadder`'s own comment about
 * baseHp=100 vs 600 is the same observation from the NPC-wave side.
 */
export type DefenderLever = 'none' | 'hp' | 'baseHp';

/** The shipped ladder for a city level, from the @nw/shared constants. */
export function shippedLadder(cityLevel: number): CityLadder {
  return {
    cityLevel,
    waves: cityWaveCount(cityLevel),
    waveGarrison: cityWaveGarrison(cityLevel),
    waveBaseHp: cityWaveBaseHp(cityLevel),
  };
}

/** One rung of the ladder - a defender team or an NPC wave - resolved exactly as worldsvc resolves it. */
function fightRung(opts: {
  survivorArmy: GarrisonEntry[];
  /** The rung's army as it will actually be fielded (defender rungs arrive already scaled). */
  defArmy: GarrisonEntry[];
  /** Synthesized-from-a-flat-count (NPC waves) vs a real level-schema-validated team (player garrisons). */
  defenderSynthesized: boolean;
  baseHp: number;
  cityLevel: number;
  seed: number;
  cards: EngineCardInstance[];
  equipmentInv: EngineEquipInv | undefined;
}): { attackerWin: boolean; ratio: number; usedCheapPath: boolean } {
  const { survivorArmy, defArmy, defenderSynthesized, baseHp, cityLevel, seed, cards, equipmentInv } = opts;
  const deployedHp = survivorArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
  const defenderTroops = defArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
  if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops, attackerSynthesized: false, defenderSynthesized })) {
    const res = resolveSiege(deployedHp, defenderTroops);
    const ratio = deployedHp > 0 ? Math.min(1, res.attackerSurvivors / deployedHp) : 0;
    return { attackerWin: res.outcome === 'attacker_win', ratio, usedCheapPath: true };
  }
  // An explicit `defenderBaseHp` is NOT optional here. `applyBaseSiege`'s main-base waves leave it out,
  // which falls back to the engine's flat BASE_HP=100 - and under ADR-069 (a unit's siege value scales
  // with the troops it carries) a single 300-troop shieldbearer one-shots a 100-HP base, so the wave ends
  // the moment one attacker unit reaches it and the garrison never gets to fight. Measured: a maxed team
  // clears a 4,500-troop wave losing ~99 troops at baseHp=100 vs ~730 at baseHp=600. Without a real base
  // the whole ladder is free and the troop-cost bound this file exists to measure does not exist.
  const levelObj = buildSiegeBattle({ army: survivorArmy }, { garrison: defArmy, defenderBaseLevel: 0, defenderBaseHp: baseHp }, cityLevel, seed);
  const level = parseLevelDefinition(levelObj);
  const timeout = level.battleTimeoutTicks ?? 18000;
  const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame: 0 });
  const { engine } = runHeadless(
    { seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level, cardInstances: cards, equipmentInv },
    input, timeout + TICK_MARGIN,
  );
  let atkHp = 0;
  for (const unit of engine.state.board.units.values()) {
    if (unit.isDead) continue;
    if (unit.side === Side.Bottom) atkHp += fromFp(unit.hp_fp);
  }
  const measured = Math.floor(fromFp(engine.state.preplacedAttackerHp_fp));
  const deployedMeasured = measured > 0 ? measured : deployedHp;
  const ratio = deployedMeasured > 0 ? Math.min(1, Math.floor(atkHp) / deployedMeasured) : 0;
  return { attackerWin: engine.state.winner === Side.Bottom, ratio, usedCheapPath: false };
}

export function simulateLadder(tier: RosterTier, ladder: CityLadder, seed: number): LadderResult {
  const { cityLevel, waves, waveGarrison, waveBaseHp, defenders = [], defenderLever = 'baseHp' } = ladder;
  const cards = engineCards(tier);
  const equipmentInv = gearInv(tier);
  let survivorArmy = teamArmy(tier).map((e) => ({ ...e }));
  const nominal = survivorArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
  let cumSurvival = 1;
  let cleared = true;
  let wavesCleared = 0;
  let defendersCleared = 0;
  let usedCheapPath = false;

  // ADR-074 P3: sect garrison rungs come FIRST and the NPC ladder behind them is untouched - additive,
  // never substitutive. worldsvc offsets its per-rung seeds by the defender count for the same reason the
  // offset below exists: no two rungs of one assault may share a seed.
  const rungs: Array<{ defArmy: GarrisonEntry[]; defenderSynthesized: boolean; isDefender: boolean; baseHp: number }> = [
    ...defenders.map((d) => ({
      defArmy: defenderLever === 'hp' ? scaleRungHp(d) : d.army.map((e) => ({ ...e })),
      defenderSynthesized: false,
      isDefender: true,
      baseHp: defenderLever === 'baseHp' ? cityDefenderBaseHp(cityLevel, d.fortify) : waveBaseHp,
    })),
    ...Array.from({ length: waves }, () => ({
      defArmy: synthesizeDefender(waveGarrison), defenderSynthesized: true, isDefender: false, baseHp: waveBaseHp,
    })),
  ];

  for (let i = 0; i < rungs.length; i++) {
    const deployedHp = survivorArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
    if (survivorArmy.length === 0 || deployedHp <= 0) { cleared = false; break; }
    const rung = rungs[i]!;
    const res = fightRung({
      survivorArmy, defArmy: rung.defArmy, defenderSynthesized: rung.defenderSynthesized,
      baseHp: rung.baseHp, cityLevel, seed: seed + i * 7919, cards, equipmentInv,
    });
    usedCheapPath = usedCheapPath || res.usedCheapPath;
    cumSurvival *= res.ratio;
    if (!res.attackerWin) { cleared = false; break; }
    if (rung.isDefender) defendersCleared++; else wavesCleared++;
    survivorArmy = survivorArmy
      .map((e) => ({ ...e, initialHp: Math.floor((e.initialHp ?? 0) * res.ratio) }))
      .filter((e) => (e.initialHp ?? 0) > 0);
  }

  const lost = Math.max(0, Math.round(nominal * (1 - cumSurvival)));
  return { cleared, wavesCleared, waves, deployed: nominal, lost, usedCheapPath, defendersCleared, defenders: defenders.length };
}

export interface SiegeCost {
  /** Fraction of seeds on which the whole ladder was cleared (a repelled march deals no damage). */
  clearRate: number;
  /** Mean troop loss over cleared attempts — the price of one durability hit. */
  troopCost: number;
  /** Mean troop loss over FAILED attempts (paid for nothing). */
  failCost: number;
  usedCheapPath: boolean;
  deployed: number;
}

/** Measures the cost of one durability hit for a roster against a city level, over `seeds`. */
export function measureSiege(tier: RosterTier, ladder: CityLadder, seeds: readonly number[]): SiegeCost {
  let cleared = 0, costSum = 0, failSum = 0, cheap = false, deployed = 0;
  for (const seed of seeds) {
    const r = simulateLadder(tier, ladder, seed);
    deployed = r.deployed;
    cheap = cheap || r.usedCheapPath;
    if (r.cleared) { cleared++; costSum += r.lost; } else failSum += r.lost;
  }
  const failed = seeds.length - cleared;
  return {
    clearRate: cleared / seeds.length,
    troopCost: cleared > 0 ? costSum / cleared : Number.POSITIVE_INFINITY,
    failCost: failed > 0 ? failSum / failed : 0,
    usedCheapPath: cheap, deployed,
  };
}

// -- Hourly damage rate --------------------------------------------------------------------------
export interface DamageProfile {
  /** Damage the roster can land in the first hour: (pool + one hour of training) / cost x damage. */
  firstHour: number;
  /** Sustained damage per hour once the starting pool is spent — training throughput only. */
  sustained: number;
  /** Damage the starting pool alone buys, spent as fast as marches can cycle (the burst drawdown). */
  burst: number;
  siegesFirstHour: number;
  damagePerSiege: number;
  troopCost: number;
  clearRate: number;
}

export function damageProfile(
  tier: RosterTier, ladder: CityLadder, seeds: readonly number[], mults: DamageMults = MULTS_NONE,
): DamageProfile {
  const cost = measureSiege(tier, ladder, seeds);
  const dmg = damagePerSiege(tier, mults);
  // A roster that cannot clear the ladder on every seed still lands damage on the seeds it does clear,
  // but pays `failCost` on the others — model it as an expected cost per successful hit.
  const expectedCostPerHit = cost.clearRate > 0
    ? cost.troopCost + (cost.failCost * (1 - cost.clearRate)) / cost.clearRate
    : Number.POSITIVE_INFINITY;
  const pool = poolTroops(tier);
  const train = trainPerHour(tier);
  const siegesFirstHour = Number.isFinite(expectedCostPerHit) && expectedCostPerHit > 0 ? (pool + train) / expectedCostPerHit : 0;
  return {
    firstHour: siegesFirstHour * dmg,
    sustained: Number.isFinite(expectedCostPerHit) && expectedCostPerHit > 0 ? (train / expectedCostPerHit) * dmg : 0,
    burst: Number.isFinite(expectedCostPerHit) && expectedCostPerHit > 0 ? (pool / expectedCostPerHit) * dmg : 0,
    siegesFirstHour, damagePerSiege: dmg, troopCost: expectedCostPerHit, clearRate: cost.clearRate,
  };
}

/**
 * Attackers needed to take a city in `hours`, given each attacker contributes `perAttackerPerHour`
 * damage per hour: `N = (H + R*hours) / (perAttackerPerHour * hours)`. Infinity when nobody can hurt it.
 */
export function attackersFor(cityLevel: number, kind: CityKind, perAttackerPerHour: number, hours = 1): number {
  if (!(perAttackerPerHour > 0)) return Number.POSITIVE_INFINITY;
  const H = cityDurabilityMax(cityLevel, kind);
  const R = cityRegenPerHour(cityLevel, kind);
  return (H + R * hours) / (perAttackerPerHour * hours);
}
