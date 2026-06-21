// SLG 大区赛季运维 e2e（§17.5/§17.6/§17.7/§17.11）：真实 Mongo 专属库。Mongo 不可达整套 skip。
//   • settleSeason：落 seasonResults（幂等 _id）+ 发奖邮件（材料/皮肤，中原首府 ×2，dispatchKey 幂等）；
//   • resetSeason：守卫（须先 settle）+ 分批清档 + 家族赛季态归零 + status→open + engineVersion 重 pin + 幂等续跑；
//   • admin /admin/world/* X-Internal-Key 门控（无 key / JWT 玩家被拒，有 key 通）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  signToken, familyId, SLG_MAP_W, SLG_MAP_H,
  SETTLE_REWARDS, CENTER_CAPITAL_IDX, CENTER_CAPITAL_MULT,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import { createWorldMongo, type WorldMongo, type FamilyDoc, type FamilyMemberDoc, type NationDoc, type WorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import type { WorldMailClient, WorldMailContent } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_seasonops_test';
const W = 's5-ops';
const SEASON = 5;
const SECRET = 'test-jwt-secret';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.season-ops.e2e] Mongo 不可达（${URI}）— 跳过。`);

interface MailCall { accountId: string; dispatchKey: string; content: WorldMailContent }

describe.skipIf(!mongo)('worldsvc 赛季运维 e2e', () => {
  const m = mongo!;
  const mailCalls: MailCall[] = [];
  const fakeMail: WorldMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) { mailCalls.push({ accountId, dispatchKey, content }); },
  };
  const svc = new WorldService({
    cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, mail: fakeMail, now: () => 1_700_000_000_000,
  });

  /** 重置数据 + 造一个 active 世界 + 两个家族占国（alice 家族占中原 9 + 角 0；bob 家族占 1）。 */
  async function seed(status: WorldDoc['status'] = 'active'): Promise<void> {
    const c = m.collections;
    await Promise.all([
      c.worlds.deleteMany({}), c.families.deleteMany({}), c.familyMembers.deleteMany({}),
      c.nations.deleteMany({}), c.seasonResults.deleteMany({}), c.tiles.deleteMany({}),
      c.marches.deleteMany({}), c.playerWorld.deleteMany({}), c.sects.deleteMany({}), c.sectMessages.deleteMany({}),
    ]);
    mailCalls.length = 0;
    await c.worlds.insertOne({
      _id: W, season: SEASON, shard: 5, status, mapW: SLG_MAP_W, mapH: SLG_MAP_H,
      openAt: 1, capacity: 10000, population: 2, engineVersion: ENGINE_VERSION, rev: 1,
    });
    const fam = (tag: string, leader: string): FamilyDoc => ({
      _id: familyId(W, tag), worldId: W, name: `Fam${tag}`, tag, leaderId: leader,
      memberCount: 1, territoryCount: 1, prosperity: 1000, activity: 100, prosperityUpdatedAt: 1, rev: 1,
    });
    const mem = (tag: string, acct: string): FamilyMemberDoc => ({
      _id: `${W}:${acct}`, worldId: W, accountId: acct, familyId: familyId(W, tag), role: 'leader', joinedAt: 1,
    });
    await c.families.insertMany([fam('AA', 'alice'), fam('BB', 'bob')]);
    await c.familyMembers.insertMany([mem('AA', 'alice'), mem('BB', 'bob')]);
    const nation = (idx: number, owner: string, tag: string): NationDoc => ({
      _id: `nation:${W}:${idx}`, worldId: W, capitalIdx: idx, x: idx, y: idx,
      ownerId: owner, familyId: familyId(W, tag), rev: 1,
    });
    await c.nations.insertMany([
      nation(CENTER_CAPITAL_IDX, 'alice', 'AA'), // 中原首府
      nation(0, 'alice', 'AA'),                  // 角（AA 共 2 国 → 冠军）
      nation(1, 'bob', 'BB'),                    // BB 1 国 → top3
    ]);
  }

  afterAll(async () => {
    await m.db.dropDatabase();
  });

  it('settle：落 seasonResults（幂等）+ 发奖邮件（中原首府材料 ×2）', async () => {
    await seed('active');
    const ranking = await svc.settleSeason(W);
    expect(ranking[0]).toMatchObject({ scope: 'family', familyId: familyId(W, 'AA'), nationCount: 2 });

    // seasonResults 落库（_id 幂等键 + tier）。
    const doc = await m.collections.seasonResults.findOne({ _id: `${W}:s${SEASON}` });
    expect(doc).toBeTruthy();
    expect(doc!.ranking[0]).toMatchObject({ rank: 1, tier: 'champion', id: familyId(W, 'AA') });

    // 冠军 alice 收奖邮件：中原首府 → scrap ×2。材料走 kind:'material'（→ SaveData.materials
    // 养成统一池，SLG8），非泛用 'item'（后者落 inventory.items 孤儿桶）。
    const aliceMail = mailCalls.find((x) => x.accountId === 'alice');
    expect(aliceMail).toBeTruthy();
    expect(aliceMail!.dispatchKey).toBe(`slg-settle:${W}:s${SEASON}`);
    const scrap = aliceMail!.content.attachments!.find((a) => a.kind === 'material' && a.id === 'scrap');
    expect(scrap!.count).toBe(SETTLE_REWARDS.champion.items.scrap * CENTER_CAPITAL_MULT);

    // 重入：world 已 settling，再 settle 不重复落库（$setOnInsert）。
    const before = doc!.settledAt;
    await svc.settleSeason(W);
    const again = await m.collections.seasonResults.findOne({ _id: `${W}:s${SEASON}` });
    expect(again!.settledAt).toBe(before);
    expect(await m.collections.seasonResults.countDocuments({ worldId: W })).toBe(1);
  });

  it('reset：未 settle 直接 reset 被拒（防丢历史）', async () => {
    await seed('active'); // status=active，未 settle
    await expect(svc.resetSeason(W)).rejects.toMatchObject({ code: 'WORLD_CLOSED' });
  });

  it('reset：settle 后清档 + 家族赛季态归零 + status open + engineVersion 重 pin', async () => {
    await seed('active');
    await svc.settleSeason(W);              // → settling
    await svc.resetSeason(W);               // settling → resetting → open

    const w = await m.collections.worlds.findOne({ _id: W });
    expect(w!.status).toBe('open');
    expect(w!.population).toBe(0);
    expect(w!.engineVersion).toBe(ENGINE_VERSION);
    expect(await m.collections.nations.countDocuments({ worldId: W, ownerId: { $exists: true } })).toBe(0);

    const aa = await m.collections.families.findOne({ _id: familyId(W, 'AA') });
    expect(aa).toMatchObject({ territoryCount: 0, prosperity: 0, activity: 0 });
    expect(aa!.sectId).toBeUndefined();
  });

  it('reset：resetting 中间态可续跑（幂等）', async () => {
    await seed('resetting'); // 模拟上次 reset 崩在 resetting
    await expect(svc.resetSeason(W)).resolves.toBeTruthy();
    expect((await m.collections.worlds.findOne({ _id: W }))!.status).toBe('open');
  });

  describe('admin /admin/world/* X-Internal-Key 门控（C4）', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      await seed('active');
      server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: KEY }, svc, {} as never, {} as never, {} as never);
      await new Promise<void>((res) => server.on('listening', res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => server?.close());

    it('无 key → 401', async () => {
      const r = await fetch(`${base}/admin/world/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(401);
      server.close();
    });

    it('JWT 玩家（无 internal key）调 reset → 401', async () => {
      const token = signToken('acct-player', { secret: SECRET });
      const r = await fetch(`${base}/admin/world/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(401);
      server.close();
    });

    it('有 X-Internal-Key → 200（list + settle 通）', async () => {
      const list = await fetch(`${base}/admin/world/list`, { headers: { 'x-internal-key': KEY } });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { ok: boolean; data: Array<{ worldId: string }> };
      expect(body.data.some((x) => x.worldId === W)).toBe(true);

      const r = await fetch(`${base}/admin/world/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': KEY }, body: JSON.stringify({ worldId: W }),
      });
      expect(r.status).toBe(200);
      server.close();
    });
  });
});
