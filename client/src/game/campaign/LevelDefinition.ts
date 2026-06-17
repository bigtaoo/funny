import type { UnitType } from '../types';
import type { TranslationKey } from '../../i18n';

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
  };
  /** Per-cell hazards: speed bands, fog, lava, etc. (§4.5). */
  hazards?: HazardSpec[];
  /** Override starting ink / regen for puzzle-style economy constraints (§4.7). */
  startInk?: number;
  inkRegenMult?: number;
  /** Pre-level loadout / banned cards (§4.7). */
  loadout?: string[];
  bannedCards?: string[];
  /** Clear rewards: coins, exclusive skin, story unlock, star thresholds (§7). */
  rewards?: LevelRewards;
  /** i18n story keys for intro / outro narration (§8). */
  story?: { introKey?: TranslationKey; outroKey?: TranslationKey };
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
 */
export type ObjectiveSpec =
  | { kind: 'survive' }
  | { kind: 'timed_defense'; durationTicks: number }
  | { kind: 'destroy_base' }
  | { kind: 'leak_limit'; maxLeaks: number }
  | { kind: 'boss' };

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
