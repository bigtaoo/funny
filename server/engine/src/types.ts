import type { Fp } from './math/fixed';
import type { LevelDefinition } from './campaign/LevelDefinition';
// Type-only reference (erased at compile time) → does not create a runtime cycle with balance/equipment.ts's runtime reference to UnitType.
import type { EngineCardInstance, EngineEquipInv } from './balance/equipment';

// i18n display keys are plain strings inside the engine — the simulation never
// resolves them. The render/UI layer (client) re-narrows them to TranslationKey
// and owns the i18n completeness check. See SLG_DESIGN §16.7 koan #2.
type TranslationKey = string;

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum UnitType {
  Infantry = 'infantry',
  ShieldBearer = 'shieldbearer',
  Archer = 'archer',
  /** PvE-only heavy: very high HP, very slow, soaks arrow-tower fire. No card → never in the PvP pool. */
  Ironclad = 'ironclad',
  /** PvE-only rusher: fragile, fast, small radius (packs densely). No card → never in the PvP pool. */
  Runner = 'runner',
  /** PvE-only flying unit: fast, fragile, bypasses ground collision and blocked cells.
   *  Only arrow towers and archer units (canTargetFlying) can hit it. No card → never in PvP. */
  Harpy = 'harpy',
  /** PvE-only support: no attack, emits an aura_heal aura that regenerates nearby ally HP.
   *  Must be prioritised or killed before engaging the main force. No card → never in PvP. */
  Medic = 'medic',
  /** PvE-only rage brawler: normal stats, but attack speed ×1.5 when HP falls below 40%.
   *  Killing it quickly is better than letting it rage. No card → never in PvP. */
  Berserker = 'berserker',
  /** PvE-only bomb unit: dies and spawns 2 Runners, making it worse to ignore.
   *  Kill it with area damage or it becomes a swarm on death. No card → never in PvP. */
  Splitter = 'splitter',
  /** Anna-side vanguard: burstOnSingle deals 2× damage when only one enemy remains. Unlocked via PvE ch2. */
  Max = 'max',
  /** Anna-side sentinel: disciplineArmor=8 reduces every hit by 8 (min 1). Unlocked via PvE ch4. */
  Lena = 'lena',
  /** Anna-side skirmisher: markEnemies marks targets for +25 % bonus damage from all sources. Unlocked via PvE ch6. */
  Mara = 'mara',
}

export enum BuildingType {
  Barracks = 'barracks',
  ArrowTower = 'arrow_tower',
}

export enum SpellType {
  Haste = 'haste',
  Meteor = 'meteor',
  Rockslide = 'rockslide',
  BridgeCollapse = 'bridge_collapse',
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
  Detour    = 'detour',   // mid-lane horizontal redirect (crossWaypoints / blocked auto-detour)
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
 *   `siege`    — SLG siege battle (S8-3): mechanically identical to `campaign` (the
 *                defender is a scripted `WaveDirector` from a defense-config
 *                `LevelDefinition`, the local player is the attacker), differing
 *                ONLY in the blueprint source — `buildSiegeBlueprints(pveUpgrades)`
 *                instead of `buildCampaignBlueprints`. Same upgrade tree feeds
 *                both PvE and SLG (SLG_DESIGN §6.2); the PvP hard wall is untouched
 *                because `buildPvpBlueprints()` has no upgrade param (§6.1).
 *   `netplay`  — online lockstep PvP: BOTH sides are humans, commands for both
 *                arrive (pre-confirmed, per frame) from the `NetInputSource`.
 *                No local AI and no WaveDirector run — the engine only processes
 *                the confirmed command set, so two clients on the same seed +
 *                same frame stream stay byte-identical (S1-7).
 */
export type GameMode = 'pvp' | 'campaign' | 'netplay' | 'siege';

export interface GameConfig {
  /** PRNG seed — determines card draws for both players. Required. */
  seed: number;
  players: [PlayerConfig, PlayerConfig];
  /** Defaults to 'pvp'. In 'campaign' the enemy is driven by a WaveDirector. */
  mode?: GameMode;
  /** Campaign level — required when mode === 'campaign'. */
  level?: LevelDefinition;
  /**
   * Hero Roster card instances (CC-1, CHARACTER_CARDS_DESIGN §2), read ONLY on the PvE-shaped paths
   * (campaign / siege). The hard wall (§5.2): `buildPvpBlueprints()` has no card param,
   * so card progression can't leak into ladder/duel PvP. Pass SaveData.cardInv values with resolved unitType.
   */
  cardInstances?: EngineCardInstance[];
  /**
   * Equipment instance inventory (SaveData.equipmentInv), read ONLY on the PvE-shaped paths (campaign / siege).
   * Used by applyEquipment to resolve gear slot instance IDs within each CardInstance.
   * Same hard wall: buildPvpBlueprints() has no equipment param → PvP equipment contamination is impossible at compile time.
   */
  equipmentInv?: EngineEquipInv;
  /**
   * PvP/netplay deck loadouts (PVP_LOADOUT_DESIGN §6.2).
   * When provided, each player draws only from their specified card subset
   * (filtered against CARD_DEFINITIONS by card id).
   * Server-authoritative: both clients receive identical decks via match_start,
   * guaranteeing lockstep draw consistency. Omit to use the full pool (P1 default).
   */
  decks?: { top: string[]; bottom: string[] };
  /**
   * Academy building seasonal blueprint buffs (SLG_CITY_DESIGN P2 §5): applied only on the 'siege' path
   * as a fractional bonus on top of pveUpgrades. Ignored by PvP/campaign/netplay.
   * {hp: 0.06, damage: 0.045} = +6% HP, +4.5% damage to all attacker units.
   */
  siegeAcademy?: { hp: number; damage: number };
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
    }
  | {
      type: 'refresh_hand';
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
export const ENGINE_VERSION = 2;
// v2 (projectile system): ranged attacks (archer / arrow tower) no longer apply
// instant damage — they spawn a homing projectile that travels and resolves
// damage on impact (config.ts `projectile` flag). This shifts combat timing, so
// any v1 replay would diverge on playback → bump forces a loud version mismatch.

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

// ─── Trait system (§4.4b–c) ──────────────────────────────────────────────────

/** Extensible slot-based trait descriptors (aura effects, etc.). */
export type TraitSpec =
  | { type: 'aura_heal'; radius: number; hps: number };

// ─── Data blueprints (immutable, not runtime state) ───────────────────────────

/**
 * Projectile spec (ranged attacks). When present on a unit/building blueprint,
 * an attack no longer applies instant damage — it spawns a homing projectile
 * that travels at `speed` grid/s and resolves damage when it reaches the target
 * (CombatSystem.tickProjectiles). Absent ⇒ instant melee-style hit (unchanged).
 */
export interface ProjectileSpec {
  /** Flight speed in grid cells/second (converted to fp/tick in the constructor). */
  speed: number;
  /** Visual kind key — the render layer narrows it to a sprite (e.g. 'arrow'). */
  kind: string;
}

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

  // ── Ranged attack (projectile) ─────────────────────────────────────────────
  /** Ranged units fire a homing projectile instead of dealing instant damage. */
  projectile?: ProjectileSpec;

  // ── Flying system (§4.4b) ──────────────────────────────────────────────────
  flying?: boolean;
  canTargetFlying?: boolean;   // archers = true; melee = false

  // ── Defensive traits ───────────────────────────────────────────────────────
  armor?: number;               // flat damage reduction per hit (min 1 damage)
  taunt?: boolean;              // enemy findTarget prefers this unit
  undying?: boolean;            // survive first lethal hit at 1 HP (PvE)
  berserkerThreshold?: number;  // HP fraction 0–1; attack speed ×1.5 when HP < threshold

  // ── Offensive traits (PvE) ────────────────────────────────────────────────
  onDeathSpawn?: { type: UnitType; count: number };
  /** Crit chance 0–100; on a roll under it, damage ×critMult (unit progression T3). 0/undefined = no crit. */
  critPct?: number;
  /** Crit damage multiplier when a crit lands (default 1 = no bonus). */
  critMult?: number;
  splashRadius?: number;        // Chebyshev radius of splash damage (0 = no splash)
  piercing?: boolean;           // hit all enemies in same column
  slowOnHit?: { mult: number; durationSec: number };

  // ── Sustain traits (PvE) ──────────────────────────────────────────────────
  regenPerSec?: number;
  lifestealPct?: number;        // 0–100; heal self by % of damage dealt
  traits?: TraitSpec[];

  // ── Special traits (PvE) ──────────────────────────────────────────────────
  stealth?: boolean;            // invisible to findTarget at Chebyshev dist > 2
  summonOnTimer?: { type: UnitType; intervalSec: number };

  // ── Anna-side unit traits (A6) ────────────────────────────────────────────
  /** 2× damage when only one live enemy remains on target side (Max). */
  burstOnSingle?: boolean;
  /** Marks the target on hit; marked units take +25 % damage from all sources for 3 s (Mara). */
  markEnemies?: boolean;
}

export interface BuildingBlueprint {
  type: BuildingType;
  hp: number;
  attack?: number;
  attackInterval?: number;  // seconds — converted to ticks in Building constructor
  attackRange?: number;     // grid cells forward
  spawnUnit?: UnitType;     // barracks only
  spawnInterval?: number;   // seconds — converted to ticks in Building constructor
  canTargetFlying?: boolean;
  /** Ranged defenders (arrow tower) fire a homing projectile instead of instant damage. */
  projectile?: ProjectileSpec;
  /** Flat damage reduction per hit; absorbed damage minimum 1. */
  armor?: number;
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
  /** Total damage dealt to the enemy base → best output */
  damageDealtToBase: number;
  /** Total damage taken by own base → iron wall defense */
  damageTakenByBase: number;
  /** Total units sent (card plays + barracks spawns) → swarm tactics */
  unitsSent: number;
  /** Enemy units killed → underdog reference */
  unitsKilled: number;
  /** Enemy units hit by spells → precision strike */
  spellHits: number;
  /**
   * Per-victim-type kill counts (S9-3b). Feeds achievement statKeys `kill.archer`/`kill.guard`.
   * Deterministic (same replay → same counts). Absent types = 0 (sparse map).
   */
  killsByType: Partial<Record<UnitType, number>>;
  /**
   * Per-spell-type cast counts (S9-3b) — one per cast call, not per hit. Feeds `cast.meteor`.
   * Deterministic; absent types = 0.
   */
  castsByType: Partial<Record<SpellType, number>>;
  /** Sum of survival ticks across all own buildings → master builder */
  buildingSurvivalTicks: number;
  /** Total gold spent (cards + upgrades) → underdog reference */
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

  /** Queue a refresh_hand command for the local player (owner 0). */
  refreshHand(): void;
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
