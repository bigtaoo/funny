#!/usr/bin/env node
// Migrate existing friend / private-chat / mail data: notebook_wars → nw_social (SOCIAL_SVC_DESIGN §6 P2 step3).
// Usage: npx tsx server/socialsvc/scripts/migrateSocial.ts [--dry-run]
//
// Behaviour:
//   - Migrates friendEdges / friendRequests / blockList / conversations / chatMessages / mails.
//   - Idempotent: documents with the same _id already in the destination are skipped ($setOnInsert).
//   - Dry-run mode: pass --dry-run to print without writing.
import { MongoClient } from 'mongodb';

const META_MONGO_URI = process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const META_MONGO_DB  = process.env.NW_MONGO_DB  ?? 'notebook_wars';
const SOCIAL_MONGO_URI = process.env.NW_SOCIAL_MONGO_URI ?? process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const SOCIAL_MONGO_DB  = process.env.NW_SOCIAL_MONGO_DB  ?? 'nw_social';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

async function migrateCollection(
  src: ReturnType<ReturnType<typeof MongoClient.prototype.db>['collection']>,
  dst: ReturnType<ReturnType<typeof MongoClient.prototype.db>['collection']>,
  name: string,
): Promise<number> {
  let migrated = 0;
  let skipped = 0;
  const batch: object[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const docs = batch.splice(0);
    const ops = docs.map((d) => ({
      updateOne: {
        filter: { _id: (d as { _id: unknown })._id },
        update: { $setOnInsert: d },
        upsert: true,
      },
    }));
    if (!DRY_RUN) {
      const res = await dst.bulkWrite(ops, { ordered: false });
      migrated += res.upsertedCount;
      skipped += docs.length - res.upsertedCount;
    } else {
      console.log(`[dry-run] ${name}: would upsert ${docs.length} docs`);
      migrated += docs.length;
    }
  };

  for await (const doc of src.find({})) {
    batch.push(doc);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`  ${name}: migrated=${migrated}, skipped=${skipped}`);
  return migrated;
}

async function main(): Promise<void> {
  console.log(`[migrateSocial] ${DRY_RUN ? '[dry-run] ' : ''}starting migration`);
  console.log(`  meta:   ${META_MONGO_URI} / ${META_MONGO_DB}`);
  console.log(`  social: ${SOCIAL_MONGO_URI} / ${SOCIAL_MONGO_DB}`);

  const metaClient   = new MongoClient(META_MONGO_URI);
  const socialClient = new MongoClient(SOCIAL_MONGO_URI);
  await metaClient.connect();
  await socialClient.connect();

  const metaDb   = metaClient.db(META_MONGO_DB);
  const socialDb = socialClient.db(SOCIAL_MONGO_DB);

  const collections = [
    ['friendEdges',    'friendEdges'],
    ['friendRequests', 'friendRequests'],
    ['blocks',         'blockList'],      // metaserver uses 'blocks', socialsvc uses 'blockList'
    ['conversations',  'conversations'],
    ['chatMessages',   'chatMessages'],
    ['mail',           'mails'],          // metaserver uses 'mail', socialsvc uses 'mails'
  ] as const;

  for (const [srcName, dstName] of collections) {
    await migrateCollection(
      metaDb.collection(srcName),
      socialDb.collection(dstName),
      `${srcName} → ${dstName}`,
    );
  }

  await metaClient.close();
  await socialClient.close();
  console.log('[migrateSocial] done');
}

main().catch((e) => {
  console.error('[migrateSocial] failed:', e);
  process.exit(1);
});
