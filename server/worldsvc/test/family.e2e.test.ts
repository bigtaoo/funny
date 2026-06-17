// worldsvc FamilyService 端到端（S8-4）：真实 Mongo 专属库。Mongo 不可达整套 skip。
// 创建家族 / 加入 / 离开 / 踢人 / 设角色 / 消息频道 / 解散；
// 校验：TAG 唯一冲突 / 已在家族 / 人数上限 / 权限守卫 / leader 不可直接离开。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { familyId, familyMemberId, FAMILY_CAP } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { FamilyService } from '../src/familyService';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_family_test';
const W = 'fam-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.family.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('FamilyService e2e', () => {
  let svc: FamilyService;
  const pushed: Array<{ to: string; msg: unknown }> = [];

  beforeEach(async () => {
    const cols = mongo!.collections;
    await cols.families.deleteMany({});
    await cols.familyMembers.deleteMany({});
    await cols.familyMessages.deleteMany({});
    await cols.playerWorld.deleteMany({});
    pushed.length = 0;

    svc = new FamilyService({
      cols,
      now: () => Date.now(),
      gateway: {
        available: true,
        push: async (to, msg) => { pushed.push({ to, msg }); },
      },
    });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  it('创建家族 + 详情', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha Wolf', 'AW');
    expect(detail.familyId).toBe(familyId(W, 'AW'));
    expect(detail.leaderId).toBe('alice');
    expect(detail.memberCount).toBe(1);
    expect(detail.members[0].role).toBe('leader');
  });

  it('TAG 重复 → ALREADY_IN_FAMILY(409)', async () => {
    await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await expect(svc.createFamily(W, 'bob', 'Another', 'AW')).rejects.toMatchObject({ code: 'ALREADY_IN_FAMILY' });
  });

  it('已在家族 → ALREADY_IN_FAMILY', async () => {
    await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await expect(svc.createFamily(W, 'alice', 'Beta', 'BT')).rejects.toMatchObject({ code: 'ALREADY_IN_FAMILY' });
  });

  it('加入 + 列出', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    const families = await svc.listFamilies(W);
    expect(families[0].memberCount).toBe(2);
  });

  it('家族不存在 → NOT_FOUND', async () => {
    await expect(svc.joinFamily(W, 'bob', familyId(W, 'XX'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('人数超上限 → FAMILY_FULL（stub：将上限降到 1）', async () => {
    // 直接 insertOne 一个 1 人满的家族（成员+家族文档），再尝试加入
    const cols = mongo!.collections;
    const fid = familyId(W, 'FL');
    await cols.families.insertOne({ _id: fid, worldId: W, name: 'Full', tag: 'FL', leaderId: 'alice', memberCount: FAMILY_CAP, territoryCount: 0, rev: 1 });
    await cols.familyMembers.insertOne({ _id: familyMemberId(W, 'alice'), worldId: W, accountId: 'alice', familyId: fid, role: 'leader', joinedAt: 0 });
    await expect(svc.joinFamily(W, 'bob', fid)).rejects.toMatchObject({ code: 'FAMILY_FULL' });
  });

  it('leader 不可直接离开 → BAD_REQUEST', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await expect(svc.leaveFamily(W, 'alice')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('member 离开 → memberCount 减少', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await svc.leaveFamily(W, 'bob');
    const families = await svc.listFamilies(W);
    expect(families[0].memberCount).toBe(1);
  });

  it('踢出成员', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await svc.kickMember(W, 'alice', 'bob');
    const after = await svc.getFamily(detail.familyId);
    expect(after?.memberCount).toBe(1);
    expect(after?.members.map((m) => m.accountId)).not.toContain('bob');
  });

  it('踢 leader → NO_PERMISSION', async () => {
    const d1 = await svc.createFamily(W, 'alice', 'A', 'AA');
    const d2 = await svc.createFamily(W, 'eve', 'E', 'EE');
    await svc.joinFamily(W, 'bob', d1.familyId);
    // alice 是 leader 不能被 bob（member）踢
    await expect(svc.kickMember(W, 'bob', 'alice')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
    // eve 也无法踢 alice（不同家族）
    await expect(svc.kickMember(W, 'eve', 'alice')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('设角色 elder → member 角色更新', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await svc.setRole(W, 'alice', 'bob', 'elder');
    const after = await svc.getFamily(detail.familyId);
    const bob = after?.members.find((m) => m.accountId === 'bob');
    expect(bob?.role).toBe('elder');
  });

  it('非 leader 设角色 → NO_PERMISSION', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await svc.joinFamily(W, 'carol', detail.familyId);
    await expect(svc.setRole(W, 'bob', 'carol', 'elder')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('频道消息 + 推送给其他成员', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    const msg = await svc.sendMessage(W, 'alice', 'Alice', 'Hello!');
    expect(msg.body).toBe('Hello!');
    expect(pushed.some((p) => p.to === 'bob')).toBe(true);
    const hist = await svc.getChannel(W, 'bob');
    expect(hist.length).toBe(1);
    expect(hist[0].body).toBe('Hello!');
  });

  it('非成员发消息 → NOT_IN_FAMILY', async () => {
    await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await expect(svc.sendMessage(W, 'eve', 'Eve', 'Hi')).rejects.toMatchObject({ code: 'NOT_IN_FAMILY' });
  });

  it('解散家族 → 所有成员/消息清除', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await svc.sendMessage(W, 'alice', 'Alice', 'Bye');
    await svc.dissolveFamily(W, 'alice');
    const after = await svc.getFamily(detail.familyId);
    expect(after).toBeNull();
    const members = await mongo!.collections.familyMembers.countDocuments({ familyId: detail.familyId });
    expect(members).toBe(0);
  });

  it('非 leader 解散 → NO_PERMISSION', async () => {
    const detail = await svc.createFamily(W, 'alice', 'Alpha', 'AW');
    await svc.joinFamily(W, 'bob', detail.familyId);
    await expect(svc.dissolveFamily(W, 'bob')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });
});
