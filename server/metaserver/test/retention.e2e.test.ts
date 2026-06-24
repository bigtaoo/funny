// 留存端点端到端（B5）：真实 Mongo + 注入假 commercial。验证 GET /retention 回包里
// defs.rewards / defs.tasks 的字段（kind/count、id/points）经 fastify-openapi-glue
// 序列化后**不被剥掉**——回归 2026-06-24 签到月历 `+undefined`（RETENTION_DESIGN §10.1）。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { CommercialClient, UndeliveredOrder } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_retention_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[retention.e2e] Mongo 不可达（${URI}）— 跳过。`);

/** 最小假 commercial：getWallet + grant 幂等；其余 claim 路径不触达，给桩。 */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {} };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
    return [];
  }
  async shopCharge() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async gachaDraw() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async orderDelivered() {
    return { ok: true as const };
  }
  async rechargeVerify() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async adsCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async victoryCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }
  async spend(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
}

describe.skipIf(!mongo)('meta retention e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: new FakeCommercial() });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-ret-1' } }));
    token = r.data.token;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // 建档
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('GET /retention：defs.rewards / defs.tasks 字段经序列化保留（不被剥成 {}）', async () => {
    const r = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
    expect(r.ok).toBe(true);

    // —— 核心回归断言：字段必须存在且为正确类型 ——
    expect(Array.isArray(r.data.defs.rewards)).toBe(true);
    expect(r.data.defs.rewards.length).toBe(30);
    // 第 1 格 = 体力 30；第 7 格（index 6）= 里程碑金币。
    expect(r.data.defs.rewards[0]).toMatchObject({ kind: 'stamina', count: 30 });
    expect(r.data.defs.rewards[6]).toMatchObject({ kind: 'coins', count: 5 });
    // 每格都带 kind + 数值（剥空时 count 会变 undefined → 客户端显示 +undefined）。
    for (const rw of r.data.defs.rewards) {
      expect(typeof rw.kind).toBe('string');
      expect(typeof rw.count).toBe('number');
    }

    expect(Array.isArray(r.data.defs.tasks)).toBe(true);
    expect(r.data.defs.tasks.length).toBeGreaterThan(0);
    for (const tk of r.data.defs.tasks) {
      expect(typeof tk.id).toBe('string');
      expect(typeof tk.points).toBe('number');
    }

    expect(typeof r.data.defs.pointsThreshold).toBe('number');
    expect(typeof r.data.defs.dailyCoinsReward).toBe('number');
    expect(r.data.claimable).toHaveProperty('checkin');
    expect(r.data.claimable).toHaveProperty('daily');
  });
});
