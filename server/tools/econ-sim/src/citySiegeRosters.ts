// The attacker side of the ADR-074 city-siege calibration: what ONE account can actually put on the
// board. Split out of citySiege.ts (2026-08-27, ADR-067 500-line convention — the ADR-077 defender-rung
// model pushed that file to 580 lines) along its most independent seam: nothing here knows about wave
// ladders, durability or battles, and nothing here imports back from citySiege.ts.
//
// It is also the seam that matches the printed report: this module is gate ① ("ROSTERS — what one account
// can actually put on the board") in citySiegeRun.ts, end to end.
//
// The one fact worth carrying at the top, because the design doc's paper derivation missed it and that is
// what made the whole calibration necessary: a march's ceiling is the sum of its 12 cards' `cardTroopCap`,
// NOT the account's troop pool. The card caps bind at every tier the game currently produces, so a maxed
// account deploys ~4,800 troops per siege rather than 20,000.
import {
  UnitType,
  ATTACK_LANES,
  type GarrisonEntry,
  type EngineCardInstance,
  type EngineEquipInv,
} from '@nw/engine';
import {
  CARD_DEFS,
  CARD_TEAM_MAX_SIZE,
  MAX_CARD_LEVEL,
  TROOP_TRAIN_TIME_SEC,
  TRAIN_SPEEDUP_BUFF_MULT,
  cardTroopCap,
  satchelCarryCapFor,
  troopCapFor,
  drillTrainMult,
  trainQueueMaxFor,
  type CardInstance,
} from '@nw/shared';

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

/**
 * Saturated-gear item: one instance carrying every combat affix at its EFFECT_CAPS ceiling. Exported so
 * `citySiege.ts`'s `damagePerSiege` can equip it onto the SHARED-side cards too (SLG_CITY_SIEGE_DESIGN
 * §12.7 twin item, wired 2026-08-29) — same instance, same affixes, so the in-battle stat bonus
 * (`engineCards`/`gearInv`, read by the real engine) and the durability-damage bonus
 * (`teamSiegeValue`'s equipmentInv, read by `@nw/shared`) are measured off one saturated loadout, not two.
 */
export const MAXED_GEAR_ID = 'sim_maxed_gear';
export const MAXED_GEAR_INV: EngineEquipInv = {
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

/**
 * The tier's cards as shared `CardInstance`s (what `teamSiegeValue` consumes). Deliberately always
 * `gear: {}`, regardless of `tier.geared` — since `teamSiegeValue` became gear-aware (SLG_CITY_SIEGE_DESIGN
 * §12.7, wired 2026-08-29), `citySiege.ts`'s `damagePerSiege` is what decides whether to equip these cards
 * (via its own `mults.equipment` switch, independent of `tier.geared`), so both a bare and a saturated
 * number can still be measured off the SAME tier — see that function's doc comment.
 */
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
