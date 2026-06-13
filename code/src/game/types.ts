import type { Fp } from './math/fixed';
import type { TranslationKey } from '../i18n';
import type { LevelDefinition } from './campaign/LevelDefinition';

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum UnitType {
  Swordsman = 'swordsman',
  Guardian = 'guardian',
  Archer = 'archer',
  /** PvE-only heavy: very high HP, very slow, soaks arrow-tower fire. No card → never in the PvP pool. */
  Ironclad = 'ironclad',
  /** PvE-only rusher: fragile, fast, small radius (packs densely). No card → never in the PvP pool. */
  Runner = 'runner',
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
  Bottom = 'bottom', // local player  — row 0 is home; units move toward row 17
  Top = 'top',       // opponent (AI) — row 17 is home; units move toward row 0
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
  Crossing  = 'crossing',  // in building row, moving horizontally toward base cols
  Dead      = 'dead',
}

// ─── Coordinates ──────────────────────────────────────────────────────────────

/** Integer grid position. col: 0–11, row: 0–17 (all 0-indexed) */
export interface GridPos {
  col: number;
  row: number;
}

/**
 * Fixed-point position used in game events.
 * col is a plain integer column index (0–11).
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

/**
 * Game mode.
 *   `pvp`      — duel driven by AISystem (the Top side is the local bot).
 *   `campaign` — PvE scripted waves (WaveDirector).
 *   `netplay`  — online lockstep PvP: BOTH sides are humans, commands for both
 *                arrive (pre-confirmed, per frame) from the `NetInputSource`.
 *                No local AI and no WaveDirector run — the engine only processes
 *                the confirmed command set, so two clients on the same seed +
 *                same frame stream stay byte-identical (S1-7).
 */
export type GameMode = 'pvp' | 'campaign' | 'netplay';

export interface GameConfig {
  /** PRNG seed — determines card draws for both players. Required. */
  seed: number;
  players: [PlayerConfig, PlayerConfig];
  /** Defaults to 'pvp'. In 'campaign' the enemy is driven by a WaveDirector. */
  mode?: GameMode;
  /** Campaign level — required when mode === 'campaign'. */
  level?: LevelDefinition;
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

// ─── Replay (S1-RP / META_DESIGN §6.6, SERVER_API §6) ──────────────────────────

/**
 * Engine logic version a replay is bound to. **Bump whenever a change to the
 * deterministic core (`game/`) could make an old recorded stream diverge on
 * playback** — `ReplayInputSource` refuses to drive an engine if the replay's
 * `engineVersion` differs, so a mismatch fails loudly instead of replaying garbage.
 */
export const ENGINE_VERSION = 1;

/**
 * One recorded tick. Sparse: only ticks whose confirmed command set is
 * non-empty are stored; any tick absent from `frames` replays as an empty
 * command list. `tick` equals the frame the engine consumed the commands at
 * (each command's own `tick` field matches), so playback re-feeds them verbatim.
 */
export interface ReplayFrame {
  tick: number;
  commands: PlayerCommand[];
}

/**
 * A complete recording: **seed + config + input stream, never any state** — the
 * deterministic core reconstructs every frame by re-feeding the stream into a
 * fresh engine on the same seed. Field names mirror `replay.proto` (the future
 * server-side persistence form); the client keeps commands as typed objects
 * (JSON-serialisable) rather than opaque proto bytes for v1 local recording.
 *
 * PvE records only the player's commands (the enemy `WaveDirector` regenerates
 * from seed+level on playback); PvP/netplay records both sides' confirmed sets.
 */
export interface Replay {
  /** Validated against {@link ENGINE_VERSION} before playback. */
  engineVersion: number;
  /** Engine mode the recording ran under — playback must rebuild the same mode. */
  mode: GameMode;
  seed: number;
  /** Config provenance (PvE = levelId; PvP = roster version). Optional. */
  configRef?: string;
  /** Non-empty ticks only, ascending by `tick`. */
  frames: ReplayFrame[];
  /** Total frame count (last executed tick + 1) — bounds playback; empty tail frames are not stored. */
  endFrame: number;
  /** Optional human-facing metadata (recorded time, players, result …). */
  meta?: ReplayMeta;
}

export interface ReplayMeta {
  /** Unix ms when the recording finished. */
  recordedAt?: number;
  /** Campaign level id, when applicable. */
  levelId?: string;
  /** Winning side (0 bottom / 1 top), -1 = draw/unknown. */
  winner?: number;
  [key: string]: unknown;
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
  /** i18n key for the display name — render layer resolves it via t() */
  nameKey: TranslationKey;
  /** i18n key for the card description (reserved for deck screen / detail popup) */
  descKey: TranslationKey;
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

// ─── End-of-game stats (per player) ──────────────────────────────────────────

export interface PlayerStats {
  owner: OwnerId;
  /** Total damage dealt to the enemy base → 最佳输出 */
  damageDealtToBase: number;
  /** Total damage taken by own base → 铁壁防线 */
  damageTakenByBase: number;
  /** Total units sent (card plays + barracks spawns) → 兵海战术 */
  unitsSent: number;
  /** Enemy units killed → 以少胜多 reference */
  unitsKilled: number;
  /** Enemy units hit by spells → 精准打击 */
  spellHits: number;
  /** Sum of survival ticks across all own buildings → 建筑大师 */
  buildingSurvivalTicks: number;
  /** Total gold spent (cards + upgrades) → 以少胜多 reference */
  goldSpent: number;
}

// ─── Public engine interface ──────────────────────────────────────────────────

export interface IGameEngine {
  /**
   * Advance game state by one logic frame (1/30 s).
   *
   * On the very first call (tick 0), also emits initial state events
   * (card_drawn for both players' starting hands, resource_changed for initial ink).
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

  | { type: 'building_hp_changed';
      buildingId: number; hp: number; maxHp: number }

  | { type: 'building_destroyed';
      buildingId: number; col: number; row: number }

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
      owner: OwnerId; ink: number }

  // ── Cards ──────────────────────────────────────────────────────────────────
  | { type: 'card_drawn';
      owner: OwnerId; cardType: CardType; handIndex: number;
      /** Total refresh countdown for this card (ticks). Drives the eraser animation. */
      refreshDurationTicks: number }

  | { type: 'card_played';
      owner: OwnerId; handIndex: number }

  /** Emitted when a card auto-expires (2 min unused). Always followed by card_drawn. */
  | { type: 'card_expired';
      owner: OwnerId; handIndex: number }

  // ── Phase changes ──────────────────────────────────────────────────────────
  /** Emitted once when 15-min countdown starts (2 min left). */
  | { type: 'game_countdown_start' }

  // ── Game over ──────────────────────────────────────────────────────────────
  /** Emitted on the same frame as game_over or game_draw. */
  | { type: 'game_stats';
      stats: [PlayerStats, PlayerStats] }

  | { type: 'game_over';
      winner: OwnerId }

  /** Emitted at 17 min when the game ends in a draw (both players survive). */
  | { type: 'game_draw' };
