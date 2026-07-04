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

/** K-factor for AI-fallback (bot) matches — a quarter of a real ranked match, so bot matches can't substitute for real climbing. */
export const BOT_ELO_K = 8;

/** AI-fallback matches only move ELO below this threshold (onboarding calibration); at/above it a bot match still counts for the daily task but leaves ELO untouched. */
export const BOT_ELO_THRESHOLD = 1200;

/** Per-extra-streak-level K multiplier step (win streak accelerates gains; loss streak accelerates losses). */
export const STREAK_K_STEP = 0.3;

/** Multiplier cap so an extreme streak can't blow past a bounded swing per game. */
export const STREAK_K_CAP = 2.5;

/**
 * K multiplier from a same-direction streak *entering* this match (i.e. pvp.streak before this game
 * is settled). `streakLen` is the number of consecutive wins (or losses) already stacked — 0/1 is the
 * baseline (no acceleration yet: a single win, or coming off a break, doesn't get a bonus), each
 * additional consecutive result adds STREAK_K_STEP, capped at STREAK_K_CAP.
 */
export function streakMultiplier(streakLen: number): number {
  const level = Math.max(0, streakLen - 1);
  return Math.min(STREAK_K_CAP, 1 + level * STREAK_K_STEP);
}

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
 * Standard ELO settlement. Expected win probability E_win = 1 / (1 + 10^((loserElo - winnerElo)/400));
 * winner gain = round(winnerK × (1 - E_win)), loser loss = round(loserK × (1 - E_win)) — upsets
 * (low-rated beating high-rated) score more. **Zero-sum only when winnerK === loserK** (the common
 * case, and always true for AI-fallback matches); a win/loss-streak multiplier on one side alone
 * (STREAK_K_STEP, applied by the caller) intentionally breaks zero-sum so streaks can pull a player
 * toward their real bracket faster than their opponent's counter-streak decays.
 */
export function computeEloDelta(
  winnerElo: number,
  loserElo: number,
  opts: { winnerK?: number; loserK?: number } = {},
): { winner: number; loser: number } {
  const winnerK = opts.winnerK ?? ELO_K;
  const loserK = opts.loserK ?? ELO_K;
  const expWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const winnerGain = Math.round(winnerK * (1 - expWin));
  const loserGain = Math.round(loserK * (1 - expWin));
  return { winner: winnerGain, loser: -loserGain };
}

/** New streak value after one game (pvp.streak: positive = win streak, negative = loss streak). */
export function nextStreak(prev: number, won: boolean): number {
  if (won) return prev > 0 ? prev + 1 : 1;
  return prev < 0 ? prev - 1 : -1;
}
