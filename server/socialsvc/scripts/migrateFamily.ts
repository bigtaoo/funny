#!/usr/bin/env node
// Migrate existing family data: worldsvc families collection → nw_social families (SOCIAL_SVC_DESIGN §6 P1 step8).
// Usage: npx tsx server/socialsvc/scripts/migrateFamily.ts
//
// Behaviour:
//   - Groups by worldId; if the same TAG already exists in nw_social, appends _2, _3 … suffix (logs the conflict).
//   - Drops the worldId field; FamilyMemberDoc._id changes from `{worldId}:{accountId}` to accountId.
//   - Dry-run mode: pass --dry-run to print only, without writing.
//   - Idempotent: skips any family whose _id already exists (no overwrite).
import { MongoClient } from 'mongodb';

const WORLD_MONGO_URI = process.env.NW_WORLD_MONGO_URI ?? process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const WORLD_MONGO_DB  = process.env.NW_WORLD_MONGO_DB  ?? 'notebook_wars_world';
const SOCIAL_MONGO_URI = process.env.NW_SOCIAL_MONGO_URI ?? process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const SOCIAL_MONGO_DB  = process.env.NW_SOCIAL_MONGO_DB  ?? 'nw_social';
const DRY_RUN = process.argv.includes('--dry-run');

// worldsvc FamilyDoc structure (includes worldId)
interface WFamilyDoc {
  _id: string;
  worldId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity?: number;
  prosperityUpdatedAt?: number;
  activity?: number;
  rev: number;
}

// worldsvc FamilyMemberDoc structure
interface WFamilyMemberDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  familyId: string;
  role: string;
  joinedAt: number;
}

// worldsvc FamilyMessageDoc structure
interface WFamilyMessageDoc {
  _id: string;
  worldId: string;
  familyId: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: Date;
}

// nw_social FamilyDoc structure (no worldId)
interface SFamilyDoc {
  _id: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  prosperity: number;
  prosperityUpdatedAt: number;
  activity: number;
  createdAt: number;
  rev: number;
}

async function main(): Promise<void> {
  console.log(`[migrateFamily] ${DRY_RUN ? '[dry-run] ' : ''}starting migration`);
  console.log(`  worldsvc: ${WORLD_MONGO_URI} / ${WORLD_MONGO_DB}`);
  console.log(`  social:   ${SOCIAL_MONGO_URI} / ${SOCIAL_MONGO_DB}`);

  const worldClient = new MongoClient(WORLD_MONGO_URI);
  const socialClient = new MongoClient(SOCIAL_MONGO_URI);

  await worldClient.connect();
  await socialClient.connect();

  const worldDb  = worldClient.db(WORLD_MONGO_DB);
  const socialDb = socialClient.db(SOCIAL_MONGO_DB);

  const wFamilies       = worldDb.collection<WFamilyDoc>('families');
  const wMembers        = worldDb.collection<WFamilyMemberDoc>('familyMembers');
  const wMessages       = worldDb.collection<WFamilyMessageDoc>('familyMessages');
  const sFamilies       = socialDb.collection<SFamilyDoc>('families');
  const sMembers        = socialDb.collection<{ _id: string; familyId: string; accountId: string; role: string; joinedAt: number }>('familyMembers');
  const sMessages       = socialDb.collection<{ _id: string; familyId: string; senderId: string; senderName: string; body: string; ts: Date }>('familyMessages');

  // Collect TAGs already present in nw_social (to avoid conflicts)
  const existingTags = new Set<string>();
  for await (const doc of sFamilies.find({}, { projection: { tag: 1 } })) {
    existingTags.add(doc.tag.toUpperCase());
  }

  const allWorldFamilies = await wFamilies.find({}).toArray();
  console.log(`[migrateFamily] found ${allWorldFamilies.length} worldsvc families`);

  let migratedFamilies = 0;
  let skippedFamilies  = 0;
  let conflictTags     = 0;

  const oldToNewFamilyId = new Map<string, string>(); // worldsvc _id → nw_social _id

  const now = Date.now();

  for (const wf of allWorldFamilies) {
    // Parse the original worldsvc familyId (format: f:{worldId}:{TAG}) → target nw_social _id = fam:{TAG}
    let tag = wf.tag.toUpperCase();
    if (existingTags.has(tag)) {
      // TAG conflict: append suffix _2, _3 …
      let suffix = 2;
      while (existingTags.has(`${tag}_${suffix}`)) suffix++;
      const newTag = `${tag}_${suffix}`;
      console.warn(`[migrateFamily] TAG conflict: ${tag} → ${newTag} (worldId=${wf.worldId}, familyId=${wf._id})`);
      tag = newTag;
      conflictTags++;
    }
    existingTags.add(tag);

    const newFamilyId = `fam:${tag}`;
    oldToNewFamilyId.set(wf._id, newFamilyId);

    // Idempotent: skip if already exists
    const existing = await sFamilies.findOne({ _id: newFamilyId });
    if (existing) {
      console.log(`[migrateFamily] skip (already exists): ${newFamilyId}`);
      skippedFamilies++;
      continue;
    }

    const sfDoc: SFamilyDoc = {
      _id: newFamilyId,
      name: wf.name,
      tag,
      leaderId: wf.leaderId,
      memberCount: wf.memberCount,
      prosperity: wf.prosperity ?? 0,
      prosperityUpdatedAt: wf.prosperityUpdatedAt ?? now,
      activity: wf.activity ?? 0,
      createdAt: now,
      rev: 0,
    };

    if (!DRY_RUN) {
      await sFamilies.insertOne(sfDoc);
    } else {
      console.log(`[dry-run] insertOne families: ${JSON.stringify(sfDoc)}`);
    }
    migratedFamilies++;
  }

  // Migrate familyMembers
  let migratedMembers = 0;
  for await (const wm of wMembers.find({})) {
    const newFamilyId = oldToNewFamilyId.get(wm.familyId);
    if (!newFamilyId) continue; // Corresponding family was not migrated (already existed / conflict caused missing mapping)

    const newMemberId = wm.accountId; // nw_social _id = accountId
    const existing = await sMembers.findOne({ _id: newMemberId });
    if (existing) continue; // Same accountId already belongs to a family, skip

    const smDoc = {
      _id: newMemberId,
      familyId: newFamilyId,
      accountId: wm.accountId,
      role: wm.role,
      joinedAt: wm.joinedAt,
    };

    if (!DRY_RUN) {
      await sMembers.insertOne(smDoc);
    } else {
      console.log(`[dry-run] insertOne familyMembers: ${JSON.stringify(smDoc)}`);
    }
    migratedMembers++;
  }

  // Migrate familyMessages
  let migratedMsgs = 0;
  for await (const wm of wMessages.find({})) {
    const newFamilyId = oldToNewFamilyId.get(wm.familyId);
    if (!newFamilyId) continue;

    const smDoc = {
      _id: wm._id,
      familyId: newFamilyId,
      senderId: wm.senderId,
      senderName: wm.senderName,
      body: wm.body,
      ts: wm.ts,
    };

    if (!DRY_RUN) {
      await sMessages.updateOne({ _id: wm._id }, { $setOnInsert: smDoc }, { upsert: true });
    } else {
      console.log(`[dry-run] upsert familyMessages: ${wm._id}`);
    }
    migratedMsgs++;
  }

  await worldClient.close();
  await socialClient.close();

  console.log(`\n[migrateFamily] done${DRY_RUN ? ' (dry-run)' : ''}:`);
  console.log(`  families: migrated ${migratedFamilies}, skipped ${skippedFamilies}, TAG conflicts ${conflictTags}`);
  console.log(`  members: migrated ${migratedMembers}`);
  console.log(`  messages: migrated ${migratedMsgs}`);
}

main().catch((e) => {
  console.error('[migrateFamily] failed:', e);
  process.exit(1);
});
