// worldsvc SectService 端到端（S8-4b）：真实 Mongo 专属库。Mongo 不可达整套 skip。
// 宗门 CRUD / 加入 / 退出 / 解散 / 联盟 / 罢免换届 / 频道；权限守卫（须族长）；建门扣金币。
// 另含 WorldService.settleSeason 按宗门聚合占国数。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sectId,
  familyId,
  SECT_CREATE_COST,
  SECT_ALLY_CAP,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type NationDoc } from '../src/db';
import { FamilyService } from '../src/familyService';
import { SectService } from '../src/sectService';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_sect_test';
const W = 'sect-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.sect.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('SectService e2e', () => {
  let fam: FamilyService;
  let sect: SectService;
  const spends: Array<{ accountId: string; amount: number }> = [];
  const grants: Array<{ accountId: string; amount: number }> = [];

  const commercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spends.push({ accountId, amount }); },
    async grant(accountId, amount) { grants.push({ accountId, amount }); },
  };

  // 捕获宗门频道扇出（broadcast 的收件人 + 消息），断言实时推送目标正确。
  const broadcasts: Array<{ recipients: string[]; kind: string; body?: string }> = [];
  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* sect 不走定向 push */ },
    async broadcast(recipients, msg) {
      broadcasts.push({ recipients, kind: msg.kind, body: (msg as { body?: string }).body });
    },
  };

  beforeEach(async () => {
    const cols = mongo!.collections;
    await Promise.all([
      cols.families.deleteMany({}),
      cols.familyMembers.deleteMany({}),
      cols.sects.deleteMany({}),
      cols.sectMessages.deleteMany({}),
      cols.playerWorld.deleteMany({}),
      cols.nations.deleteMany({}),
    ]);
    spends.length = 0;
    grants.length = 0;
    broadcasts.length = 0;
    fam = new FamilyService({ cols, now: () => Date.now() });
    sect = new SectService({ cols, commercial, gateway: fakeGateway, now: () => Date.now() });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  /**
   * 建一个家族并返回族长 accountId（每个家族一个 leader）。name 兜底补足 ≥2 字符。
   * 种入足量 activity（§17.4）：createSect 会 refreshFamilyProsperity 重算繁荣度（50 + activity*5），
   * 需 ≥ SECT_FOUND_PROSPERITY_MIN(2000) 才能建门；不关心门槛的用例由此默认满足。
   */
  async function makeFamily(leader: string, name: string, tag: string): Promise<string> {
    await fam.createFamily(W, leader, name.length >= 2 ? name : `Fam${name}`, tag);
    await mongo!.collections.families.updateOne({ _id: familyId(W, tag) }, { $set: { activity: 500 } });
    return leader;
  }

  it('建宗门：扣 5000 coin + 家族成为门主家族', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    const detail = await sect.createSect(W, 'alice', 'Sky Sect', 'SKY');
    expect(detail.sectId).toBe(sectId(W, 'SKY'));
    expect(detail.leaderId).toBe('alice');
    expect(detail.leaderFamilyId).toBe(familyId(W, 'AW'));
    expect(detail.memberFamilyCount).toBe(1);
    expect(spends).toEqual([{ accountId: 'alice', amount: SECT_CREATE_COST }]);
  });

  it('建宗门繁荣度门槛：低繁荣度家族 → PROSPERITY_TOO_LOW（G2/§17.4）', async () => {
    // 直接建族不补 activity → 繁荣度仅 = memberCount*50 = 50 < 2000，应被拦。
    await fam.createFamily(W, 'poor', 'Poor', 'PR');
    await expect(sect.createSect(W, 'poor', 'Broke', 'BRK')).rejects.toMatchObject({ code: 'PROSPERITY_TOO_LOW' });
  });

  it('非族长不能建宗门 → NO_PERMISSION', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await fam.joinFamily(W, 'bob', familyId(W, 'AW')); // bob = member
    await expect(sect.createSect(W, 'bob', 'X', 'XX')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('不在家族不能建宗门 → NOT_IN_FAMILY', async () => {
    await expect(sect.createSect(W, 'nobody', 'X', 'XX')).rejects.toMatchObject({ code: 'NOT_IN_FAMILY' });
  });

  it('家族已在门 → ALREADY_IN_SECT', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await expect(sect.createSect(W, 'alice', 'Other', 'OTH')).rejects.toMatchObject({ code: 'ALREADY_IN_SECT' });
  });

  it('TAG 撞键 → ALREADY_IN_SECT + 退款', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('carol', 'Gamma', 'GA');
    await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await expect(sect.createSect(W, 'carol', 'Sky2', 'SKY')).rejects.toMatchObject({ code: 'ALREADY_IN_SECT' });
    expect(grants.length).toBe(1); // 退款
  });

  it('加入 + 列出 + 详情', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('bob', 'Beta', 'BT');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    const list = await sect.listSects(W);
    expect(list[0].memberFamilyCount).toBe(2);
    const detail = await sect.getSect(s.sectId);
    expect(detail!.memberFamilies.map((f) => f.tag).sort()).toEqual(['AW', 'BT']);
  });

  it('退门：成员家族可退；门主家族不可直接退', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('bob', 'Beta', 'BT');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.leaveSect(W, 'bob');
    expect((await sect.getSect(s.sectId))!.memberFamilyCount).toBe(1);
    await expect(sect.leaveSect(W, 'alice')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('联盟：双向 + 上限 SECT_ALLY_CAP', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    await makeFamily('dave', 'D', 'DD');
    const a = await sect.createSect(W, 'alice', 'SA', 'SA');
    const b = await sect.createSect(W, 'bob', 'SB', 'SB');
    const c = await sect.createSect(W, 'carol', 'SC', 'SC');
    const d = await sect.createSect(W, 'dave', 'SD', 'SD');
    await sect.allySect(W, 'alice', b.sectId);
    await sect.allySect(W, 'alice', c.sectId);
    // 双向写入
    expect((await sect.getSect(a.sectId))!.allySectIds.sort()).toEqual([b.sectId, c.sectId].sort());
    expect((await sect.getSect(b.sectId))!.allySectIds).toContain(a.sectId);
    // 超上限 → ALLY_CAP_REACHED
    expect(SECT_ALLY_CAP).toBe(2);
    await expect(sect.allySect(W, 'alice', d.sectId)).rejects.toMatchObject({ code: 'ALLY_CAP_REACHED' });
  });

  it('罢免换届：2/3 族长投票 → 门主转移', async () => {
    // 3 家族入门 → needed = ceil(3 * 2/3) = 2
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.joinSect(W, 'carol', s.sectId);

    const nominee = familyId(W, 'BB');
    const r1 = await sect.voteRemoveLeader(W, 'bob', nominee);
    expect(r1).toMatchObject({ passed: false, voteCount: 1, needed: 2 });
    const r2 = await sect.voteRemoveLeader(W, 'carol', nominee);
    expect(r2.passed).toBe(true);
    const after = await sect.getSect(s.sectId);
    expect(after!.leaderId).toBe('bob');
    expect(after!.leaderFamilyId).toBe(nominee);
  });

  it('频道：成员发/读；非成员 → NOT_IN_SECT', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB'); // 不入门
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.sendMessage(W, 'alice', 'Alice', 'hello sect');
    const msgs = await sect.getChannel(W, 'alice');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('hello sect');
    await expect(sect.getChannel(W, 'bob')).rejects.toMatchObject({ code: 'NOT_IN_SECT' });
    void s;
  });

  it('频道实时扇出：broadcast 推给宗门内其他成员，发送者自己不在收件人列表', async () => {
    // alice（门主家族）+ bob + carol 三家族同宗；bob、carol 各带一名 member。
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    await fam.joinFamily(W, 'bob2', familyId(W, 'BB'));
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.joinSect(W, 'carol', s.sectId);

    await sect.sendMessage(W, 'alice', 'Alice', 'hello everyone');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].kind).toBe('sect_msg');
    expect(broadcasts[0].body).toBe('hello everyone');
    // 收件人 = 宗门内全部成员去掉发送者 alice：bob、bob2、carol（无序）。
    expect([...broadcasts[0].recipients].sort()).toEqual(['bob', 'bob2', 'carol']);
    expect(broadcasts[0].recipients).not.toContain('alice');
  });

  it('解散：清成员 sectId + 删频道 + 双向解盟', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    const a = await sect.createSect(W, 'alice', 'SA', 'SA');
    const b = await sect.createSect(W, 'bob', 'SB', 'SB');
    await sect.allySect(W, 'alice', b.sectId);
    await sect.sendMessage(W, 'alice', 'Alice', 'hi');
    await sect.dissolveSect(W, 'alice');
    expect(await sect.getSect(a.sectId)).toBeNull();
    // 盟友 b 的 allySectIds 已移除 a
    expect((await sect.getSect(b.sectId))!.allySectIds).not.toContain(a.sectId);
    // alice 家族 sectId 已清
    const fAlice = await mongo!.collections.families.findOne({ _id: familyId(W, 'AA') });
    expect(fAlice!.sectId).toBeUndefined();
  });

  it('settleSeason：按宗门聚合占国数（sect > family > solo）', async () => {
    const cols = mongo!.collections;
    // alice+bob 同宗 SKY；carol 散家族；dave 无家族个人。
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);

    const nation = (capitalIdx: number, ownerId: string, fid?: string): NationDoc => ({
      _id: `nation:${W}:${capitalIdx}`,
      worldId: W, capitalIdx, x: capitalIdx, y: capitalIdx,
      ownerId, ...(fid ? { familyId: fid } : {}), rev: 1,
    });
    await cols.nations.insertMany([
      nation(0, 'alice', familyId(W, 'AA')), // SKY
      nation(1, 'bob', familyId(W, 'BB')),   // SKY
      nation(2, 'carol', familyId(W, 'CC')), // 散家族 CC
      nation(3, 'dave'),                     // solo
    ]);

    const svc = new WorldService({ cols, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => Date.now() });
    const ranking = await svc.settleSeason(W);
    // SKY 占 2 国排第一
    expect(ranking[0]).toMatchObject({ scope: 'sect', familyId: s.sectId, nationCount: 2 });
    const carol = ranking.find((r) => r.scope === 'family');
    expect(carol).toMatchObject({ familyId: familyId(W, 'CC'), nationCount: 1 });
    const dave = ranking.find((r) => r.scope === 'solo');
    expect(dave).toMatchObject({ familyId: 'dave', nationCount: 1 });
  });
});
