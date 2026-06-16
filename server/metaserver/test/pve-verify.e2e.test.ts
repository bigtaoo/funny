// PvE L1 录像抽检复算端到端（PVE_INTEGRITY_PLAN §8.6 第 3 步）：真实 Mongo + 注入假 gateway 裁判。
//   首通触发抽检 → 材料暂扣 + needsReplay/verifyId；/pve/verify 复算通过发材料 / 星数不符判可疑不发 /
//   无裁判可裁 benefit-of-doubt 发；重复上传幂等；无 gateway 时不抽检（直接发，回归既有行为）。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../dist/gatewayClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pveverify_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve-verify.e2e] Mongo 不可达（${URI}）— 跳过。`);

/** 可配置假裁判：记录最后一次 judge 入参，按设定回 verdict。 */
class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, stars: 3, judgeAccountId: 'judge-1' };
  last?: JudgeReq;
  async judge(req: JudgeReq): Promise<JudgeRes> {
    this.last = req;
    return this.next;
  }
  async push(): Promise<void> {}
  async presence(): Promise<Record<string, boolean>> {
    return {};
  }
  async invalidateFriends(): Promise<void> {}
}

describe.skipIf(!mongo)('pve L1 verify e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  let token: string;
  const b = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3, pveUpgrades?: Record<string, number>) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars, ...(pveUpgrades ? { pveUpgrades } : {}) } });
  const verify = (verifyId: string, endFrame = 100) =>
    app.inject({ method: 'POST', url: '/pve/verify', headers: auth(), payload: { verifyId, endFrame, frames: [] } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway });
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-verify-dev-1' } }));
    token = r.data.token;
  });
  afterAll(async () => { if (app) await app.close(); });

  it('首通被抽中：材料暂扣 + needsReplay/verifyId；progress/stars 已写', async () => {
    const r = b(await clear('ch1_lv1', 3));
    expect(r.data.needsReplay).toBe(true);
    expect(typeof r.data.verifyId).toBe('string');
    expect(r.data.granted).toEqual({}); // 暂不发材料
    expect(r.data.save.materials.scrap ?? 0).toBe(0);
    expect(r.data.save.progress.cleared).toContain('ch1_lv1'); // 解锁照常
    expect(r.data.save.progress.stars['ch1_lv1']).toBe(3);
  });

  it('复算通过（星数≥声称）→ 发材料 + verified', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 3 };
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(v.data.save.materials.scrap).toBe(6);
    // 裁判收到 PvE 复算入参（levelId + 服务器权威蓝图）。
    expect(gateway.last?.levelId).toBe('ch1_lv1');
    expect(gateway.last?.pveUpgrades).toEqual({});
  });

  it('复算星数 < 声称 → 判可疑，不发材料', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 1 }; // 复算只 1 星，声称 3
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(false);
    expect(v.data.granted).toEqual({});
    expect(v.data.save.materials.scrap ?? 0).toBe(0);
  });

  it('无裁判可裁（ok:false）→ benefit-of-doubt 发材料', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: false }; // 无候选 / 超时 / 复算失败
    const v = b(await verify(c.data.verifyId));
    expect(v.data.verified).toBe(true);
    expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
  });

  it('重复上传同 verifyId → 幂等，不重复发', async () => {
    const c = b(await clear('ch1_lv1', 3));
    gateway.next = { ok: true, stars: 3 };
    await verify(c.data.verifyId);
    const again = b(await verify(c.data.verifyId));
    expect(again.data.granted).toEqual({}); // 已结算，不再发
    expect(again.data.save.materials.scrap).toBe(6); // 只发过一次
  });

  it('未知 / 越权 verifyId → 404', async () => {
    expect((await verify('no-such-id')).statusCode).toBe(404);
  });

  it('无 gateway 配置 → 不抽检，首通直接发材料（回归既有行为）', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k' }); // 无 gateway
    const r2 = b(await app2.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-verify-dev-2' } }));
    const res = b(await app2.inject({
      method: 'POST', url: '/pve/clear',
      headers: { authorization: `Bearer ${r2.data.token}` },
      payload: { levelId: 'ch1_lv1', stars: 3 },
    }));
    expect(res.data.needsReplay).toBeUndefined();
    expect(res.data.granted).toEqual({ scrap: 6, lead: 2 });
    await app2.close();
  });
});
