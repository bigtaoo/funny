import type { Fp } from './math/fixed';

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
  Bottom = 'bottom', // local player — units move toward row 0
  Top = 'top',       // opponent (AI) — units move toward row 18
}

export enum GamePhase {
  Idle    = 'idle',
  Playing = 'playing',
  Paused  = 'paused',
  GameOver = 'gameover',
}

export enum UnitState {
  Moving    = 'moving',
  Attacking = 'attacking',
  Waiting   = 'waiting',   // blocked by friendly unit in front
  Crossing  = 'crossing',  // in transit row, moving horizontally toward base
  Dead      = 'dead',
}

// ─── Coordinates ──────────────────────────────────────────────────────────────

/** Integer grid position. col: 0–7, row: 0–18 */
export interface GridPos {
  col: number;
  row: number;
}

/**
 * Fixed-point position used in game events.
 * col is a plain integer column index (0–7).
 * y_fp is a Fp (row × 1000); rendering layer uses fromFp(y_fp) to get float row.
 */
export interface Vec2_fp {
  col: number;
  y_fp: Fp;
}

// ─── Owner / Side helpers ────────────────────────────────────────────────────

/** Player identifier: 0 = Bottom (local), 1 = Top (AI) */
export type OwnerId = 0 | 1;

export function sideToOwner(side: Side): OwnerId {
  return side === Side.Bottom ? 0 : 1;
}

export function ownerToSide(owner: OwnerId): Side {
  return owner === 0 ? Side.Bottom : Side.Top;
}

// ─── Game config ──────────────────────────────────────────────────────────────

export interface GameConfig {
  /** PRNG seed — determines deck shuffle order for both players. Required. */
  seed: number;
  players: [PlayerConfig, PlayerConfig];
}

export interface PlayerConfig {
  id: OwnerId;
}

// ─── Player commands ──────────────────────────────────────────────────────────

export type PlayerCommand =
  | {
      type: 'play_card';
      owner: OwnerId;
      tick: number;
      handIndex: number;
      col?: number;  // unit/building: target column; spell: center column
      row?: number;  // spell: center row (meteor)
    }
  | {
      type: 'upgrade_base';
      owner: OwnerId;
      tick: number;
    };

// ─── Replay ──────────────────────────────────────────────────────────────────

/** Only non-empty ticks are stored; empty frames are implicitly empty command lists. */
export interface ReplayFrame {
  tick: number;
  commands: PlayerCommand[];
}

export interface Replay {
  seed: number;
  frames: ReplayFrame[];
}

// ─── Data blueprints (immutable, not runtime state) ───────────────────────────

export interface UnitBlueprint {
  type: UnitType;
  hp: number;
  attack: number;
  attackInterval: number; // seconds — converted to ticks in Unit constructor
  speed: number;          // grid/s  — converted to fp   in Unit constructor
  range: number;          // attack range in grid cells (1 = melee)
  spawnCount: number;     // units spawned per card play
  /** Collision radius in pre-scaled fixed-point (e.g. 400 = 0.4 grid). */
  radius_fp: number;
}

export interface BuildingBlueprint {
  type: BuildingType;
  hp: number;
  attack?: number;
  attackInterval?: number;  // seconds — converted to ticks in Building constructor
  attackRange?: number;     // grid cells forward
  spawnUnit?: UnitType;     // barracks only
  spawnInterval?: number;   // seconds — converted to ticks in Building constructor
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

// ─── Active spell effects ─────────────────────────────────────────────────────

export interface ActiveSpell {
  spellType: SpellType;
  side: Side;
  /** Countdown in ticks. Decremented each tick; expires when it reaches 0. */
  remainingTicks: number;
  targetCol?: number;
  targetRow?: number;
}

// ─── Public engine interface ──────────────────────────────────────────────────

export interface IGameEngine {
  /**
   * Advance game state by one logic frame (1/30 s).
   *
   * On the very first call (tick 0), also emits initial state events
   * (card_drawn for both players' starting hands, resource_changed for initial coins).
   *
   * @param tick       Monotonically increasing frame counter (starts at 0).
   * @param commands   All commands bound to this tick (player + any external).
   * @returns          All events produced this frame (drives rendering).
   */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[];

  /**
   * Called every render frame with wall-clock dt (seconds).
   * Internally accumulates time and calls step() at TICK_RATE.
   * The render layer calls this instead of step() directly.
   */
  tick(dt: number): void;

  /** Current game state — read by the render layer after tick(). */
  readonly state: import('./GameState').GameState;

  /** Queue a play_card command for the local player (owner 0). */
  playCard(handIndex: number, col: number, row?: number): void;

  /** Queue an upgrade_base command for the local player (owner 0). */
  upgradeBase(): void;
}

// ─── Game events (logic layer → render layer) ─────────────────────────────────

export type GameEvent =
  // ── Unit lifecycle ─────────────────────────────────────────────────────────
  | { type: 'unit_spawned';
      unitId: number; owner: OwnerId; unitType: UnitType;
      col: number; y_fp: Fp; radius_fp: Fp }

  | { type: 'unit_died';
      unitId: number; pos: Vec2_fp }

  // ── Unit movement (drives client tween) ────────────────────────────────────
  /**
   * Emitted when a unit starts moving.
   * `to` is a best-effort predicted stop; the client may receive unit_move_stop earlier.
   */
  | { type: 'unit_move_start';
      unitId: number; from: Vec2_fp; to: Vec2_fp; speed_fp: Fp }

  /** Emitted when a unit stops. Client snaps to `pos` for authoritative position. */
  | { type: 'unit_move_stop';
      unitId: number; pos: Vec2_fp }

  // ── Combat ─────────────────────────────────────────────────────────────────
  | { type: 'unit_attack_start';
      unitId: number; targetId: number }

  | { type: 'unit_attack_hit';
      unitId: number; targetId: number;
      damage: number; targetHpRemaining: number }

  // ── Buildings ──────────────────────────────────────────────────────────────
  | { type: 'building_placed';
      buildingId: number; owner: OwnerId;
      buildingType: BuildingType; col: number; row: number }

  | { type: 'building_destroyed';
      buildingId: number; pos: Vec2_fp }

  | { type: 'building_spawned_unit';
      buildingId: number; unitId: number }

  // ── Spells ─────────────────────────────────────────────────────────────────
  | { type: 'spell_cast';
      spellType: SpellType; owner: OwnerId; center: Vec2_fp }

  // ── Base ───────────────────────────────────────────────────────────────────
  | { type: 'base_hp_changed';
      owner: OwnerId; hp: number; maxHp: number }

  // ── Resources ──────────────────────────────────────────────────────────────
  | { type: 'resource_changed';
      owner: OwnerId; coins: number }

  // ── Cards ──────────────────────────────────────────────────────────────────
  | { type: 'card_drawn';
      owner: OwnerId; cardType: CardType; handIndex: number }

  | { type: 'card_played';
      owner: OwnerId; handIndex: number }

  // ── Game over ──────────────────────────────────────────────────────────────
  | { type: 'game_over';
      winner: OwnerId };
