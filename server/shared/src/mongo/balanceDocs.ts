// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). PvP balance data-pipeline domain (BALANCE §11): deck-composition win-rate counters + sampled
// replay decode, both offline-analysis-only, never read on any player-facing path.
import type { Collection } from 'mongodb';

/**
 * Deck-composition-level PvP win-rate counter (BALANCE data pipeline P1): one row per card per UTC day per mode.
 * Incremented at match-report time from `MatchDoc.replay.decks` (only present for restricted-deck-pool matches) — every card in a
 * side's deck gets `games` credited, and `wins` too if that side won. Disputed matches (hashMismatch/cheat) are excluded rather than
 * counted, matching the existing "auto-clean, don't hard-reject" data hygiene approach. Deck-level only — this cannot tell you how a
 * card was actually played, only whether the deck holding it won; see `pvpPlaySequences` (P2, sampled replay decode) for play-by-play.
 * `_id = `${day}:${cardId}:${mode}``, naturally idempotent for the bulkWrite upsert.
 */
export interface PvpCardStatDoc {
  _id: string;
  day: string; // UTC YYYYMMDD
  cardId: string;
  mode: string; // matches MatchDoc.mode ('ranked' | 'friendly'), kept separate so casual play doesn't dilute ranked signal
  games: number;
  wins: number;
}

/**
 * Sampled replay decode (BALANCE data pipeline P2, `server/metaserver/scripts/samplePvpReplays.ts`): for a small
 * sample of matches (upsets + a random baseline — never the full volume, decoding re-simulates the whole match),
 * the per-side card-type play sequence, for spotting playstyles the offline equal-ink simulator can't model
 * (timing, combos, positioning-driven value). `_id = roomId` (one entry per sampled match, idempotent re-run).
 */
export interface PvpPlaySequenceDoc {
  _id: string; // roomId
  ts: number;
  mode: string;
  sampleReason: 'upset' | 'random';
  winnerSide: number;
  plays: { side: number; frame: number; cardType: string }[];
}

/** PvP-balance-domain indexes. */
export async function ensureBalanceIndexes(pvpCardStats: Collection<PvpCardStatDoc>): Promise<void> {
  // PvP balance card stats: query by card across days for the aggregate report (_id is already the composite upsert key).
  await pvpCardStats.createIndex({ cardId: 1, day: 1 });
}
