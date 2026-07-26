#!/usr/bin/env node
// One-off migration: split SaveData.equipmentInv (embedded map) out to the equipmentInstances
// collection (2026-07-26 perf fix, see equipment.ts header + EQUIPMENT_DESIGN.md). A heavy account's
// embedded equipmentInv/cardInv pushed its save doc to 81KB, and Atlas M0 took ~650-1000ms to read/write
// it (vs ~15-40ms for a tiny doc) — every save write, not just equipment ones, paid to rewrite the whole
// map. This script must run to 100% completion BEFORE the new code (which reads equipmentInstances, not
// the embedded field) is deployed — see the "run order" note below.
//
// Usage: npx tsx server/metaserver/scripts/migrateEquipmentInv.ts [--dry-run]
//
// Run order (important): deploy this script's *code* is fine at any time (it only touches `saves` +
// `equipmentInstances`, both already exist in the schema by the time this runs), but do NOT deploy the
// application code that *reads* equipmentInstances (equipment.ts / economy.ts / app.ts's join hook /
// economyRoutes.ts's /internal/save-fields) until this script reports 0 remaining accounts. Deploying
// the new code first would make every not-yet-migrated account's equipment briefly vanish from
// GET /save (and worldsvc's siege combat gear bonuses) until this script reaches them.
//
// Behaviour:
//   - Resumable: `{'save.equipmentInv': {$exists: true}}` is both the work-queue filter and the
//     per-account "done" marker (a migrated account has had the field $unset) — safe to re-run after any
//     interruption (crash, Ctrl-C), it just picks up wherever it left off.
//   - Per-account, rev-guarded (mirrors the app's own optimistic-lock pattern, `equipment.ts`/`save.ts`):
//     re-reads the account's *current* embedded equipmentInv + rev fresh right before the final $unset,
//     so a player crafting/receiving a new item *during* the migration window is never dropped by a
//     `$unset` racing against a stale read — only re-runs the read+upsert+unset for that one account
//     (bounded retries, same REV_RETRIES=3 convention as the rest of the equipment backend).
//   - Idempotent instance upserts: `replaceOne(..., {upsert:true})` keyed by instanceId, not `insertMany`
//     — a re-run over already-migrated instances is a no-op, never a duplicate-key throw.
//   - Dry-run mode: pass --dry-run to count + log without writing anything.
import { MongoClient, type Document } from 'mongodb';

const MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB = process.env.NW_MONGO_DB ?? 'notebook_wars';
const DRY_RUN = process.argv.includes('--dry-run');
const REV_RETRIES = 3;

interface EquipmentInstanceLike {
  id: string;
  defId: string;
  rarity: string;
  level: number;
  affixes: unknown[];
  locked?: boolean;
}

async function migrateOneAccount(
  saves: import('mongodb').Collection<Document>,
  equipmentInstances: import('mongodb').Collection<Document>,
  accountId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await saves.findOne({ _id: accountId });
    if (!doc) return { ok: false, error: 'save disappeared mid-migration' };
    const save = doc.save as { equipmentInv?: Record<string, EquipmentInstanceLike> };
    const inv = save.equipmentInv ?? {};
    const entries = Object.values(inv);

    if (!DRY_RUN && entries.length > 0) {
      await equipmentInstances.bulkWrite(
        entries.map((inst) => ({
          replaceOne: {
            filter: { _id: inst.id },
            replacement: {
              _id: inst.id,
              accountId,
              defId: inst.defId,
              rarity: inst.rarity,
              level: inst.level,
              affixes: inst.affixes,
              ...(inst.locked !== undefined ? { locked: inst.locked } : {}),
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
      { $unset: { 'save.equipmentInv': '' }, $set: { 'save.equipmentInvCount': entries.length }, $inc: { rev: 1 } },
    );
    if (res) return { ok: true, count: entries.length };
    // rev conflict (a real gameplay write landed between our read and this $unset) → re-read + retry;
    // the bulkWrite above is idempotent so re-upserting the (possibly now-stale) entries list is safe.
  }
  return { ok: false, error: 'rev conflict, retries exhausted' };
}

async function main(): Promise<void> {
  console.log(`[migrateEquipmentInv] ${DRY_RUN ? '[dry-run] ' : ''}starting`);
  console.log(`  mongo: ${MONGO_URI} / ${MONGO_DB}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const saves = db.collection<Document>('saves');
  const equipmentInstances = db.collection<Document>('equipmentInstances');
  await equipmentInstances.createIndex({ accountId: 1 });

  const filter = { 'save.equipmentInv': { $exists: true } };
  const total = await saves.countDocuments(filter);
  console.log(`${total} accounts still have the embedded equipmentInv field`);

  let processed = 0;
  let totalInstances = 0;
  let failed = 0;
  const cursor = saves.find(filter, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    const accountId = doc._id as string;
    const r = await migrateOneAccount(saves, equipmentInstances, accountId);
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
    `[migrateEquipmentInv] done: ${processed} accounts processed, ${totalInstances} instances, ${failed} failures, ${remaining} still pending ${DRY_RUN ? '(dry-run, no writes)' : ''}`,
  );
  if (!DRY_RUN && remaining > 0) {
    console.error('Re-run this script — some accounts did not complete (see FAILED lines above). Do NOT deploy the new app code yet.');
    process.exitCode = 1;
  }
  await client.close();
}

main().catch((e) => {
  console.error('[migrateEquipmentInv] failed:', e);
  process.exit(1);
});
