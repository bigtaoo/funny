// Split 2026-08-10 out of engine/src/types.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Runtime-only shapes carried in game events (not blueprints): active spell effect state and
// end-of-game stats.
import type { SpellType, UnitType, Side } from './enums';
import type { OwnerId } from './coords';

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

/**
 * Match-level summary carried alongside per-player stats in the `game_stats` event,
 * for composite star scoring (STAR_SCORING.md). Deliberately separate from PlayerStats
 * (and thus from `matchStateHash`, which hashes only {winner, stats}) since these are
 * match-global, not per-side. Deterministic (same replay → same values).
 */
export interface MatchSummary {
  /** Elapsed ticks at game over (clear-time axis for the speed sub-score). */
  elapsedTicks: number;
  /** Enemy units that reached the player's base (leak sub-score / leak_limit diagnostic). */
  enemyLeaks: number;
  /** Lowest survival ratio across escort units, 0..100; null when the level has no escorts. */
  escortMinHpPct: number | null;
}
