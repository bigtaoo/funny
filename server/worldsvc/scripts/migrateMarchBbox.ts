#!/usr/bin/env node
// One-off backfill for MarchDoc.minX/maxX/minY/maxY (worldsvc march/stationed query-optimization, 2026-07-29).
// getMarches' vision-gated "enemy march" branch now filters `marches` by these four fields before falling
// back to the exact per-position `isInVision` check in JS (see MarchDoc doc comment in src/db.ts and
// combatMarch.ts::getMarches). Every code path that INSERTS a MarchDoc after this deploy sets them; docs
// already in flight at deploy time (created by the pre-deploy binary) do not carry them yet.
//
// Usage: npx tsx server/worldsvc/scripts/migrateMarchBbox.ts [--dry-run]
//
// Whether you need to run this at all: the fields are fully derivable from data every march already has
// (`fromTile`/`toTile`, both `{worldId}:{x}:{y}` strings) — this is a convenience backfill, not a hard
// prerequisite for the new code to function correctly:
//   - `marches` is a transient, short-lived collection (docs are deleted the moment a leg arrives or is
//     superseded) — every march in flight when this deploys will naturally leave the collection within its
//     own remaining travel time regardless of whether this script runs.
//   - A march missing these fields simply will not match the new bounding-box query, so it is invisible to
//     OTHER players' enemy-vision listing (getMarches) for the rest of its natural lifetime. This affects
//     early-warning observability only — it does not touch combat resolution, troop counts, arrival
//     processing, or any other authoritative state, all of which are keyed off arriveAt/nextStepAt and never
//     read these fields.
//   - recallMarch also self-heals any legacy doc it touches (recomputes the box unconditionally on the
//     outbound→return flip), so only marches that neither get recalled nor naturally arrive before an admin
//     runs this script stay affected — in practice a fully self-healing situation on any deploy that isn't
//     immediately followed by a second deploy within the same march's travel time.
// Given the above, running this script is a nice-to-have that closes the observability gap immediately
// rather than waiting out the affected marches' remaining travel time — recommended but not a release gate
// (contrast with migrateCardInv.ts/migrateMapBaselinesToRle.ts, which ARE gates: those fields are read on
// every request and a miss there breaks user-facing functionality, not just a transient early-warning gap).
//
// Behaviour:
//   - Idempotent: only touches docs where minX is absent (re-running is a no-op once complete).
//   - Parses `fromTile`/`toTile` (`{worldId}:{x}:{y}`, worldId itself never contains ':') directly rather
//     than importing worldsvc's WorldCore.coordX/coordY, keeping this script a standalone Mongo tool like
//     its siblings (see migrateMapBaselinesToRle.ts).
import { MongoClient, type AnyBulkWriteOperation, type Document } from 'mongodb';

const MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB = process.env.NW_MONGO_DB ?? 'notebook_wars_world';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 1000;

/** tileId = `{worldId}:{x}:{y}`; worldId itself never contains ':', so the last two ':'-segments are x/y. */
function coordsOf(tileId: string): { x: number; y: number } {
  const p = tileId.split(':');
  return { x: Number(p[p.length - 2]), y: Number(p[p.length - 1]) };
}

async function main(): Promise<void> {
  console.log(`[migrateMarchBbox] ${DRY_RUN ? '[dry-run] ' : ''}starting`);
  console.log(`  mongo: ${MONGO_URI} / ${MONGO_DB}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const marches = db.collection<Document>('marches');

  const filter = { minX: { $exists: false } };
  const total = await marches.countDocuments(filter);
  console.log(`marches: ${total} docs missing minX/maxX/minY/maxY`);
  if (total === 0) {
    console.log('[migrateMarchBbox] nothing to migrate — every in-flight march already carries the bbox fields.');
    await client.close();
    return;
  }

  let processed = 0;
  const cursor = marches.find(filter, { projection: { _id: 1, fromTile: 1, toTile: 1 } });
  let ops: AnyBulkWriteOperation<Document>[] = [];

  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    if (!DRY_RUN) await marches.bulkWrite(ops, { ordered: false });
    processed += ops.length;
    console.log(`  marches: ${processed}/${total}`);
    ops = [];
  };

  for await (const doc of cursor) {
    const d = doc as { _id: unknown; fromTile: string; toTile: string };
    const from = coordsOf(d.fromTile);
    const to = coordsOf(d.toTile);
    const box = {
      minX: Math.min(from.x, to.x),
      maxX: Math.max(from.x, to.x),
      minY: Math.min(from.y, to.y),
      maxY: Math.max(from.y, to.y),
    };
    ops.push({ updateOne: { filter: { _id: d._id } as Document, update: { $set: box } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  console.log(`[migrateMarchBbox] done: ${processed} docs ${DRY_RUN ? 'would be updated' : 'updated'}`);
  await client.close();
}

main().catch((e) => {
  console.error('[migrateMarchBbox] failed:', e);
  process.exit(1);
});
