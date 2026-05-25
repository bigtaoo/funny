// ─── Enums ────────────────────────────────────────────────────────────────────

export enum UnitType {
  Swordsman = 'swordsman',
  Guardian = 'guardian',
  Archer = 'archer',
}

export enum BuildingType {
  Barracks = 'barracks',
  ArrowTower = 'arrow_tower',
}

export enum SpellType {
  Haste = 'haste',
  Meteor = 'meteor',
}

export enum CardType {
  Unit = 'unit',
  Building = 'building',
  Spell = 'spell',
}

export enum Side {
  Bottom = 'bottom', // local player, units move upward (row increases)
  Top = 'top',       // opponent (AI), units move downward (row decreases)
}

export enum GamePhase {
  Idle = 'idle',
  Playing = 'playing',
  Paused = 'paused',
  GameOver = 'gameover',
}

export enum UnitState {
  Moving = 'moving',
  Attacking = 'attacking',
  Waiting = 'waiting',   // blocked by friendly unit
  Crossing = 'crossing', // in transit row, moving horizontally
  Dead = 'dead',
}

// ─── Coordinates ──────────────────────────────────────────────────────────────

/** Grid position. col: 0-7, row: 0-18 (0 and 18 are transit rows) */
export interface GridPos {
  col: number;
  row: number;
}

// ─── Stats blueprints (immutable data, not runtime state) ─────────────────────

export interface UnitBlueprint {
  type: UnitType;
  hp: number;
  attack: number;
  attackInterval: number; // seconds
  speed: number;          // grid cells per second
  range: number;          // grid cells (1 = melee)
  spawnCount: number;     // how many units per card play
}

export interface BuildingBlueprint {
  type: BuildingType;
  hp: number;
  attack?: number;
  attackInterval?: number; // seconds
  attackRange?: number;    // grid cells forward
  spawnUnit?: UnitType;    // barracks only
  spawnInterval?: number;  // seconds
}

export interface CardDefinition {
  id: string;
  name: string;
  cardType: CardType;
  cost: number;
  unitType?: UnitType;
  buildingType?: BuildingType;
  spellType?: SpellType;
}

// ─── Active spell effects ──────────────────────────────────────────────────────

export interface ActiveSpell {
  spellType: SpellType;
  side: Side;
  remainingTime: number; // seconds
  targetCol?: number;    // meteor center col
  targetRow?: number;    // meteor center row
}
