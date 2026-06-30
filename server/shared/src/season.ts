// Ladder season system (S11, SEASON_DESIGN.md). Pure functions, no DB / no PIXI.
// Season clock, soft reset, first-reach rank coins, season peak coins.
// Values are governed by ECONOMY_NUMBERS §13; this file defines constants + pure function logic.
import type { RankId } from './ladder';
import { RANK_TIERS, eloToRank } from './ladder';

// ── Season clock ────────────────────────────────────────────────────────────────

/** 6 weeks per season (for display / estimated end; actual season rollover is triggered manually by admin). */
export const SEASON_DURATION_MS = 6 * 7 * 24 * 60 * 60 * 1000;

/** Soft-reset baseline ELO (ELO above this regresses toward the baseline; at or below stays unchanged). Initially set to the Gold floor of 1200. */
export const SEASON_RESET_BASELINE = 1200;

/** Season clock document (`ladderSeasons` collection, globally unique _id='current'). */
export interface LadderSeasonDoc {
  _id: 'current';
  /** Current season number, starting from 1. */
  seasonNo: number;
  /** Start time of the current season (epoch ms). */
  startAt: number;
  /** Estimated end time (display only; does not automatically trigger a rollover). */
  endAt: number;
  /** Concurrent roll guard: `settling` exists only for the instant the roll itself executes (CAS). */
  state: 'active' | 'settling';
}

/**
 * Season settlement snapshot (`ladderSeasonSnapshots` collection, at most one record per account per season).
 * Written during the end-of-season close loop (rollSeason → settleSeasonParticipants) when settling by peak rank;
 * composite `_id = ${seasonNo}:${accountId}` also acts as an idempotency ledger (closing the same season twice does not double-write).
 */
export interface LadderSeasonSnapshotDoc {
  /** `${seasonNo}:${accountId}` composite idempotency key. */
  _id: string;
  /** Season number being settled (the season that is closing). */
  seasonNo: number;
  accountId: string;
  /** Highest ELO reached during the season (pvp.seasonPeakElo). */
  peakElo: number;
  /** Rank corresponding to the peak ELO. */
  peakRank: RankId;
  /** Coins awarded at settlement this season (peak coins + battle pass makeup, consistent with the settlement mail). */
  coins: number;
  /** Granted seasonal rank title id (ladder.s{N}.{rank}). */
  titleId: string;
  /** Settlement timestamp (ms). */
  ts: number;
}

// ── Soft reset algorithm (§4.1) ──────────────────────────────────────────────────────

/**
 * End-of-season ELO soft reset: ELO above the baseline regresses halfway toward it; ELO at or below the baseline is unchanged.
 * Example (baseline 1200): 2400→1800; 1500→1350; 1200→1200; 1000→1000.
 */
export function softReset(elo: number, baseline = SEASON_RESET_BASELINE): number {
  return elo > baseline ? Math.round((elo + baseline) / 2) : elo;
}

// ── Rank ascending list (helper for first-reach calculations) ──────────────────────────────────────────────

/** All RankIds in ascending ELO order (kept in sync with RANK_TIERS). */
export const RANKS_ASCENDING: RankId[] = RANK_TIERS.map((t) => t.id);

/**
 * Returns the subset of all rank ids that are ≤ targetRank (inclusive).
 * Used for first-reach coin calculation: when a player reaches a rank, all "first reaches" at that rank and below are granted together.
 */
export function ranksAtOrBelow(targetRank: RankId): RankId[] {
  const idx = RANKS_ASCENDING.indexOf(targetRank);
  if (idx < 0) return [];
  return RANKS_ASCENDING.slice(0, idx + 1);
}

// ── First-reach rank coins (§4.3, lifetime one-time grant, reachedRanks ledger) ────────────────────

/**
 * First-reach rank coins (§2.3a, ECONOMY_BALANCE). Granted only once per lifetime, cannot be farmed.
 * Reference values: Bronze 100 … King 3500.
 */
export const FIRST_REACH_COINS: Record<RankId, number> = {
  bronze: 100,
  silver: 200,
  gold: 400,
  platinum: 700,
  diamond: 1000,
  star: 1500,
  master: 2000,
  grandmaster: 2500,
  king: 3500,
};

/** First-reach coin amount for the given rank. */
export function firstReachCoins(rank: RankId): number {
  return FIRST_REACH_COINS[rank] ?? 0;
}

/**
 * Computes the total new first-reach coins and the newly added entries to reachedRanks when afterRank is newly achieved.
 * `reachedRanks` is the lifetime ledger (`pvp.reachedRanks`).
 */
export function computeFirstReachGrant(
  afterRank: RankId,
  reachedRanks: RankId[],
): { coins: number; newly: RankId[] } {
  const reachedSet = new Set(reachedRanks);
  const newly = ranksAtOrBelow(afterRank).filter((r) => !reachedSet.has(r));
  const coins = newly.reduce((sum, r) => sum + firstReachCoins(r), 0);
  return { coins, newly };
}

// ── Season peak coins (§4.2, repeatable each season, delivered via mail) ──────────────────────────────

/**
 * Season peak coins (settled at season end, awarded by peak rank, repeatable each season).
 * Approximately 30–40% of the first-reach coin amount (tentative); exact values to be calibrated in ECONOMY_NUMBERS §13.
 */
export const SEASON_PEAK_COINS: Record<RankId, number> = {
  bronze: 0,     // low ranks receive nothing: pointless and would incentivize inflating account counts
  silver: 0,
  gold: 100,
  platinum: 200,
  diamond: 350,
  star: 500,
  master: 700,
  grandmaster: 900,
  king: 1200,
};

/** Season settlement coins for the given peak rank. */
export function seasonPeakCoins(rank: RankId): number {
  return SEASON_PEAK_COINS[rank] ?? 0;
}

// ── pvp field extension (SE-1, default value factory for new SaveData.pvp fields) ──────────────────

/** Initializes pvp season fields for a new save / migration (caller spreads the result into the pvp block). */
export function makePvpSeasonDefaults(
  seasonNo: number,
  elo: number,
): {
  seasonNo: number;
  seasonPeakElo: number;
  seasonPeakRank: RankId;
  reachedRanks: RankId[];
} {
  return {
    seasonNo,
    seasonPeakElo: elo,
    seasonPeakRank: eloToRank(elo),
    reachedRanks: [],
  };
}
