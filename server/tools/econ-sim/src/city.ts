// ─────────────────────────────────────────────────────────────────────────────
// SLG home-city build/train pacing (B-track of SLG_ECONOMY_CHECK §4, second bullet).
//
// B-track is PURE INTRA-SEASON PACING — it never touches persistent economy (§0.1),
// so nothing here feeds the §6.1 monthly coin budget. The question it answers is only:
//
//   "With season-resource income, do the SLG_CITY building/training DRAFT numbers put
//    'max the city' and 'field a real army' inside a sensible 60-day '重肝' window —
//    a sustained F2P grind (not trivial, not impossible) with coin speed-up as the
//    time-compression monetization lever?"
//
// Everything computed straight from @nw/shared so the table never drifts from code
// (same discipline as valuation.ts). The only soft inputs are the income PROFILES
// (tile holdings are not pinned in design) — kept explicit and clearly assumption-driven,
// exactly like A-track's population scenarios. The hard verdict rests on the
// code-derived totals / ratios-to-cap / growth deltas, not on the income guess.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BUILDING_KEYS_P1,
  DESK_MAX_LEVEL,
  buildCost,
  buildTimeSec,
  buildingYieldMult,
  resourceCapFor,
  troopCapFor,
  drillTrainMult,
  trainQueueMaxFor,
  BUILD_YIELD_STEP,
  CABINET_CAP_STEP,
  DRILL_TROOPCAP_STEP,
  DRILL_TRAIN_SPEED_STEP,
  DRILL_TRAIN_SPEED_FLOOR,
  STICKER_SELF_BASE,
  BUILD_SPEEDUP_SECS_PER_COIN,
  RESOURCE_CAP,
  RESOURCE_YIELD_BASE,
  NATION_BONUS_PRODUCTION,
  SEASON_LENGTH_DAYS,
  TROOP_CAP_BASE,
  TROOP_TRAIN_INK_COST,
  TROOP_TRAIN_TIME_SEC,
  type BuildingKey,
  type ResourceType,
} from '@nw/shared';

const RESOURCE_TYPES: ResourceType[] = ['ink', 'paper', 'graphite', 'metal', 'sticker'];

/** Sum of buildCost over every level step 2..max for one building (start level is always 1). */
function totalCostToMax(key: BuildingKey, maxLevel: number): Partial<Record<ResourceType, number>> {
  const out: Partial<Record<ResourceType, number>> = {};
  for (let lvl = 2; lvl <= maxLevel; lvl++) {
    const c = buildCost(key, lvl);
    for (const rt of RESOURCE_TYPES) {
      if (c[rt]) out[rt] = (out[rt] ?? 0) + (c[rt] as number);
    }
  }
  return out;
}

/** Sum of buildTimeSec over every level step 2..max for one building. */
function totalTimeToMax(key: BuildingKey, maxLevel: number): number {
  let sec = 0;
  for (let lvl = 2; lvl <= maxLevel; lvl++) sec += buildTimeSec(key, lvl);
  return sec;
}

export interface CityTotals {
  /** Per-resource grand total to take every P1 building 1 -> DESK_MAX_LEVEL. */
  cost: Partial<Record<ResourceType, number>>;
  /** Serial build-queue seconds to max everything (BUILD_QUEUE_SLOTS = 1). */
  serialBuildSec: number;
  /** Coins to skip the entire serial build time (BUILD_SPEEDUP_SECS_PER_COIN). */
  coinsToSkipAll: number;
}

/** Code-derived totals — the deterministic backbone of the verdict (no assumptions). */
export function cityTotals(): CityTotals {
  const cost: Partial<Record<ResourceType, number>> = {};
  let serialBuildSec = 0;
  for (const key of BUILDING_KEYS_P1) {
    const c = totalCostToMax(key, DESK_MAX_LEVEL);
    for (const rt of RESOURCE_TYPES) {
      if (c[rt]) cost[rt] = (cost[rt] ?? 0) + (c[rt] as number);
    }
    serialBuildSec += totalTimeToMax(key, DESK_MAX_LEVEL);
  }
  return { cost, serialBuildSec, coinsToSkipAll: Math.ceil(serialBuildSec / BUILD_SPEEDUP_SECS_PER_COIN) };
}

/** Per-resource cost split, building by building (for the breakdown table). */
export function costByBuilding(): Record<string, Partial<Record<ResourceType, number>>> {
  const out: Record<string, Partial<Record<ResourceType, number>>> = {};
  for (const key of BUILDING_KEYS_P1) out[key] = totalCostToMax(key, DESK_MAX_LEVEL);
  return out;
}

/** Growth deltas at max level — sanity of the multipliers (feel, not economy). */
export function maxLevelEffects() {
  const maxed: Partial<Record<BuildingKey, number>> = {};
  for (const key of BUILDING_KEYS_P1) maxed[key] = DESK_MAX_LEVEL;
  // drillTrainMult floors at DRILL_TRAIN_SPEED_FLOOR — find the level where the floor first bites.
  const floorLevel = Math.ceil((1 - DRILL_TRAIN_SPEED_FLOOR) / DRILL_TRAIN_SPEED_STEP);
  return {
    yieldMultAtMax: buildingYieldMult(maxed, 'paper'),       // resource building 1 -> 2x at +5%/lvl
    capAtMax: resourceCapFor(maxed),                          // cabinet storage at +10%/lvl
    capBase: RESOURCE_CAP,
    troopCapAtMax: troopCapFor(maxed),                        // drillYard
    troopCapBase: TROOP_CAP_BASE,
    trainMultAtMax: drillTrainMult(maxed),                    // floored
    trainFloorBitesAtLevel: floorLevel,                       // levels beyond this give no speed
    queueAtMax: trainQueueMaxFor(maxed),                      // training queue slots
    stickerFaucetAtMax: STICKER_SELF_BASE * DESK_MAX_LEVEL,   // sticker/h at stickerShop max
  };
}

/**
 * Income profile = a transparent (unpinned) assumption set, like A-track population.
 * tiles[rt] = number of resource tiles of that type a player works; avgTileLevel = mean tile level.
 * Hourly income(rt) = tiles × RESOURCE_YIELD_BASE × avgTileLevel × buildingMult × (1 + nationBonus).
 * buildingMult uses a mid-grind average (city is half-built while you grind toward max).
 */
export interface IncomeProfile {
  label: string;
  tiles: Partial<Record<ResourceType, number>>;
  avgTileLevel: number;
  /** Average resource-building level during the grind (city is mid-built); drives buildingMult. */
  avgBuildingLevel: number;
}

export function hourlyIncome(p: IncomeProfile): Partial<Record<ResourceType, number>> {
  const midMult = 1 + p.avgBuildingLevel * BUILD_YIELD_STEP;
  const nation = 1 + NATION_BONUS_PRODUCTION;
  const out: Partial<Record<ResourceType, number>> = {};
  for (const rt of RESOURCE_TYPES) {
    const tiles = p.tiles[rt] ?? 0;
    if (rt === 'sticker') {
      // sticker faucet = stickerShop self-production (modeled here) + map 铜矿 tiles (level-gated ≥6, NOT yet
      // modeled — this sim only covers home-city economy; see mapgen.ts resTypeFor / SLG_GEN.copperShare).
      out[rt] = Math.round(STICKER_SELF_BASE * p.avgBuildingLevel * 0.5);
    } else {
      out[rt] = Math.round(tiles * RESOURCE_YIELD_BASE * p.avgTileLevel * midMult * nation);
    }
  }
  return out;
}

/** Days to earn the full max-city cost of each resource at a profile's income (income-gated only). */
export function daysToMax(p: IncomeProfile, totals: CityTotals): Partial<Record<ResourceType, number>> {
  const inc = hourlyIncome(p);
  const out: Partial<Record<ResourceType, number>> = {};
  for (const rt of RESOURCE_TYPES) {
    const need = totals.cost[rt] ?? 0;
    const perDay = (inc[rt] ?? 0) * 24;
    out[rt] = perDay > 0 ? need / perDay : Infinity;
  }
  return out;
}

export const INCOME_PROFILES: IncomeProfile[] = [
  { label: 'casual',   tiles: { ink: 4, paper: 8,  graphite: 4, metal: 4 },  avgTileLevel: 2, avgBuildingLevel: 4 },
  { label: 'active',   tiles: { ink: 6, paper: 14, graphite: 6, metal: 6 },  avgTileLevel: 4, avgBuildingLevel: 8 },
  { label: 'hardcore', tiles: { ink: 8, paper: 25, graphite: 10, metal: 10 }, avgTileLevel: 6, avgBuildingLevel: 12 },
];

/** Army-training pacing: time + ink to fill the drillYard-max troop cap, and coin-to-skip. */
export function armyPacing() {
  const maxed: Partial<Record<BuildingKey, number>> = { drillYard: DESK_MAX_LEVEL };
  const cap = troopCapFor(maxed);
  const trainMult = drillTrainMult(maxed);
  const secPerTroop = TROOP_TRAIN_TIME_SEC * trainMult;
  const totalSec = cap * secPerTroop;
  return {
    troopCap: cap,
    inkToFill: cap * TROOP_TRAIN_INK_COST,
    secPerTroop,
    totalTrainSec: totalSec,
    totalTrainHours: totalSec / 3600,
    coinsToSkip: Math.ceil(totalSec / BUILD_SPEEDUP_SECS_PER_COIN),
    seasonDays: SEASON_LENGTH_DAYS,
  };
}
