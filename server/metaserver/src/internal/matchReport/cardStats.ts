// Split from matchReport.ts (2026-08-10, independent function module range 6, part 4/6).
import type { Collections } from '@nw/shared';
import { decompressReplayDoc } from '@nw/shared';

/** UTC day key (YYYYMMDD) for `PvpCardStatDoc.day` bucketing. */
function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * BALANCE data pipeline (P1): credit games/wins to every card in each side's deck. A card appearing multiple
 * times in a deck (shouldn't happen per PVP_LOADOUT_DESIGN's "each card at most once" rule, but de-duped
 * defensively) is only counted once per match per side.
 */
export async function accruePvpCardStats(
  cols: Collections,
  ts: number,
  mode: string,
  winnerSide: number,
  replayGzBuf: Buffer,
): Promise<void> {
  const decks = decompressReplayDoc(replayGzBuf).decks;
  if (!decks) return;
  const day = utcDayKey(ts);
  const sides: { side: number; deck: string[] }[] = [
    { side: 0, deck: decks.top },
    { side: 1, deck: decks.bottom },
  ];
  const ops = [];
  for (const { side, deck } of sides) {
    const won = side === winnerSide;
    for (const cardId of new Set(deck)) {
      ops.push({
        updateOne: {
          filter: { _id: `${day}:${cardId}:${mode}` },
          update: {
            $setOnInsert: { day, cardId, mode },
            $inc: { games: 1, ...(won ? { wins: 1 } : {}) },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await cols.pvpCardStats.bulkWrite(ops);
}
