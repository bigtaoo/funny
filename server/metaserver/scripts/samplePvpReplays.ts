#!/usr/bin/env node
// BALANCE data pipeline (P2): sample a small slice of archived PvP matches and decode their replays into
// per-side card-play sequences (see src/internal/replayDecode.ts) — the thing the deck-level win-rate counters
// (P1, pvpCardStats) can't show: *how* a card was actually used. Deliberately NOT run on the full match volume —
// decoding re-simulates the whole match (CPU cost), and there's no cron infra in this codebase to run it as a
// background job — so this is an offline script, invoked manually (or by whatever external scheduler ops wires up).
//
// Usage: npx tsx server/metaserver/scripts/samplePvpReplays.ts [--dry-run] [--since=<ms epoch>] [--rate=0.05]
//
// Sampling rule (see design/game/BALANCE.md "线上对局数据来源"):
//   - Disputed matches (hashMismatch/cheat) are skipped — already routed through the anti-cheat review queue.
//   - Matches with no restricted deck (replay.decks absent) are skipped — nothing to correlate against P1.
//   - "Upset" matches (winner's pre-match ELO was the LOWER of the two sides, by more than UPSET_ELO_GAP) are
//     always sampled — these are the most likely to contain a playstyle the equal-ink simulator never modeled.
//   - Everything else is sampled at `--rate` (default 5%) as an unbiased baseline.
//   - Already-sampled matches (present in pvpPlaySequences) are skipped — idempotent re-run.
//   - Replays that fail to decode (corrupt/incomplete frame log) are logged and skipped, not silently dropped.
import { MongoClient, type Document } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { decodeReplay } from '../src/internal/replayDecode.js';

const MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB = process.env.NW_MONGO_DB ?? 'notebook_wars';
const DRY_RUN = process.argv.includes('--dry-run');
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const rateArg = process.argv.find((a) => a.startsWith('--rate='));
const SINCE = sinceArg ? Number(sinceArg.slice('--since='.length)) : Date.now() - 24 * 3600 * 1000;
const RANDOM_RATE = rateArg ? Number(rateArg.slice('--rate='.length)) : 0.05;
const UPSET_ELO_GAP = 150; // roughly one rank tier (see design/game/BALANCE.md rank thresholds)

export interface MatchRow {
  _id: unknown;
  roomId: string;
  mode: string;
  winner: number;
  hashMismatch?: boolean;
  cheat?: unknown;
  players: { side: number; eloDelta?: number; eloAfter?: number }[];
  replay?: { engineVersion: number; mode: string; seed: string; endFrame: number; frames: { frame: number; cmds: { side: number; commands: string }[] }[]; decks?: { top: string[]; bottom: string[] } };
  replayRef?: string;
  ts: number;
}

export function isUpset(row: MatchRow): boolean {
  if (row.winner < 0) return false;
  const winner = row.players.find((p) => p.side === row.winner);
  const loser = row.players.find((p) => p.side !== row.winner);
  if (!winner?.eloAfter || winner.eloDelta === undefined || !loser?.eloAfter || loser.eloDelta === undefined) return false;
  const winnerEloBefore = winner.eloAfter - winner.eloDelta;
  const loserEloBefore = loser.eloAfter - loser.eloDelta;
  return loserEloBefore - winnerEloBefore >= UPSET_ELO_GAP;
}

async function main(): Promise<void> {
  console.log(`[samplePvpReplays] ${DRY_RUN ? '[dry-run] ' : ''}starting since=${new Date(SINCE).toISOString()} rate=${RANDOM_RATE}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const matches = db.collection<Document>('matches');
  const replayBlobs = db.collection<Document>('replayBlobs');
  const pvpPlaySequences = db.collection<Document>('pvpPlaySequences');

  const already = new Set((await pvpPlaySequences.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id as string));
  const cursor = matches.find({
    ts: { $gte: SINCE },
    hashMismatch: { $exists: false },
    cheat: { $exists: false },
    'replay.decks': { $exists: true },
  });

  let scanned = 0, sampled = 0, decoded = 0, failed = 0, skippedRate = 0;
  for await (const doc of cursor) {
    const row = doc as unknown as MatchRow;
    scanned++;
    if (already.has(row.roomId)) continue;

    const reason: 'upset' | 'random' | null = isUpset(row) ? 'upset' : (Math.random() < RANDOM_RATE ? 'random' : null);
    if (!reason) { skippedRate++; continue; }
    sampled++;

    let replay = row.replay;
    if (!replay && row.replayRef) {
      const blob = await replayBlobs.findOne({ _id: row.replayRef });
      replay = (blob as { replay?: MatchRow['replay'] } | null)?.replay;
    }
    if (!replay) { console.warn(`[samplePvpReplays] ${row.roomId}: no replay data, skipping`); failed++; continue; }

    const result = decodeReplay(replay);
    if (!result) { console.warn(`[samplePvpReplays] ${row.roomId}: decode failed (incomplete/corrupt replay), skipping`); failed++; continue; }

    console.log(`[samplePvpReplays] ${row.roomId}: ${reason}, ${result.plays.length} plays, winner=${result.winnerSide}`);
    if (!DRY_RUN) {
      await pvpPlaySequences.updateOne(
        { _id: row.roomId },
        { $setOnInsert: { _id: row.roomId, ts: row.ts, mode: row.mode, sampleReason: reason, winnerSide: result.winnerSide, plays: result.plays } },
        { upsert: true },
      );
    }
    decoded++;
  }

  console.log(`[samplePvpReplays] done: scanned=${scanned} sampled=${sampled} decoded=${decoded} failed=${failed} skipped(rate)=${skippedRate} ${DRY_RUN ? '(dry-run, no writes)' : ''}`);
  await client.close();
}

// Guard so tests can `import { isUpset } from './samplePvpReplays.js'` without triggering a live Mongo connect
// (process.argv[1] is the test runner's entry, not this file, when imported rather than run directly).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error('[samplePvpReplays] failed:', e);
    process.exit(1);
  });
}
