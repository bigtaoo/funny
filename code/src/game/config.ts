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

/** 0-indexed cols occupied by bases (cols 4–5 in 1-indexed notation) */
export const BASE_COLS = [3, 4] as const;

/** 0-indexed attack lanes (cols 1-3 and 6-8 in 1-indexed notation) */
export const ATTACK_LANES = [0, 1, 2, 5, 6, 7] as const;

/** Building row for bottom player (row 2 in diagram) */
export const BOTTOM_BUILDING_ROW = 2;
/** Building row for top player (row 16 in diagram) */
export const TOP_BUILDING_ROW = 16;

/** Unit spawn row for bottom player (just above building row) */
export const BOTTOM_SPAWN_ROW = 3;
/** Unit spawn row for top player (just below enemy building row) */
export const TOP_SPAWN_ROW = 15;

// ─── Resource ─────────────────────────────────────────────────────────────────

export const COIN_REGEN_BASE = 2;      // coins per second
export const COIN_CAP = 30;
export const BASE_UPGRADE_COSTS = [50, 100, 200] as const;
export const BASE_UPGRADE_REGEN_BONUS = 1; // +1/s per upgrade level

// ─── Time acceleration ────────────────────────────────────────────────────────

export const ACCEL_THRESHOLD_1 = 180; // 3 min → ×1.5
export const ACCEL_THRESHOLD_2 = 360; // 6 min → ×2.0
export const ACCEL_MULT_1 = 1.5;
export const ACCEL_MULT_2 = 2.0;

// ─── Hand / deck ──────────────────────────────────────────────────────────────

export const HAND_SIZE = 6;

// ─── Base HP ──────────────────────────────────────────────────────────────────

export const BASE_HP = 100;

// ─── Unit blueprints ──────────────────────────────────────────────────────────

export const UNIT_BLUEPRINTS: Record<UnitType, UnitBlueprint> = {
  [UnitType.Swordsman]: {
    type: UnitType.Swordsman,
    hp: 60,
    attack: 12,
    attackInterval: 1.0,
    speed: 1.0,
    range: 1,
    spawnCount: 2,
  },
  [UnitType.Guardian]: {
    type: UnitType.Guardian,
    hp: 150,
    attack: 8,
    attackInterval: 1.5,
    speed: 0.6,
    range: 1,
    spawnCount: 1,
  },
  [UnitType.Archer]: {
    type: UnitType.Archer,
    hp: 35,
    attack: 18,
    attackInterval: 2.0,
    speed: 0.8,
    range: 3,
    spawnCount: 1,
  },
};

// ─── Building blueprints ──────────────────────────────────────────────────────

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
  [BuildingType.Barracks]: {
    type: BuildingType.Barracks,
    hp: 200,
    spawnUnit: UnitType.Swordsman,
    spawnInterval: 4,
  },
  [BuildingType.ArrowTower]: {
    type: BuildingType.ArrowTower,
    hp: 120,
    attack: 15,
    attackInterval: 1.5,
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

export const HASTE_DURATION = 5;     // seconds
export const HASTE_SPEED_MULT = 2;
export const METEOR_DAMAGE = 9999;   // clears a 2×2 area
