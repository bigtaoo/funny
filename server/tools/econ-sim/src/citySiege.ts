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
  CARD_TEAM_MAX_SIZE,
  CARD_DEFS,
  MAX_CARD_LEVEL,
  SIEGE_CHEAP_RATIO,
  TROOP_TRAIN_TIME_SEC,
  TRAIN_SPEEDUP_BUFF_MULT,
  troopCapFor,
  satchelCarryCapFor,
  drillTrainMult,
  trainQueueMaxFor,
  cardTroopCap,
  type CardInstance,
  type CityKind,
} from '@nw/shared';

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

// -- Rosters -------------------------------------------------------------------------------------
/**
 * The 12-card mix a player realistically fields (same composition as occupyCardTeamRun.ts, so the two
 * tools' tiers are comparable): infantry/shieldbearer core + archer reach + one of each Anna character.
 */
export const TEAM_MIX: readonly string[] = [
  'lichuang', 'lichuang', 'lichuang', 'lichuang',
  'chenshou', 'chenshou', 'chenshou',
  'suyuan', 'suyuan',
  'max', 'lena', 'mara',
];
/**
 * The highest-siege-value 12-card team the catalogue permits: `chenshou`/`lena` are the two
 * `siegeValueBase: 14` wall-breakers. This is the roster the single-player-proof invariant must be
 * measured against — it maximises damage-per-siege, which is the only thing durability cares about.
 * (It also carries FEWER troops than {@link TEAM_MIX} — 12x300 = 3,600 vs 4,800 at Lv.9, because
 * `lichuang` is the only card with a 200/+50 troop cap — so which roster actually threatens the city
 * is not obvious on paper; the runner measures both.)
 */
export const TEAM_SIEGE_MAX: readonly string[] = [
  'chenshou', 'chenshou', 'chenshou', 'chenshou', 'chenshou', 'chenshou',
  'lena', 'lena', 'lena', 'lena', 'lena', 'lena',
];

for (const team of [TEAM_MIX, TEAM_SIEGE_MAX]) {
  if (team.length !== CARD_TEAM_MAX_SIZE) throw new Error(`team must be exactly CARD_TEAM_MAX_SIZE (${CARD_TEAM_MAX_SIZE}) cards`);
}

export interface RosterTier {
  name: string;
  /** drillYard building level -> troop pool cap, training speed and training queue slots. */
  drillYard: number;
  /** satchel building level -> per-march troop carry cap. */
  satchel: number;
  cardLevel: number;
  team: readonly string[];
  /** All equipment caps saturated (+60% atk/hp/siege, +40% atkspd) — the strongest gear the game allows. */
  geared: boolean;
  /** `slg_speedup_*` shop buff active (TRAIN_SPEEDUP_BUFF_MULT x training throughput). */
  speedup: boolean;
}

export const TIER_STARTER: RosterTier = { name: 'starter  (drill L0, cards Lv.1, no gear)', drillYard: 0, satchel: 0, cardLevel: 1, team: TEAM_MIX, geared: false, speedup: false };
export const TIER_MID: RosterTier = { name: 'mid      (drill L4, cards Lv.4, no gear)', drillYard: 4, satchel: 4, cardLevel: 4, team: TEAM_MIX, geared: false, speedup: false };
export const TIER_MID_GEARED: RosterTier = { name: 'mid+gear (drill L4, cards Lv.4, geared)', drillYard: 4, satchel: 4, cardLevel: 4, team: TEAM_MIX, geared: true, speedup: false };
/**
 * **The reference tier for the attackers-needed table** — a developed, geared sect member, the roster a
 * siege raid is actually made of. Picked because it is the WEAKEST tier that can clear the wave ladder at
 * every city level including level 10 (measured): anything below it cannot land a hit on a capital at all,
 * so an N-attackers figure computed from it would be fiction.
 */
export const TIER_RAIDER: RosterTier = { name: 'raider   (drill L6, cards Lv.6, geared)  <- reference', drillYard: 6, satchel: 6, cardLevel: 6, team: TEAM_MIX, geared: true, speedup: false };
export const TIER_VETERAN: RosterTier = { name: 'veteran  (drill L8, cards Lv.8, geared)', drillYard: 8, satchel: 8, cardLevel: 8, team: TEAM_MIX, geared: true, speedup: false };
/**
 * The worst case the single-player-proof invariant must survive: everything the game can give one
 * account — maxed drillYard/satchel, Lv.9 cards, saturated gear, the purchasable training-speed buff,
 * and the highest-siege-value roster in the catalogue.
 */
export const TIER_WHALE: RosterTier = { name: 'MAXED    (drill L10, cards Lv.9, geared, speedup, siege-max roster)', drillYard: 10, satchel: 10, cardLevel: MAX_CARD_LEVEL, team: TEAM_SIEGE_MAX, geared: true, speedup: true };

export const TIERS: readonly RosterTier[] = [TIER_STARTER, TIER_MID, TIER_MID_GEARED, TIER_RAIDER, TIER_VETERAN, TIER_WHALE];

const buildingsOf = (t: RosterTier) => ({ drillYard: t.drillYard, satchel: t.satchel });

/** Saturated-gear item: one instance carrying every combat affix at its EFFECT_CAPS ceiling. */
const MAXED_GEAR_ID = 'sim_maxed_gear';
const MAXED_GEAR_INV: EngineEquipInv = {
  [MAXED_GEAR_ID]: {
    defId: 'sim_maxed', level: 0,
    // Secondary affixes take their rolled value verbatim (no enhancement scaling), so 60/60/60/40
    // lands exactly on EFFECT_CAPS.{atkPct,hpPct,siegePct}=+60% / atkspdPct=+40%.
    affixes: [{ id: 's_atk', value: 60 }, { id: 's_hp', value: 60 }, { id: 's_siege', value: 60 }, { id: 's_atkspd', value: 40 }],
  },
};

export function engineCards(tier: RosterTier): EngineCardInstance[] {
  return tier.team.map((defId, i) => {
    const def = CARD_DEFS[defId];
    if (!def) throw new Error(`unknown card def '${defId}'`);
    return {
      id: `sim_${defId}_${i}`, defId, unitType: def.unitType as UnitType, level: tier.cardLevel,
      gear: tier.geared ? { weapon: MAXED_GEAR_ID } : {},
    };
  });
}
export const gearInv = (tier: RosterTier): EngineEquipInv | undefined => (tier.geared ? MAXED_GEAR_INV : undefined);

/** The tier's cards as shared `CardInstance`s (what `teamSiegeValue` consumes). */
export function sharedCards(tier: RosterTier): Record<string, CardInstance> {
  const inv: Record<string, CardInstance> = {};
  tier.team.forEach((defId, i) => {
    inv[`sim_${defId}_${i}`] = { id: `sim_${defId}_${i}`, defId, level: tier.cardLevel, gear: {}, locked: false };
  });
  return inv;
}

// -- Deployment capacity -------------------------------------------------------------------------
/**
 * Troops one march of this roster actually carries: every card filled to its own `cardTroopCap`, then
 * clamped by the per-march satchel carry cap and the account's troop pool cap. The card caps are the
 * binding constraint at every tier the game currently produces — which is precisely the fact the design
 * doc's paper derivation of `p` missed.
 */
export function marchTroops(tier: RosterTier): number {
  const perCard = tier.team.map((defId) => cardTroopCap({ defId, level: tier.cardLevel }));
  const sum = perCard.reduce((a, b) => a + b, 0);
  return Math.min(sum, satchelCarryCapFor(buildingsOf(tier)), troopCapFor(buildingsOf(tier)));
}
/** Per-card troop allotment (the march total spread over the team, proportional to each card's cap). */
export function perCardTroops(tier: RosterTier): number[] {
  const perCard = tier.team.map((defId) => cardTroopCap({ defId, level: tier.cardLevel }));
  const sum = perCard.reduce((a, b) => a + b, 0);
  const scale = sum > 0 ? marchTroops(tier) / sum : 0;
  return perCard.map((c) => Math.floor(c * scale));
}
/** Attacker formation: the team round-robin across the attack lanes, two ranks deep. */
export function teamArmy(tier: RosterTier): GarrisonEntry[] {
  const troops = perCardTroops(tier);
  return tier.team.map((defId, i) => ({
    unitType: CARD_DEFS[defId]!.unitType as UnitType,
    col: ATTACK_LANES[i % ATTACK_LANES.length]!,
    row: 3 + Math.floor(i / ATTACK_LANES.length),
    initialHp: troops[i]!,
  }));
}

/** Troop pool the account holds when the assault starts (drillYard-driven). */
export const poolTroops = (tier: RosterTier): number => troopCapFor(buildingsOf(tier));
/**
 * Sustained troop training throughput, troops/hour: `slots x 3600 / (TROOP_TRAIN_TIME_SEC x speedMult)`,
 * optionally doubled by the shop's train-speedup buff. This — not the pool — is what a multi-hour siege
 * campaign runs on.
 */
export function trainPerHour(tier: RosterTier): number {
  const b = buildingsOf(tier);
  const perSlot = 3600 / (TROOP_TRAIN_TIME_SEC * drillTrainMult(b));
  return perSlot * trainQueueMaxFor(b) * (tier.speedup ? TRAIN_SPEEDUP_BUFF_MULT : 1);
}

// -- Damage per siege ----------------------------------------------------------------------------
/**
 * WARNING: `teamSiegeValue` — the function worldsvc actually calls to size the durability hit — reads
 * only each card's `defId` + `level`. **Equipment does not enter it**: the +60% `EFFECT_CAPS.siegePct_fp`
 * channel is applied by `applyEquipment` to the engine blueprint's `siegeValue_fp`, which only affects
 * in-battle damage against a symbolic base, never the persistent durability hit. Same for the §8.3 sect
 * bonus (not implemented yet). So both multipliers below are HYPOTHETICAL headroom, carried explicitly
 * so the calibration survives someone wiring them up later.
 */
export interface DamageMults {
  /** EFFECT_CAPS.siegePct_fp saturated (+60%) — if `teamSiegeValue` is ever made gear-aware. */
  equipment: boolean;
  /** SLG_CITY_SIEGE_DESIGN §8.3 sect city bonus, saturated: 9 capitals x +3% + world center +5%. */
  sect: boolean;
}
export const EQUIP_SIEGE_MULT = 1.6;
export const SECT_SIEGE_MULT = 1 + 9 * 0.03 + 0.05;
export const MULTS_NONE: DamageMults = { equipment: false, sect: false };
export const MULTS_MAX: DamageMults = { equipment: true, sect: true };

/** Durability damage one cleared siege deals. */
export function damagePerSiege(tier: RosterTier, mults: DamageMults = MULTS_NONE): number {
  const inv = sharedCards(tier);
  const army = Object.keys(inv).map((id) => ({ cardInstanceId: id }));
  const base = teamSiegeValue(army, inv);
  return base * (mults.equipment ? EQUIP_SIEGE_MULT : 1) * (mults.sect ? SECT_SIEGE_MULT : 1);
}

// -- One siege: the whole wave ladder ------------------------------------------------------------
export interface LadderResult {
  /** All waves defeated -> the durability hit is scheduled (mirrors applyBaseSiege's `cleared`). */
  cleared: boolean;
  wavesCleared: number;
  waves: number;
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
}

/** The shipped ladder for a city level, from the @nw/shared constants. */
export function shippedLadder(cityLevel: number): CityLadder {
  return {
    cityLevel,
    waves: cityWaveCount(cityLevel),
    waveGarrison: cityWaveGarrison(cityLevel),
    waveBaseHp: cityWaveBaseHp(cityLevel),
  };
}

export function simulateLadder(tier: RosterTier, ladder: CityLadder, seed: number): LadderResult {
  const { cityLevel, waves, waveGarrison, waveBaseHp } = ladder;
  const cards = engineCards(tier);
  const equipmentInv = gearInv(tier);
  let survivorArmy = teamArmy(tier).map((e) => ({ ...e }));
  const nominal = survivorArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
  let cumSurvival = 1;
  let cleared = true;
  let wavesCleared = 0;
  let usedCheapPath = false;

  for (let i = 0; i < waves; i++) {
    const deployedHp = survivorArmy.reduce((a, e) => a + (e.initialHp ?? 0), 0);
    if (survivorArmy.length === 0 || deployedHp <= 0) { cleared = false; break; }
    const waveSeed = seed + i * 7919;
    let attackerSurvivors: number;
    let attackerWin: boolean;
    let deployedMeasured = deployedHp;
    if (shouldUseCheapSiege({ attackerTroops: deployedHp, defenderTroops: waveGarrison, attackerSynthesized: false, defenderSynthesized: true })) {
      usedCheapPath = true;
      const res = resolveSiege(deployedHp, waveGarrison);
      attackerSurvivors = res.attackerSurvivors;
      attackerWin = res.outcome === 'attacker_win';
    } else {
      const defArmy = synthesizeDefender(waveGarrison);
      // An explicit `defenderBaseHp` is NOT optional here. `applyBaseSiege`'s main-base waves leave it out,
      // which falls back to the engine's flat BASE_HP=100 — and under ADR-069 (a unit's siege value scales
      // with the troops it carries) a single 300-troop shieldbearer one-shots a 100-HP base, so the wave ends
      // the moment one attacker unit reaches it and the garrison never gets to fight. Measured: a maxed team
      // clears a 4,500-troop wave losing ~99 troops at baseHp=100 vs ~730 at baseHp=600. Without a real base
      // the whole ladder is free and the troop-cost bound this file exists to measure does not exist.
      const levelObj = buildSiegeBattle({ army: survivorArmy }, { garrison: defArmy, defenderBaseLevel: 0, defenderBaseHp: waveBaseHp }, cityLevel, waveSeed);
      const level = parseLevelDefinition(levelObj);
      const timeout = level.battleTimeoutTicks ?? 18000;
      const input = new ReplayInputSource({ engineVersion: ENGINE_VERSION, mode: 'siege', seed: waveSeed, frames: [], endFrame: 0 });
      const { engine } = runHeadless(
        { seed: waveSeed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level, cardInstances: cards, equipmentInv },
        input, timeout + TICK_MARGIN,
      );
      let atkHp = 0;
      for (const unit of engine.state.board.units.values()) {
        if (unit.isDead) continue;
        if (unit.side === Side.Bottom) atkHp += fromFp(unit.hp_fp);
      }
      attackerSurvivors = Math.floor(atkHp);
      attackerWin = engine.state.winner === Side.Bottom;
      const measured = Math.floor(fromFp(engine.state.preplacedAttackerHp_fp));
      if (measured > 0) deployedMeasured = measured;
    }
    const ratio = deployedMeasured > 0 ? Math.min(1, attackerSurvivors / deployedMeasured) : 0;
    cumSurvival *= ratio;
    if (!attackerWin) { cleared = false; break; }
    wavesCleared++;
    survivorArmy = survivorArmy
      .map((e) => ({ ...e, initialHp: Math.floor((e.initialHp ?? 0) * ratio) }))
      .filter((e) => (e.initialHp ?? 0) > 0);
  }

  const lost = Math.max(0, Math.round(nominal * (1 - cumSurvival)));
  return { cleared, wavesCleared, waves, deployed: nominal, lost, usedCheapPath };
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
