import type { BuildingType, UnitType } from '../types';

// i18n keys are plain strings in the engine (see SLG_DESIGN §16.7 koan #2);
// the client re-narrows to TranslationKey at the render boundary.
type TranslationKey = string;

/**
 * Campaign (PvE) data model — pure data, no PIXI, no runtime state.
 *
 * A LevelDefinition fully describes one PvE level: its fixed seed (for
 * deterministic replay / same-seed challenges), win objective, and the
 * scripted enemy wave timeline. The enemy (owner 1 / Top side) is driven by
 * {@link WaveDirector} from `waves` instead of the threat AI.
 *
 * Forward-compatible fields (board.cellMask / startInk / hazards / rewards /
 * story) are typed here per CAMPAIGN_DESIGN.md but only `seed` / `objective` /
 * `waves` are consumed in the P0 validation slice; the rest are wired in later
 * steps (depth knobs, economy, meta systems).
 */
export interface LevelDefinition {
  /** Stable id, e.g. 'ch1_lv1'. */
  id: string;
  /** Chapter index (≈ one protagonist's story line). */
  chapter: number;
  /** Fixed PRNG seed — deterministic level (replay / same-seed challenge). */
  seed: number;
  /** Win/lose objective. */
  objective: ObjectiveSpec;
  /** Scripted enemy wave timeline. */
  waves: WaveScript;

  // ── Reserved for later steps (typed now, not yet consumed in P0) ──────────
  /** Board shaping: disabled lanes / non-buildable / impassable cells (§4.1). */
  board?: {
    activeLanes?: number[];
    cellMask?: { blocked?: Cell[]; noBuild?: Cell[] };
    /** Per-column lane shortening (§4.9.1). spawnRow = BOARD_ROWS − laneLength[col]. */
    laneLength?: Record<string, number>;
  };
  /** Per-cell hazards: speed bands, fog, lava, etc. (§4.5). */
  hazards?: HazardSpec[];
  /** Override starting ink / regen for puzzle-style economy constraints (§4.7). */
  startInk?: number;
  inkRegenMult?: number;
  /** Pre-level loadout / banned cards (§4.7). */
  loadout?: string[];
  bannedCards?: string[];
  /** PvE-only level spells force-injected into the player's opening hand (§4.9.2). */
  levelSpells?: { cardId: string; initialCount: number }[];
  /** Friendly escort units the player must protect to the enemy base (§4.9.3). */
  escorts?: EscortSpec[];
  /**
   * SLG defense config (U10): pre-placed units on the defender (Top) side at game start.
   * Units are positioned mid-field in their lanes — not spawned at the top spawn row.
   * Valid for 'siege' mode; ignored in 'campaign'.
   */
  garrison?: GarrisonEntry[];
  /**
   * SLG siege battle (G3, §16): the attacker's pre-deployed army on the attacker
   * (Bottom / owner 0) half. Mirror of {@link garrison} for the lower side — units
   * are placed at their (col,row) and auto-advance toward the enemy base on the
   * first tick (no live card play). Valid for 'siege' mode; ignored in 'campaign'.
   */
  attackerArmy?: GarrisonEntry[];
  /**
   * SLG siege battle (G3, §16): hard time limit in ticks. When the battle reaches
   * this many elapsed ticks with both bases still standing, the defender (Top /
   * owner 1) wins — "防守占优". Safety net against zero-damage stalemates and a
   * compute cap for headless authoritative runs. Valid for 'siege' mode.
   */
  battleTimeoutTicks?: number;
  /**
   * SLG defense config (U10): pre-placed buildings on the defender's (Top) building row.
   * Lets the defender start with turrets / barracks without needing to spend ink.
   * Valid for 'siege' mode; ignored in 'campaign'.
   */
  defenderBuildings?: DefenderBuildingEntry[];
  /**
   * SLG defense config (U10): defender's (Top side) base upgrade level pre-applied at
   * game start. Range 0–3 matching BASE_UPGRADE_COSTS length. Affects ink regen and
   * signals investment level. Valid for 'siege' mode; silently clamped in 'campaign'.
   */
  defenderBaseLevel?: number;
  /**
   * Stamina cost to attempt this level (A4). Range 1–5 (default 1 when omitted).
   * Deducted server-side on /pve/clear; client shows it in LevelPrepScene.
   */
  staminaCost?: number;
  /** Clear rewards: coins, exclusive skin, story unlock, star thresholds (§7). */
  rewards?: LevelRewards;
  /** i18n story keys for intro / outro narration (§8). */
  story?: { introKey?: TranslationKey; outroKey?: TranslationKey };
  /** Optional display-name key for this level, shown in CampaignMapScene. Falls back to chapter/position label. */
  nameKey?: TranslationKey;
  /** Optional pre-battle briefing text key, shown in LevelPrepScene. Omitted for pure-combat levels. */
  briefKey?: TranslationKey;
}

/** Integer grid cell. */
export interface Cell {
  col: number;
  row: number;
}

/**
 * Win condition kind.
 * - `survive`        : clear all waves (no living enemies remain) with the base alive.
 * - `timed_defense`  : keep the base alive until the timer runs out.
 * - `destroy_base`   : win only by destroying the enemy base; wave exhaustion alone is not enough.
 * - `leak_limit`     : lose if more than `maxLeaks` enemy units reach the player's base.
 * - `boss`           : win by killing the boss unit(s) (WaveEntry.isBoss === true).
 * - `escort`         : win when enough escort units reach the enemy base (§4.9.3).
 *                      `required` controls how many must arrive: 'all', 'any', or an integer count.
 */
export type ObjectiveSpec =
  | { kind: 'survive' }
  | { kind: 'timed_defense'; durationTicks: number }
  | { kind: 'destroy_base'; durationTicks?: number }
  | { kind: 'leak_limit'; maxLeaks: number }
  | { kind: 'boss' }
  | { kind: 'escort'; required: 'all' | 'any' | number };

export interface WaveScript {
  entries: WaveEntry[];
}

/**
 * One scripted spawn group. Spawns `count` units of `unitType` on lane `col`,
 * the first at `atTick`, each subsequent one `spacingTicks` ticks later.
 */
export interface WaveEntry {
  /** Absolute tick (relative to level start) of the first unit in this group. */
  atTick: number;
  unitType: UnitType;
  /** Spawn lane (must be an attack lane, not a base column). */
  col: number;
  count: number;
  /** Ticks between consecutive units in this group (default 0 = simultaneous). */
  spacingTicks?: number;
  /** Scripted lane-switch waypoints (§4.2) — reserved, not consumed in P0. */
  crossWaypoints?: { atRow: number; toCol: number }[];
  /** Flag a unit as a boss (drives special FX / bigger reward) — reserved. */
  isBoss?: boolean;
}

export interface HazardSpec {
  col: number;
  rowRange: [number, number];
  effect: 'speed' | 'fog' | 'lava';
  /** For 'speed': multiplier applied to unit base speed (default 0.5 = half speed). */
  speedMult?: number;
  /** For 'fog': additive range delta, typically negative (default -1). */
  rangeMod?: number;
  /** For 'lava': damage per second dealt to units inside the zone (default 5). */
  dps?: number;
}

/**
 * Specification for one friendly escort unit placed in a campaign level (§4.9.3).
 * The escort starts at (startCol, startRow) and walks toward the enemy base row
 * (row 17 = TOP_BUILDING_ROW), optionally following explicit waypoints.
 */
export interface EscortSpec {
  /** Stable string id — matches EscortUnit.id and used in events. */
  id: string;
  /** Starting HP (and max HP). */
  hp: number;
  /** Movement speed in cells / second. */
  speed: number;
  startCol: number;
  startRow: number;
  /**
   * Explicit waypoint list. The escort passes through each in order; at each
   * waypoint's row the escort snaps to the waypoint's col, then continues.
   * Waypoints must have strictly increasing row values (ascending toward enemy).
   * Omit for a straight-line advance along startCol.
   */
  path?: { col: number; row: number }[];
}

/**
 * SLG defense config: one pre-deployed unit on the defender (Top) side, or — when
 * used in {@link LevelDefinition.attackerArmy} — one pre-deployed attacker unit on
 * the Bottom side.
 */
export interface GarrisonEntry {
  unitType: UnitType;
  /** Attack lane column (must be in ATTACK_LANES). */
  col: number;
  /** Row 1–16 inclusive — anywhere in the combat zone or a spawn row. */
  row: number;
  /**
   * SLG siege battle (G3, §16.1): "兵力 = 血量". The troops allotted to this unit
   * become its starting HP (≤ the blueprint's full capacity). Omitted → the unit
   * spawns at full blueprint HP. Deterministic; consumed by the Unit constructor.
   */
  initialHp?: number;
}

/** SLG defense config: one pre-placed building on the defender's building row. */
export interface DefenderBuildingEntry {
  buildingType: BuildingType;
  /** Attack lane column (must be in ATTACK_LANES, not a base column). */
  col: number;
}

export interface LevelRewards {
  coins?: number;
  /** Exclusive skin granted on clear (D4 — "selling power = selling skins"). */
  unlockSkinId?: string;
  unlockStoryKey?: TranslationKey;
  /** Base-HP% thresholds for 1 / 2 / 3 stars. */
  starThresholds?: [number, number, number];
  /**
   * PvE materials granted on first clear (S3-1, M6) — material id → amount.
   * Materials feed the upgrade tree (game/balance/pveUpgrades.ts); they are a
   * client-sync segment (SaveData.materials), not server-authoritative currency.
   */
  materials?: Record<string, number>;
}
