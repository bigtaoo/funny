// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Game events (logic layer → render layer): the single discriminated union every system emits
// from and the render layer switches on.
import type { Fp } from '../math/fixed';
import type { OwnerId, Vec2_fp } from './coords';
import type { UnitType, BuildingType, SpellType, CardType } from './enums';
import type { PlayerStats, MatchSummary } from './runtime';

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

  // ── Projectiles (ranged attacks) ─────────────────────────────────────────────
  /** A homing projectile was launched. Render spawns an arrow at `from`, then
   *  follows the authoritative per-tick `projectile_moved` positions. */
  | { type: 'projectile_fired';
      projectileId: number; attackerId: number; from: Vec2_fp; kind: string }

  /** Authoritative projectile position this tick (mirrors escort_moved). */
  | { type: 'projectile_moved';
      projectileId: number; col_fp: Fp; y_fp: Fp }

  /** Projectile reached its target and resolved damage (unit_attack_hit fires the
   *  same tick). Render removes the arrow + the hit VFX plays on the target. */
  | { type: 'projectile_hit';
      projectileId: number }

  /** Projectile's target vanished (died / removed) before impact — it fizzles
   *  with no damage. Render removes the arrow. */
  | { type: 'projectile_expired';
      projectileId: number }

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

  /** Emitted once when a base upgrade succeeds. `level` is the new upgradeLevel.
   *  The persistent tier texture is reconciled from `player.upgradeLevel` via
   *  BoardView.setBaseUpgradeLevel each frame; this event only triggers the
   *  one-shot celebratory "level-up" flash. */
  | { type: 'base_upgraded';
      owner: OwnerId; level: number }

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
      stats: [PlayerStats, PlayerStats];
      /** Match-level summary for composite star scoring (STAR_SCORING.md). */
      summary: MatchSummary }

  | { type: 'game_over';
      winner: OwnerId }

  /** Emitted at 17 min when the game ends in a draw (both players survive). */
  | { type: 'game_draw' }

  // ── Escort units (§4.9.3) ──────────────────────────────────────────────────
  /** Emitted once at game start for each escort defined in the level. */
  | { type: 'escort_spawned';
      escortId: string; col_fp: Fp; row_fp: Fp; hp: number; maxHp: number }

  /** Emitted every tick while the escort is moving (renderer tracks smooth position). */
  | { type: 'escort_moved';
      escortId: string; col_fp: Fp; row_fp: Fp }

  /** Emitted when an escort takes damage. */
  | { type: 'escort_hp_changed';
      escortId: string; hp: number; maxHp: number }

  /** Emitted when an escort's HP reaches 0 — it is gone and cannot arrive. */
  | { type: 'escort_died';
      escortId: string }

  /** Emitted when an escort reaches TOP_BUILDING_ROW (or the last waypoint). */
  | { type: 'escort_arrived';
      escortId: string };
