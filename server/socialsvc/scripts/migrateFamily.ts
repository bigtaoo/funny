#!/usr/bin/env node
// 存量家族数据迁移：worldsvc families 集合 → nw_social families（SOCIAL_SVC_DESIGN §6 P1 step8）。
// 用法：npx tsx server/socialsvc/scripts/migrateFamily.ts
//
// 行为：
//   - 按 worldId 分组；同一 TAG 在 nw_social 中已存在时加 _2、_3 … 后缀（打印冲突日志）。
//   - 去掉 worldId 字段；FamilyMemberDoc._id 从 `{worldId}:{accountId}` 改为 accountId。
//   - 干跑模式：传 --dry-run 只打印不写入。
//   - 幂等：已存在同 _id 的 family 跳过（不覆盖）。
import { MongoClient } from 'mongodb';

const WORLD_MONGO_URI = process.env.NW_WORLD_MONGO_URI ?? process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const WORLD_MONGO_DB  = process.env.NW_WORLD_MONGO_DB  ?? 'notebook_wars_world';
const SOCIAL_MONGO_URI = process.env.NW_SOCIAL_MONGO_URI ?? process.env.NW_MONGO_URI ?? 'mongodb://localhost:27017';
const SOCIAL_MONGO_DB  = process.env.NW_SOCIAL_MONGO_DB  ?? 'nw_social';
const DRY_RUN = process.argv.includes('--dry-run');

// worldsvc FamilyDoc 结构（含 worldId）
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

// worldsvc FamilyMemberDoc 结构
interface WFamilyMemberDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  familyId: string;
  role: string;
  joinedAt: number;
}

// worldsvc FamilyMessageDoc 结构
interface WFamilyMessageDoc {
  _id: string;
  worldId: string;
  familyId: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: Date;
}

// nw_social FamilyDoc 结构（无 worldId）
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
  console.log(`[migrateFamily] ${DRY_RUN ? '【dry-run】' : ''}开始迁移`);
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

  // 收集 nw_social 中已存在的 TAG（避免冲突）
  const existingTags = new Set<string>();
  for await (const doc of sFamilies.find({}, { projection: { tag: 1 } })) {
    existingTags.add(doc.tag.toUpperCase());
  }

  const allWorldFamilies = await wFamilies.find({}).toArray();
  console.log(`[migrateFamily] 发现 ${allWorldFamilies.length} 个 worldsvc 家族`);

  let migratedFamilies = 0;
  let skippedFamilies  = 0;
  let conflictTags     = 0;

  const oldToNewFamilyId = new Map<string, string>(); // worldsvc _id → nw_social _id

  const now = Date.now();

  for (const wf of allWorldFamilies) {
    // 解析原 worldsvc familyId（格式：f:{worldId}:{TAG}）→ 目标 nw_social _id = fam:{TAG}
    let tag = wf.tag.toUpperCase();
    if (existingTags.has(tag)) {
      // TAG 冲突：加后缀 _2、_3 …
      let suffix = 2;
      while (existingTags.has(`${tag}_${suffix}`)) suffix++;
      const newTag = `${tag}_${suffix}`;
      console.warn(`[migrateFamily] TAG 冲突：${tag} → ${newTag}（worldId=${wf.worldId}, familyId=${wf._id}）`);
      tag = newTag;
      conflictTags++;
    }
    existingTags.add(tag);

    const newFamilyId = `fam:${tag}`;
    oldToNewFamilyId.set(wf._id, newFamilyId);

    // 幂等：已存在则跳过
    const existing = await sFamilies.findOne({ _id: newFamilyId });
    if (existing) {
      console.log(`[migrateFamily] 跳过（已存在）：${newFamilyId}`);
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

  // 迁移 familyMembers
  let migratedMembers = 0;
  for await (const wm of wMembers.find({})) {
    const newFamilyId = oldToNewFamilyId.get(wm.familyId);
    if (!newFamilyId) continue; // 对应家族未迁移（已存在/冲突导致映射缺失）

    const newMemberId = wm.accountId; // nw_social _id = accountId
    const existing = await sMembers.findOne({ _id: newMemberId });
    if (existing) continue; // 同一 accountId 已在某家族，跳过

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

  // 迁移 familyMessages
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

  console.log(`\n[migrateFamily] 完成${DRY_RUN ? '（dry-run）' : ''}：`);
  console.log(`  家族：迁移 ${migratedFamilies}，跳过 ${skippedFamilies}，TAG 冲突 ${conflictTags}`);
  console.log(`  成员：迁移 ${migratedMembers}`);
  console.log(`  消息：迁移 ${migratedMsgs}`);
}

main().catch((e) => {
  console.error('[migrateFamily] 失败：', e);
  process.exit(1);
});
