// SLG home-city building system (SLG_CITY_DESIGN, ADR-022; season-scoped, cleared on reset) — P1 + P2 (wall/academy/cabinet) + P3 (satchel, D-CITY-9).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).
// Home-city administration: a single hub (desk) gates a row of stationery buildings. Buildings inject ONLY into SLG economy / troop paths
// (recomputeYield / settleResources cap / troopCap + training); they NEVER feed buildPvpBlueprints (ladder red line, D-CITY-6).
// Pure data + pure functions (computable on either end, unit-testable). All numbers DRAFT — tune in the balance pass
// (SLG_ECONOMY_CHECK), register figures in ECONOMY_NUMBERS §13-SLG-CITY.

import { RESOURCE_CAP, RESOURCE_TYPES, TROOP_CAP_BASE, TROOP_TRAIN_QUEUE_MAX, type ResourceType } from './core';

export type BuildingKey =
  | 'desk'         // hub: single total-level gate for every other building + base durability / build-queue slots
  | 'inkPot'       // ink global yield multiplier
  | 'paperTray'    // paper global yield multiplier
  | 'graphiteMill' // graphite global yield multiplier
  | 'metalForge'   // metal global yield multiplier
  | 'stickerShop'  // sticker home-city self-production (residential-model; copper-coin faucet)
  | 'cabinet'      // storage cap (RESOURCE_CAP multiplier) + loot protection (P2)
  | 'drillYard'    // troopCap growth + training speed + training queue slots
  | 'wall'         // P2: home-city siege defense
  | 'academy'      // P2: season-scoped blueprint buff
  | 'satchel';     // P3: per-march troop-carry cap (D-CITY-9), independent of drillYard's total troopCap

export const BUILDING_KEYS: readonly BuildingKey[] = [
  'desk', 'inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop', 'cabinet', 'drillYard', 'wall', 'academy', 'satchel',
];
/** P1(+satchel, D-CITY-9) subset of BUILDING_KEYS — historical grouping only. The `/world/build/upgrade`
 *  endpoint gate (httpApi.ts) uses the full BUILDING_KEYS: wall/academy have been real-buildable since P2
 *  closed 2026-06-30 (patched 2026-07-16 after the endpoint gate was found still checking this P1 subset). */
export const BUILDING_KEYS_P1: readonly BuildingKey[] = [
  'desk', 'inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop', 'cabinet', 'drillYard', 'satchel',
];
/** Which land resource each resource-building boosts (recomputeYield multiplier). stickerShop is self-production, handled separately. */
export const BUILDING_YIELD_RES: Readonly<Partial<Record<BuildingKey, ResourceType>>> = {
  inkPot: 'ink', paperTray: 'paper', graphiteMill: 'graphite', metalForge: 'metal',
};

// D-CITY-7 (2026-07-15): DESK_MAX_LEVEL corrected from 20 to 10 — the earlier "aligned with
// Three-Kingdoms 20" comment was never verified; Three Kingdoms' hub (君王殿) actually caps at
// 10 (http://m.7724.com/sggame/news/23083.html). Halving the level range means every per-level
// growth step below is doubled (so max-level totals are unchanged) and BUILD_COST_BASE / BUILD_TIME_BASE_SEC
// are scaled ×4 (sum_{2..20}lvl / sum_{2..10}lvl ≈ 3.87, rounded to a clean 4×) so total investment-to-max
// stays in the same ballpark rather than getting cheaper/faster purely from fewer levels.
export const DESK_MAX_LEVEL = 10;              // hub total-level cap (Three-Kingdoms 君王殿 = 10, D-CITY-7)
export const BUILD_YIELD_STEP = 0.10;          // resource building: +10% land-resource yield per level
export const STICKER_SELF_BASE = 400;          // stickerShop: sticker self-produced per hour per level (residential-model faucet)
export const CABINET_CAP_STEP = 0.20;          // cabinet: +20% storage cap per level
export const DRILL_TROOPCAP_STEP = 1000;       // drillYard: +1000 troopCap per level
export const DRILL_TRAIN_SPEED_STEP = 0.08;    // drillYard: -8% training time per level (floored)
export const DRILL_TRAIN_SPEED_FLOOR = 0.5;    // drillYard: training-time multiplier never below 0.5
export const DRILL_QUEUE_PER_LEVELS = 2;       // drillYard: +1 training queue slot per this many levels
// DRAFT: base = TROOP_CAP_BASE (a single team can carry the whole starting pool with no satchel built) and
// step mirrors DRILL_TROOPCAP_STEP so a maxed satchel (L10) lets one team carry the whole max troopCap (12,000) —
// without it, surplus troops from a maxed drillYard must be split across multiple teams (D-CITY-9).
export const SATCHEL_CARRY_BASE = TROOP_CAP_BASE; // per-march troop-carry cap with no satchel built
export const SATCHEL_CARRY_STEP = 1000;           // satchel: +1000 per-march troop-carry cap per level
export const BUILD_QUEUE_SLOTS = 1;            // concurrent build-queue slots (paid 2nd slot deferred, §6)
export const BUILD_SPEEDUP_SECS_PER_COIN = 60; // build speedup rate (aligned with TROOP_SPEEDUP_SECS_PER_COIN)
export const BUILD_TIME_BASE_SEC = 480;        // base build time per level; time(toLevel) = base × toLevel
export const DESK_BUILD_TIME_MULT = 5;         // desk upgrades take longer (hub)

/** Per-building base resource cost; buildCost(toLevel) = base × toLevel (DRAFT linear curve). High-tier keys eat graphite + sticker (sink). */
const BUILD_COST_BASE: Readonly<Record<BuildingKey, Partial<Record<ResourceType, number>>>> = {
  desk:         { paper: 8000, graphite: 3200, sticker: 2000 },
  inkPot:       { paper: 2400, ink: 1200 },
  paperTray:    { paper: 2400 },
  graphiteMill: { paper: 3200, graphite: 800 },
  metalForge:   { paper: 3200, metal: 1200 },
  stickerShop:  { paper: 2800, graphite: 800 },
  cabinet:      { paper: 4000, graphite: 1600, sticker: 800 },
  drillYard:    { paper: 3600, metal: 1600, sticker: 800 },
  wall:         { paper: 4800, graphite: 2400, metal: 1600 },
  academy:      { paper: 4000, graphite: 3200, sticker: 1600 },
  satchel:      { paper: 3600, metal: 1200, sticker: 800 },
};

/** Current level of a building: desk defaults to 1 (always present), every other building defaults to 0 (unbuilt). */
export function buildingLevel(buildings: Partial<Record<BuildingKey, number>> | undefined, key: BuildingKey): number {
  const lvl = buildings?.[key];
  if (lvl != null) return lvl;
  return key === 'desk' ? 1 : 0;
}
/** Desk (hub) current level. */
export function deskLevel(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return buildingLevel(buildings, 'desk');
}
/** Land-resource hourly-yield multiplier from the matching resource building (1 if none). */
export function buildingYieldMult(buildings: Partial<Record<BuildingKey, number>> | undefined, rt: ResourceType): number {
  for (const key of Object.keys(BUILDING_YIELD_RES) as BuildingKey[]) {
    if (BUILDING_YIELD_RES[key] === rt) return 1 + buildingLevel(buildings, key) * BUILD_YIELD_STEP;
  }
  return 1;
}
/** Home-city self-produced hourly yield for a resource (currently only sticker via stickerShop). */
export function buildingSelfYield(buildings: Partial<Record<BuildingKey, number>> | undefined, rt: ResourceType): number {
  if (rt === 'sticker') return buildingLevel(buildings, 'stickerShop') * STICKER_SELF_BASE;
  return 0;
}
/** Storage cap including cabinet bonus (settleResources cap). */
export function resourceCapFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.floor(RESOURCE_CAP * (1 + buildingLevel(buildings, 'cabinet') * CABINET_CAP_STEP));
}
/** Troop cap including drillYard growth (replaces the static TROOP_CAP_BASE). */
export function troopCapFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return TROOP_CAP_BASE + buildingLevel(buildings, 'drillYard') * DRILL_TROOPCAP_STEP;
}
/** Per-march troop-carry cap from satchel (D-CITY-9) — independent of troopCapFor's total pool cap; gates a single team's march/siege deployment. */
export function satchelCarryCapFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return SATCHEL_CARRY_BASE + buildingLevel(buildings, 'satchel') * SATCHEL_CARRY_STEP;
}
/** Training-time multiplier from drillYard speed (floored at DRILL_TRAIN_SPEED_FLOOR). */
export function drillTrainMult(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.max(DRILL_TRAIN_SPEED_FLOOR, 1 - buildingLevel(buildings, 'drillYard') * DRILL_TRAIN_SPEED_STEP);
}
/** Training queue slot count including drillYard bonus. */
export function trainQueueMaxFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return TROOP_TRAIN_QUEUE_MAX + Math.floor(buildingLevel(buildings, 'drillYard') / DRILL_QUEUE_PER_LEVELS);
}
/** Resource cost to upgrade a building to `toLevel` (only positive entries returned). */
export function buildCost(key: BuildingKey, toLevel: number): Partial<Record<ResourceType, number>> {
  const base = BUILD_COST_BASE[key];
  const lvl = Math.max(1, Math.floor(toLevel));
  const out: Partial<Record<ResourceType, number>> = {};
  for (const rt of RESOURCE_TYPES) {
    const b = base[rt];
    if (b) out[rt] = b * lvl;
  }
  return out;
}
/** Build time (seconds) to upgrade a building to `toLevel` (desk is slower; = coin speedup variable point). */
export function buildTimeSec(key: BuildingKey, toLevel: number): number {
  const lvl = Math.max(1, Math.floor(toLevel));
  const baseT = key === 'desk' ? BUILD_TIME_BASE_SEC * DESK_BUILD_TIME_MULT : BUILD_TIME_BASE_SEC;
  return baseT * lvl;
}
/**
 * Desk gate (SLG_CITY_DESIGN §5 / D-CITY-6): desk grows up to DESK_MAX_LEVEL; every other building's target level must be ≤ current desk level.
 * Returns null if the upgrade is permitted, otherwise a short reason string.
 */
export function buildGateReason(
  buildings: Partial<Record<BuildingKey, number>> | undefined,
  key: BuildingKey,
  toLevel: number,
): string | null {
  if (!BUILDING_KEYS.includes(key)) return 'unknown building';
  if (!Number.isFinite(toLevel) || toLevel < 1) return 'invalid target level';
  if (key === 'desk') return toLevel > DESK_MAX_LEVEL ? 'desk at max level' : null;
  if (toLevel > deskLevel(buildings)) return 'desk level too low';
  return null;
}

// ── P2 building functions (wall / academy / cabinet loot-protect) ───────────────────────────────
/** DRAFT: wall building → +10% garrison HP per level on the defender's main base (step doubled for DESK_MAX_LEVEL=10, D-CITY-7). */
export const WALL_DEFENSE_STEP = 0.10;
/** DRAFT: academy building → attacker siege-blueprint HP buff per level (step doubled for DESK_MAX_LEVEL=10, D-CITY-7). */
export const ACADEMY_HP_STEP = 0.04;
/** DRAFT: academy building → attacker siege-blueprint damage buff per level (step doubled for DESK_MAX_LEVEL=10, D-CITY-7). */
export const ACADEMY_DAMAGE_STEP = 0.03;
/** DRAFT: academy building → attacker siege-blueprint siege-value buff per level (ADR-026, mirrors damage step; doubled for DESK_MAX_LEVEL=10, D-CITY-7). */
export const ACADEMY_SIEGE_STEP = 0.03;
/** DRAFT: cabinet building → loot protection rate per level (stacks up to 40% at max; step doubled for DESK_MAX_LEVEL=10, D-CITY-7). */
export const CABINET_PROTECT_STEP = 0.04;

/** Multiplier applied to defender garrison HP when the defender's main base (type:'base') is besieged (P2, SLG_CITY_DESIGN §5). */
export function wallDefenseMult(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return 1 + buildingLevel(buildings, 'wall') * WALL_DEFENSE_STEP;
}
/** Fraction of looted resources the cabinet protects (cabinetLootProtect × loot = protected, not transferred). */
export function cabinetLootProtect(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.min(0.8, buildingLevel(buildings, 'cabinet') * CABINET_PROTECT_STEP);
}
/** Academy seasonal blueprint buffs (HP + damage + siege-value multiplier bonuses) for the attacker's siege army (P2, SLG_CITY_DESIGN §5; siege channel ADR-026). */
export function academyBuff(buildings: Partial<Record<BuildingKey, number>> | undefined): { hp: number; damage: number; siege: number } {
  const lvl = buildingLevel(buildings, 'academy');
  return { hp: lvl * ACADEMY_HP_STEP, damage: lvl * ACADEMY_DAMAGE_STEP, siege: lvl * ACADEMY_SIEGE_STEP };
}
