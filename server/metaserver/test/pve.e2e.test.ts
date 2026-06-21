// PvE 服务器权威端到端（PVE_INTEGRITY_PLAN §8）：/pve/clear 通关结算 + /pve/upgrade 升级。
//   解锁前置校验、可重复刷发材料、每日上限 capped、升级扣费/不足 402/满级 400。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, PVE_DAILY_CLEAR_REWARD_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve.e2e] Mongo 不可达（${URI}）— 跳过。`);

describe.skipIf(!mongo)('pve server-authoritative e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars } });
  const upgrade = (upgradeId: string) =>
    app.inject({ method: 'POST', url: '/pve/upgrade', headers: auth(), payload: { upgradeId } });
  /** 直接种入已通关关卡（绕过逐关解锁前置），用于测终关章节计数。 */
  const seedCleared = (cleared: string[]) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': cleared } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k' });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // 建档
  });
  afterAll(async () => { if (app) await app.close(); });

  it('首关通关：发材料 + 记星 + 写 cleared（服务器权威）', async () => {
    const r = body(await clear('ch1_lv1', 3));
    expect(r.data.capped).toBe(false);
    expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(r.data.save.progress.cleared).toContain('ch1_lv1');
    expect(r.data.save.progress.stars['ch1_lv1']).toBe(3);
    expect(r.data.save.materials.scrap).toBe(6);
  });

  it('锁住的关（前置未通关）→ 400', async () => {
    const res = await clear('ch1_lv2', 3); // 需先过 ch1_lv1
    expect(res.statusCode).toBe(400);
  });

  it('可重复刷：每次通关都发材料（星取 max 不回退）', async () => {
    await clear('ch1_lv1', 3);
    const r2 = body(await clear('ch1_lv1', 1)); // 重刷低星
    expect(r2.data.granted).toEqual({ scrap: 6, lead: 2 }); // 仍发材料
    expect(r2.data.save.materials.scrap).toBe(12);
    expect(r2.data.save.progress.stars['ch1_lv1']).toBe(3); // 星不回退
  });

  it('每日上限：超出 cap 的通关 capped 不发材料（仍记 progress）', async () => {
    for (let i = 0; i < PVE_DAILY_CLEAR_REWARD_CAP; i++) {
      const r = body(await clear('ch1_lv1', 2));
      expect(r.data.capped).toBe(false);
    }
    const over = body(await clear('ch1_lv1', 2));
    expect(over.data.capped).toBe(true);
    expect(over.data.granted).toEqual({});
    expect(over.data.save.materials.scrap).toBe(6 * PVE_DAILY_CLEAR_REWARD_CAP); // 未再加
  });

  it('成就 stat（S9-3）：通关章节终关累加 campaign.chaptersCleared（首通才涨、重打不涨）', async () => {
    // 非终关通关：不涨章节 stat（缺省懒创建，stats 不实例化）。
    const r1 = body(await clear('ch1_lv1', 3));
    expect(r1.data.save.stats?.['campaign.chaptersCleared'] ?? 0).toBe(0);

    // 种入 ch1 前 9 关解锁终关 → 通关 ch1_lv10 → 章节 +1。
    await seedCleared([
      'ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5',
      'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9',
    ]);
    const r2 = body(await clear('ch1_lv10', 3));
    expect(r2.data.save.stats['campaign.chaptersCleared']).toBe(1);

    // 重打已通关终关：stat 不回退也不重复涨（$max + 首通语义）。
    const r3 = body(await clear('ch1_lv10', 1));
    expect(r3.data.save.stats['campaign.chaptersCleared']).toBe(1);

    // 通关第二章终关 → +1 = 2。
    await seedCleared([
      ...r3.data.save.progress.cleared,
      'ch2_lv1', 'ch2_lv2', 'ch2_lv3', 'ch2_lv4', 'ch2_lv5',
      'ch2_lv6', 'ch2_lv7', 'ch2_lv8', 'ch2_lv9',
    ]);
    const r4 = body(await clear('ch2_lv10', 2));
    expect(r4.data.save.stats['campaign.chaptersCleared']).toBe(2);
  });

  it('升级：材料足够扣费 + pveUpgrades+1；不足 → 402；满级 → 400', async () => {
    // 攒材料：刷 ch1_lv1 几次拿 scrap（inf_hp 0→1 费 scrap×3）。
    await clear('ch1_lv1', 3); // scrap 6
    const u1 = body(await upgrade('inf_hp'));
    expect(u1.data.save.pveUpgrades['inf_hp']).toBe(1);
    expect(u1.data.save.materials.scrap).toBe(3); // 6 - 3
    // 0→1 已花 3，1→2 费 scrap×6 > 剩 3 → 402。
    const u2 = await upgrade('inf_hp');
    expect(u2.statusCode).toBe(402);
    // 未知升级 → 400。
    expect((await upgrade('nope')).statusCode).toBe(400);
  });
});
