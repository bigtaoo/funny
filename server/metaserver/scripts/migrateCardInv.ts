#!/usr/bin/env node
// One-off migration: split SaveData.cardInv (embedded map) out to the cardInstances collection
// (2026-07-27 perf fix, mirrors migrateEquipmentInv.ts / see cards.ts header + CHARACTER_CARDS_DESIGN.md).
// An embedded map of up to 500 cards was a second unbounded contributor to save-doc bloat on Atlas M0,
// alongside equipmentInv. This script must run to 100% completion BEFORE the new code (which reads
// cardInstances, not the embedded field) is deployed — see the "run order" note below.
//
// Usage: npx tsx server/metaserver/scripts/migrateCardInv.ts [--dry-run]
//
// Run order (important): deploying this script's *code* is fine at any time (it only touches `saves` +
// `cardInstances`, both already exist in the schema by the time this runs), but do NOT deploy the
// application code that *reads* cardInstances (cards.ts / equipment.ts's isEquipped+equipEquipment /
// app.ts's join hook / economyRoutes.ts's /internal/save-fields + /internal/cards/escrow) until this
// script reports 0 remaining accounts. Deploying the new code first would make every not-yet-migrated
// account's Hero Roster briefly vanish from GET /save (and worldsvc's siege army resolution) until this
// script reaches them.
//
// Behaviour:
//   - Resumable: `{'save.cardInv': {$exists: true}}` is both the work-queue filter and the per-account
//     "done" marker (a migrated account has had the field $unset) — safe to re-run after any
//     interruption (crash, Ctrl-C), it just picks up wherever it left off.
//   - Per-account, rev-guarded (mirrors migrateEquipmentInv.ts / the app's own optimistic-lock pattern):
//     re-reads the account's *current* embedded cardInv + rev fresh right before the final $unset, so a
//     player fusing/receiving a new card *during* the migration window is never dropped by a `$unset`
//     racing against a stale read — only re-runs the read+upsert+unset for that one account (bounded
//     retries, same REV_RETRIES=3 convention as the rest of the card backend).
//   - Idempotent instance upserts: `replaceOne(..., {upsert:true})` keyed by instanceId, not `insertMany`
//     — a re-run over already-migrated instances is a no-op, never a duplicate-key throw.
//   - Dry-run mode: pass --dry-run to count + log without writing anything.
import { MongoClient, type Document } from 'mongodb';

const MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB = process.env.NW_MONGO_DB ?? 'notebook_wars';
const DRY_RUN = process.argv.includes('--dry-run');
const REV_RETRIES = 3;

interface CardInstanceLike {
  id: string;
  defId: string;
  level: number;
  gear: Record<string, string>;
  locked: boolean;
}

async function migrateOneAccount(
  saves: import('mongodb').Collection<Document>,
  cardInstances: import('mongodb').Collection<Document>,
  accountId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await saves.findOne({ _id: accountId });
    if (!doc) return { ok: false, error: 'save disappeared mid-migration' };
    const save = doc.save as { cardInv?: Record<string, CardInstanceLike> };
    const inv = save.cardInv ?? {};
    const entries = Object.values(inv);

    if (!DRY_RUN && entries.length > 0) {
      await cardInstances.bulkWrite(
        entries.map((inst) => ({
          replaceOne: {
            filter: { _id: inst.id },
            replacement: {
              _id: inst.id,
              accountId,
              defId: inst.defId,
              level: inst.level,
              gear: inst.gear,
              locked: inst.locked,
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }

    if (DRY_RUN) return { ok: true, count: entries.length };

    const res = await saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $unset: { 'save.cardInv': '' }, $set: { 'save.cardInvCount': entries.length }, $inc: { rev: 1 } },
    );
    if (res) return { ok: true, count: entries.length };
    // rev conflict (a real gameplay write landed between our read and this $unset) → re-read + retry;
    // the bulkWrite above is idempotent so re-upserting the (possibly now-stale) entries list is safe.
  }
  return { ok: false, error: 'rev conflict, retries exhausted' };
}

async function main(): Promise<void> {
  console.log(`[migrateCardInv] ${DRY_RUN ? '[dry-run] ' : ''}starting`);
  console.log(`  mongo: ${MONGO_URI} / ${MONGO_DB}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const saves = db.collection<Document>('saves');
  const cardInstances = db.collection<Document>('cardInstances');
  await cardInstances.createIndex({ accountId: 1 });

  const filter = { 'save.cardInv': { $exists: true } };
  const total = await saves.countDocuments(filter);
  console.log(`${total} accounts still have the embedded cardInv field`);

  let processed = 0;
  let totalInstances = 0;
  let failed = 0;
  const cursor = saves.find(filter, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    const accountId = doc._id as string;
    const r = await migrateOneAccount(saves, cardInstances, accountId);
    if (r.ok) {
      totalInstances += r.count;
    } else {
      failed++;
      console.error(`  FAILED ${accountId}: ${r.error}`);
    }
    processed++;
    if (processed % 100 === 0 || processed === total) {
      console.log(`  ${processed}/${total} accounts (instances migrated so far: ${totalInstances}, failures: ${failed})`);
    }
  }

  const remaining = DRY_RUN ? total : await saves.countDocuments(filter);
  console.log(
    `[migrateCardInv] done: ${processed} accounts processed, ${totalInstances} instances, ${failed} failures, ${remaining} still pending ${DRY_RUN ? '(dry-run, no writes)' : ''}`,
  );
  if (!DRY_RUN && remaining > 0) {
    console.error('Re-run this script — some accounts did not complete (see FAILED lines above). Do NOT deploy the new app code yet.');
    process.exitCode = 1;
  }
  await client.close();
}

main().catch((e) => {
  console.error('[migrateCardInv] failed:', e);
  process.exit(1);
});
