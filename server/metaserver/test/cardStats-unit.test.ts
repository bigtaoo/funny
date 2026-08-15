// Unit coverage for src/internal/matchReport/cardStats.ts (accruePvpCardStats), importing directly from
// '../src/...' so v8 coverage attributes execution to source. Real Mongo (shared instance, see
// NW_MONGO_URI): the function's `cols.pvpCardStats.bulkWrite([...])` call with $setOnInsert/$inc/upsert
// isn't something test/helpers/fakeCollection.ts implements, so a real Mongo instance is the pragmatic
// choice here (same rationale as economy-service-unit.test.ts's header comment).
//
// Existing e2e test read for scenarios/shapes: test/pvp-card-stats.e2e.test.ts (imports '../dist/app.js',
// exercises the same business logic through /internal/match/report + GET /internal/pvp-card-stats, but
// records 0% src coverage for this module) — this file re-derives its scenarios calling
// accruePvpCardStats directly instead of going through the HTTP route + full match-settlement pipeline.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, compressReplayDoc, type MongoHandle, type MatchReplayDoc } from '@nw/shared';
import { accruePvpCardStats } from '../src/internal/matchReport/cardStats.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_cardstats_unit_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[cardStats-unit] Mongo unreachable (${URI}) — skipping.`);

function replayGz(decks?: { top: string[]; bottom: string[] }): Buffer {
  const doc: MatchReplayDoc = {
    engineVersion: 0,
    mode: 'netplay',
    seed: '1',
    endFrame: 0,
    frames: [],
    meta: { recordedAt: 0, winner: 0 },
    ...(decks ? { decks } : {}),
  };
  return compressReplayDoc(doc);
}

describe.skipIf(!mongo)('accruePvpCardStats', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  const allDocs = async () => m.collections.pvpCardStats.find({}).toArray();

  it('no decks in the replay (full-pool friendly match) -> no-op, nothing written', async () => {
    await accruePvpCardStats(m.collections, 1000, 'ranked', 0, replayGz());
    expect(await allDocs()).toEqual([]);
  });

  it('credits games to both sides, wins only to the winning side', async () => {
    const decks = { top: ['infantry_2', 'archer_1'], bottom: ['shieldbearer_1'] };
    await accruePvpCardStats(m.collections, 1_700_000_000_000, 'ranked', 0, replayGz(decks));
    const docs = await allDocs();
    const byCard = Object.fromEntries(docs.map((d) => [d.cardId, d]));
    expect(byCard.infantry_2).toMatchObject({ games: 1, wins: 1, mode: 'ranked' });
    expect(byCard.archer_1).toMatchObject({ games: 1, wins: 1 });
    // $inc only includes `wins` when this side actually won this match — a side that never wins never
    // gets the field created at all (not even wins:0), so assert games only + wins absence here.
    expect(byCard.shieldbearer_1.games).toBe(1);
    expect(byCard.shieldbearer_1.wins).toBeUndefined();
  });

  it('a card appearing multiple times in the same deck (should not happen per PVP_LOADOUT_DESIGN, but de-duped defensively) is only counted once per match per side', async () => {
    const decks = { top: ['infantry_2', 'infantry_2', 'infantry_2'], bottom: ['archer_1'] };
    await accruePvpCardStats(m.collections, 2000, 'ranked', 0, replayGz(decks));
    const docs = await allDocs();
    const infantry = docs.find((d) => d.cardId === 'infantry_2')!;
    expect(infantry.games).toBe(1); // not 3
    expect(infantry.wins).toBe(1);
  });

  it('accumulates across multiple matches on the same UTC day + mode (upsert + $inc)', async () => {
    const decks = { top: ['infantry_2'], bottom: ['archer_1'] };
    const ts = Date.UTC(2026, 0, 15, 3, 0, 0); // same UTC day for both calls
    await accruePvpCardStats(m.collections, ts, 'ranked', 0, replayGz(decks));
    await accruePvpCardStats(m.collections, ts + 1000, 'ranked', 1, replayGz(decks)); // second match, bottom wins
    const docs = await allDocs();
    const infantry = docs.find((d) => d.cardId === 'infantry_2')!; // top, side 0
    const archer = docs.find((d) => d.cardId === 'archer_1')!; // bottom, side 1
    expect(infantry).toMatchObject({ games: 2, wins: 1 }); // won only the first match
    expect(archer).toMatchObject({ games: 2, wins: 1 }); // won only the second match
  });

  it('different UTC days bucket separately (day key derived from ts, YYYYMMDD)', async () => {
    const decks = { top: ['infantry_2'], bottom: ['archer_1'] };
    const day1 = Date.UTC(2026, 0, 15, 12, 0, 0);
    const day2 = Date.UTC(2026, 0, 16, 12, 0, 0);
    await accruePvpCardStats(m.collections, day1, 'ranked', 0, replayGz(decks));
    await accruePvpCardStats(m.collections, day2, 'ranked', 0, replayGz(decks));
    const docs = await allDocs();
    const infantryDocs = docs.filter((d) => d.cardId === 'infantry_2');
    expect(infantryDocs).toHaveLength(2); // one doc per day, not accumulated into one
    expect(infantryDocs.every((d) => d.games === 1)).toBe(true);
  });

  it('different modes bucket separately even on the same day', async () => {
    const decks = { top: ['infantry_2'], bottom: ['archer_1'] };
    const ts = Date.UTC(2026, 0, 20, 8, 0, 0);
    await accruePvpCardStats(m.collections, ts, 'ranked', 0, replayGz(decks));
    await accruePvpCardStats(m.collections, ts, 'friendly', 0, replayGz(decks));
    const docs = await allDocs();
    const infantryDocs = docs.filter((d) => d.cardId === 'infantry_2');
    expect(infantryDocs).toHaveLength(2);
    expect(infantryDocs.map((d) => d.mode).sort()).toEqual(['friendly', 'ranked']);
  });
});
