// Economy config — per-match victory coins (§2.3b, ECONOMY_BALANCE.md, ongoing faucet). 2026-08-11
// split (independent function modules form, see ../economy.ts's header). Zero cross-file dependency
// within economy/*.
import type { RankId } from '../ladder';

/**
 * Tiered per-match victory coins (§2.3b, ongoing faucet). Higher ranks earn more; paired with daily cap to prevent inflation.
 * Awarded only for ranked wins (includes disconnect/surrender judged wins and honest winners determined by peer-judge).
 */
export const VICTORY_COINS_BY_RANK: Record<RankId, number> = {
  bronze: 5,
  silver: 5,
  gold: 5,
  platinum: 8,
  diamond: 8,
  star: 12,
  master: 12,
  grandmaster: 18,
  king: 18,
};

/** Daily win cap for victory coins (wins beyond this still count for ranking/record, no coins awarded, §2.3b). */
export const VICTORY_DAILY_WIN_CAP = 10;

/** Rank → per-match victory coins (unknown rank falls back to minimum tier). */
export function victoryCoinsForRank(rank: string): number {
  return VICTORY_COINS_BY_RANK[rank as RankId] ?? VICTORY_COINS_BY_RANK.bronze;
}
