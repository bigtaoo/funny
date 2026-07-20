#!/usr/bin/env node
// One-off backfill for the `matches`/`replayBlobs` storage-cleanup TTL (see MatchDoc.expireAt doc comment).
// Existing pre-migration docs have no `expireAt` field, so the TTL index added alongside this script never
// touches them. Atlas was at 296MB/39K docs in `matches` alone (3 real players + 100 bots) with no cleanup.
// Usage: npx tsx server/metaserver/scripts/backfillMatchExpiry.ts [--dry-run]
//
// Behaviour:
//   - Disputed matches (hashMismatch=true or cheat present) are left alone (no expireAt — kept indefinitely).
//   - Everything else gets expireAt = ts + 7d (anchored to the match's OWN age, not "now" — a match from
//     10 days ago gets an expireAt 3 days in the past, so the TTL background thread purges it on its next
//     scan; this is what actually shrinks the existing backlog, not just caps future growth).
//   - `replayBlobs` has no hashMismatch/cheat of its own (that lives on the owning `matches` doc, joined by
//     roomId/_id), so its expireAt always mirrors the owning match's — set in the same pass, right after.
//   - Idempotent: only touches docs where expireAt is absent and (for matches) hashMismatch/cheat are absent.
import { MongoClient, type AnyBulkWriteOperation, type Document } from 'mongodb';

const MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB = process.env.NW_MONGO_DB ?? 'notebook_wars';
const DRY_RUN = process.argv.includes('--dry-run');
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const BATCH = 1000;

async function main(): Promise<void> {
  console.log(`[backfillMatchExpiry] ${DRY_RUN ? '[dry-run] ' : ''}starting`);
  console.log(`  mongo: ${MONGO_URI} / ${MONGO_DB}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const matches = db.collection<Document>('matches');
  const replayBlobs = db.collection<Document>('replayBlobs');

  const filter = {
    expireAt: { $exists: false },
    hashMismatch: { $exists: false },
    cheat: { $exists: false },
  };
  const total = await matches.countDocuments(filter);
  console.log(`matches: ${total} non-disputed docs eligible for expireAt backfill`);

  let processed = 0;
  let blobsUpdated = 0;
  const cursor = matches.find(filter, { projection: { _id: 1, roomId: 1, replayRef: 1, ts: 1 } });
  let matchOps: AnyBulkWriteOperation<Document>[] = [];
  let blobOps: AnyBulkWriteOperation<Document>[] = [];

  const flush = async (): Promise<void> => {
    if (matchOps.length === 0) return;
    if (!DRY_RUN) {
      await matches.bulkWrite(matchOps, { ordered: false });
      if (blobOps.length > 0) await replayBlobs.bulkWrite(blobOps, { ordered: false });
    }
    processed += matchOps.length;
    blobsUpdated += blobOps.length;
    console.log(`  matches: ${processed}/${total} (replayBlobs so far: ${blobsUpdated})`);
    matchOps = [];
    blobOps = [];
  };

  for await (const doc of cursor) {
    const d = doc as { _id: unknown; roomId: string; replayRef?: string; ts?: number };
    const expireAt = new Date((d.ts ?? Date.now()) + RETENTION_MS);
    matchOps.push({ updateOne: { filter: { _id: d._id } as Document, update: { $set: { expireAt } } } });
    if (d.replayRef) {
      blobOps.push({ updateOne: { filter: { _id: d.replayRef } as Document, update: { $set: { expireAt } } } });
    }
    if (matchOps.length >= BATCH) await flush();
  }
  await flush();
  console.log(`[backfillMatchExpiry] done: matches ${processed}, replayBlobs ${blobsUpdated} ${DRY_RUN ? '(dry-run, no writes)' : 'updated'}`);
  await client.close();
}

main().catch((e) => {
  console.error('[backfillMatchExpiry] failed:', e);
  process.exit(1);
});
