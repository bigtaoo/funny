import { FP_SCALE, TICK_RATE } from './math/fixed';
import {
  BuildingType,
  CardType,
  SpellType,
  UnitType,
  type BuildingBlueprint,
  type CardDefinition,
  type UnitBlueprint,
} from './types';

// ─── Board layout ─────────────────────────────────────────────────────────────

export const BOARD_COLS = 8;
export const BOARD_ROWS = 19; // rows 0–18; rows 0 and 18 are transit rows

/** Row 0: transit zone — bottom player's units reach here before hitting top base */
export const TOP_TRANSIT_ROW = 0;
/** Row 18: transit zone — top player's units reach here before hitting bottom base */
export const BOTTOM_TRANSIT_ROW = 18;

/** 0-indexed cols occupied by bases */
export const BASE_COLS = [3, 4] as const;

/** 0-indexed attack lanes */
export const ATTACK_LANES = [0, 1, 2, 5, 6, 7] as const;

/** Building row for bottom player (near row 18 = bottom of screen) */
export const BOTTOM_BUILDING_ROW = 16;
/** Building row for top player (near row 0 = top of screen) */
export const TOP_BUILDING_ROW = 2;

/** Unit spawn row for bottom player (just inside building row, toward center) */
export const BOTTOM_SPAWN_ROW = 15;
/** Unit spawn row for top player */
export const TOP_SPAWN_ROW = 3;

// ─── Resource ─────────────────────────────────────────────────────────────────

export const COIN_REGEN_BASE = 2;      // coins / second (reference only)
export const COIN_CAP = 30;
export const BASE_UPGRADE_COSTS = [50, 100, 200] as const;
export const BASE_UPGRADE_REGEN_BONUS = 1; // +1 coin/s per upgrade level

// ─── Tick-based coin regen (integer fp per tick, no floats) ──────────────────
//
//  Normal  : COIN_REGEN_BASE coins/s           = trunc(2 * 1000 / 30)     =  66 fp/tick
//  Accel×1.5: COIN_REGEN_BASE * 1.5 coins/s   = trunc(2 * 1000 * 3 / 60) = 100 fp/tick
//  Accel×2  : COIN_REGEN_BASE * 2   coins/s   = trunc(2 * 1000 * 2 / 30) = 133 fp/tick
//  Upgrade bonus: +1 coin/s per level          = trunc(1 * 1000 / 30)     =  33 fp/tick
//
// Regen fp/tick per coin/s of regen rate, at each acceleration phase.
// Used to compute per-player regen: rate_per_tick * coinRegenRate(coins/s)
// Normal  (×1  ): trunc(1 * 1000 / 30)         =  33 fp / (coin/s) / tick
// Accel×1.5     : trunc(1 * 1000 * 3 / 60)     =  50 fp / (coin/s) / tick
// Accel×2       : trunc(1 * 1000 * 2 / 30)     =  66 fp / (coin/s) / tick
export const REGEN_FP_PER_COIN_PER_S_NORMAL = Math.trunc(FP_SCALE          / TICK_RATE);           // 33
export const REGEN_FP_PER_COIN_PER_S_ACCEL1 = Math.trunc(FP_SCALE * 3      / (TICK_RATE * 2));     // 50
export const REGEN_FP_PER_COIN_PER_S_ACCEL2 = Math.trunc(FP_SCALE * 2      / TICK_RATE);           // 66

// ─── Time acceleration (tick thresholds) ─────────────────────────────────────
//
//  0–3 min   normal     ×1.0
//  3–6 min   accel 1    ×1.5
//  6–10 min  accel 2    ×2.0
//  10–13 min accel 3    ×4.0
//  13 min+   all-unit attack ×2
//  15 min    countdown starts
//  17 min    force draw

export const ACCEL_THRESHOLD_1        = 180; // seconds (reference only)
export const ACCEL_THRESHOLD_2        = 360; // seconds (reference only)
export const ACCEL_THRESHOLD_3        = 600; // seconds (reference only)
export const ACCEL_THRESHOLD_1_TICKS  = ACCEL_THRESHOLD_1 * TICK_RATE; // 5400
export const ACCEL_THRESHOLD_2_TICKS  = ACCEL_THRESHOLD_2 * TICK_RATE; // 10800
export const ACCEL_THRESHOLD_3_TICKS  = ACCEL_THRESHOLD_3 * TICK_RATE; // 18000

// Accel ×4.0: trunc(4 * 1000 / 30) = 133 fp / (coin/s) / tick
export const REGEN_FP_PER_COIN_PER_S_ACCEL3 = Math.trunc(FP_SCALE * 4 / TICK_RATE); // 133

export const ATTACK_MULT_THRESHOLD        = 780; // 13 min (seconds, reference only)
export const ATTACK_MULT_THRESHOLD_TICKS  = ATTACK_MULT_THRESHOLD * TICK_RATE; // 23400
/** All-unit attack multiplier applied after ATTACK_MULT_THRESHOLD_TICKS. */
export const ATTACK_MULT_LATE_GAME        = 2;

export const COUNTDOWN_THRESHOLD        = 900;  // 15 min (seconds, reference only)
export const COUNTDOWN_THRESHOLD_TICKS  = COUNTDOWN_THRESHOLD * TICK_RATE; // 27000

export const FORCE_DRAW_THRESHOLD        = 1020; // 17 min (seconds, reference only)
export const FORCE_DRAW_THRESHOLD_TICKS  = FORCE_DRAW_THRESHOLD * TICK_RATE; // 30600

// ─── Crossing (horizontal transit) ───────────────────────────────────────────
//
//  Units move 1 column every CROSSING_INTERVAL_TICKS ticks.
//  CROSSING_COLS_PER_S = 2  →  interval = round(30 / 2) = 15 ticks/col

export const CROSSING_COLS_PER_S      = 2;
export const CROSSING_INTERVAL_TICKS  = Math.round(TICK_RATE / CROSSING_COLS_PER_S); // 15

// ─── Hand / deck ──────────────────────────────────────────────────────────────

export const HAND_SIZE = 6;

// ─── Base HP ──────────────────────────────────────────────────────────────────

export const BASE_HP = 100;

// ─── Building tick intervals ──────────────────────────────────────────────────
//
//  Barracks spawn interval : 4 s   → 4 * 30 = 120 ticks
//  Arrow tower attack      : 1.5 s → round(1.5 * 30) = 45 ticks
//
export const BARRACKS_SPAWN_INTERVAL_TICKS     = 4 * TICK_RATE;                   // 120
export const ARROW_TOWER_ATTACK_INTERVAL_TICKS = Math.round(1.5 * TICK_RATE);     // 45

// ─── Spell tick durations ─────────────────────────────────────────────────────

export const HASTE_DURATION_TICKS = 5 * TICK_RATE;  // 150 ticks

// ─── Unit blueprints ──────────────────────────────────────────────────────────

export const UNIT_BLUEPRINTS: Record<UnitType, UnitBlueprint> = {
  [UnitType.Swordsman]: {
    type: UnitType.Swordsman,
    hp: 60,
    attack: 12,
    attackInterval: 1.0,  // seconds (converted to ticks in Unit constructor)
    speed: 1.0,           // grid/s  (converted to fp in Unit constructor)
    range: 1,
    spawnCount: 2,
    radius_fp: 400,
  },
  [UnitType.Guardian]: {
    type: UnitType.Guardian,
    hp: 150,
    attack: 8,
    attackInterval: 1.5,
    speed: 0.6,
    range: 1,
    spawnCount: 1,
    radius_fp: 450,
  },
  [UnitType.Archer]: {
    type: UnitType.Archer,
    hp: 35,
    attack: 18,
    attackInterval: 2.0,
    speed: 0.8,
    range: 3,
    spawnCount: 1,
    radius_fp: 350,
  },
};

// ─── Building blueprints ──────────────────────────────────────────────────────

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
  [BuildingType.Barracks]: {
    type: BuildingType.Barracks,
    hp: 200,
    spawnUnit: UnitType.Swordsman,
    spawnInterval: 4,         // seconds (converted to ticks in Building constructor)
  },
  [BuildingType.ArrowTower]: {
    type: BuildingType.ArrowTower,
    hp: 120,
    attack: 15,
    attackInterval: 1.5,      // seconds (converted to ticks in Building constructor)
    attackRange: 3,
  },
};

// ─── Card definitions (12-card pool) ─────────────────────────────────────────

export const CARD_DEFINITIONS: CardDefinition[] = [
  { id: 'swordsman_1', name: '普通兵',   cardType: CardType.Unit,     cost: 4,  unitType: UnitType.Swordsman       },
  { id: 'swordsman_2', name: '普通兵',   cardType: CardType.Unit,     cost: 4,  unitType: UnitType.Swordsman       },
  { id: 'guardian_1',  name: '盾兵',     cardType: CardType.Unit,     cost: 6,  unitType: UnitType.Guardian        },
  { id: 'guardian_2',  name: '盾兵',     cardType: CardType.Unit,     cost: 6,  unitType: UnitType.Guardian        },
  { id: 'archer_1',    name: '弓箭兵',   cardType: CardType.Unit,     cost: 5,  unitType: UnitType.Archer          },
  { id: 'archer_2',    name: '弓箭兵',   cardType: CardType.Unit,     cost: 5,  unitType: UnitType.Archer          },
  { id: 'barracks_1',  name: '兵营',     cardType: CardType.Building, cost: 10, buildingType: BuildingType.Barracks   },
  { id: 'barracks_2',  name: '兵营',     cardType: CardType.Building, cost: 10, buildingType: BuildingType.Barracks   },
  { id: 'tower_1',     name: '箭塔',     cardType: CardType.Building, cost: 12, buildingType: BuildingType.ArrowTower },
  { id: 'tower_2',     name: '箭塔',     cardType: CardType.Building, cost: 12, buildingType: BuildingType.ArrowTower },
  { id: 'haste_1',     name: '急速冲锋', cardType: CardType.Spell,    cost: 8,  spellType: SpellType.Haste         },
  { id: 'meteor_1',    name: '陨石打击', cardType: CardType.Spell,    cost: 12, spellType: SpellType.Meteor        },
];

// ─── Spell parameters ─────────────────────────────────────────────────────────

export const HASTE_SPEED_MULT = 2;    // integer multiplier — used with scaleFp()
export const METEOR_DAMAGE    = 9999; // one-shots anything in 2×2 area
