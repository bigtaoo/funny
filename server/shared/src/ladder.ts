// Ladder rank + ELO (S1-R). Pure functions, **shared between gameserver computation and client display**—
// avoids divergence between display and authoritative values caused by each side maintaining its own rank thresholds.
// Values defined in design/game/ECONOMY_BALANCE.md §2.3 (9 ranks); kept in server config for hot adjustment.

/** Stable ids for the 9 rank tiers (display names are handled by client i18n; the authority stores only the id). */
export type RankId =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'star'
  | 'master'
  | 'grandmaster'
  | 'king';

/** Rank → minimum ELO threshold (ascending). Below the first tier's minimum is always treated as the lowest rank. */
export const RANK_TIERS: ReadonlyArray<{ id: RankId; minElo: number }> = [
  { id: 'bronze', minElo: 0 },
  { id: 'silver', minElo: 1100 },
  { id: 'gold', minElo: 1200 },
  { id: 'platinum', minElo: 1350 },
  { id: 'diamond', minElo: 1500 },
  { id: 'star', minElo: 1700 },
  { id: 'master', minElo: 1900 },
  { id: 'grandmaster', minElo: 2100 },
  { id: 'king', minElo: 2400 },
];

/** Initial ELO for new accounts (matches pvp.elo in makeNewSave). */
export const INITIAL_ELO = 1000;

/** ELO K-factor (maximum ELO swing per game ≈ K). */
export const ELO_K = 32;

/** ELO is never negative. */
export const ELO_FLOOR = 0;

/** Returns the rank id corresponding to the given ELO. */
export function eloToRank(elo: number): RankId {
  let rank: RankId = RANK_TIERS[0]!.id;
  for (const t of RANK_TIERS) {
    if (elo >= t.minElo) rank = t.id;
    else break; // ascending order: stop as soon as the minimum exceeds the current ELO
  }
  return rank;
}

/**
 * Standard ELO settlement. Returns integer ELO deltas for both sides, **zero-sum** (loser = -winner).
 * Expected win probability E_win = 1 / (1 + 10^((loserElo - winnerElo)/400));
 * actual winner gain = round(K × (1 - E_win)); upsets (low-rated beating high-rated) score more.
 */
export function computeEloDelta(
  winnerElo: number,
  loserElo: number,
  k: number = ELO_K,
): { winner: number; loser: number } {
  const expWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const gain = Math.round(k * (1 - expWin));
  return { winner: gain, loser: -gain };
}

/** New streak value after one game (pvp.streak: positive = win streak, negative = loss streak). */
export function nextStreak(prev: number, won: boolean): number {
  if (won) return prev > 0 ? prev + 1 : 1;
  return prev < 0 ? prev - 1 : -1;
}
