// meta 经济编排端到端（S5-5）：真实 Mongo（saves/adsDaily）+ 注入假 commercial client。
//   shop/gacha 扣币→发物品→镜像、ads cap、iap 镜像、对账补发（崩溃在发货前）不丢不重。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type {
  CommercialClient,
  GachaResultEntry,
  UndeliveredOrder,
} from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_econ_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[economy.e2e] Mongo 不可达（${URI}）— 跳过。`);

/** 内存假 commercial：钱包 + 订单。扣币/发货/退币逻辑足够驱动 meta 编排测试。 */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  pity = new Map<string, Record<string, number>>();
  orders = new Map<string, { accountId: string; kind: 'shop' | 'gacha'; status: string; result: UndeliveredOrder['result']; refund?: number }>();
  /** gacha 滚出的固定结果（测试预设）。 */
  nextResults: GachaResultEntry[] = [{ itemId: 'skin_l1', rarity: 'legendary' }];

  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: this.pity.get(id) ?? {} };
  }
  async shopCharge(a: { accountId: string; itemId: string; cost: number; orderId: string }) {
    const ex = this.orders.get(a.orderId);
    if (ex) return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), status: ex.status };
    if (this.bal(a.accountId) < a.cost) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - a.cost);
    this.orders.set(a.orderId, { accountId: a.accountId, kind: 'shop', status: 'charged', result: { itemId: a.itemId } });
    return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), status: 'charged' };
  }
  async gachaDraw(a: { accountId: string; poolId: string; count: number; orderId: string }) {
    const ex = this.orders.get(a.orderId);
    if (ex) {
      const p = this.pity.get(a.accountId)?.[a.poolId] ?? 0;
      return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), pityAfter: p, results: ex.result.results ?? [] };
    }
    const cost = a.count === 10 ? 1350 : 150 * a.count;
    if (this.bal(a.accountId) < cost) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - cost);
    const results = this.nextResults.slice(0, a.count);
    const p = (this.pity.get(a.accountId)?.[a.poolId] ?? 0) + a.count;
    this.pity.set(a.accountId, { ...(this.pity.get(a.accountId) ?? {}), [a.poolId]: p });
    this.orders.set(a.orderId, { accountId: a.accountId, kind: 'gacha', status: 'charged', result: { results, poolId: a.poolId } });
    return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), pityAfter: p, results };
  }
  async orderDelivered(a: { orderId: string; refundCoins?: number }) {
    const o = this.orders.get(a.orderId);
    if (!o) return { ok: false as const, error: 'NOT_FOUND' };
    if (o.status === 'delivered') return { ok: true as const };
    o.status = 'delivered';
    if (a.refundCoins) this.coins.set(o.accountId, this.bal(o.accountId) + a.refundCoins);
    return { ok: true as const };
  }
  async undeliveredOrders(id: string): Promise<UndeliveredOrder[]> {
    const out: UndeliveredOrder[] = [];
    for (const [oid, o] of this.orders) {
      if (o.accountId === id && o.status === 'charged') out.push({ _id: oid, accountId: id, kind: o.kind, result: o.result });
    }
    return out;
  }
  async rechargeVerify(a: { accountId: string; platform: string; receipt: string; receiptId: string }) {
    if (!a.receipt) return { ok: false as const, error: 'INVALID_RECEIPT' };
    this.coins.set(a.accountId, this.bal(a.accountId) + 600);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 600 };
  }
  async adsCredit(a: { accountId: string; amount: number; dayKey: string }) {
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async victoryCredit(a: { accountId: string; amount: number; dayKey: string }) {
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }
  spent = new Set<string>();
  async spend(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.spent.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    if (this.bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - a.amount);
    this.spent.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
}

describe.skipIf(!mongo)('meta economy orchestration e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = new FakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-econ-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // 建档
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('商品列表 / 盲盒池来自 catalog', async () => {
    const items = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
    expect(items.data.items.length).toBeGreaterThan(0);
    expect(items.data.items[0]).toHaveProperty('cost');
    const pools = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
    expect(pools.data.pools[0].id).toBe('standard');
    expect(pools.data.pools[0].entries.length).toBeGreaterThan(0);
  });

  it('充值 → 镜像余额回推', async () => {
    const r = body(await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:small' } }));
    expect(r.data.granted).toBe(600);
    expect(r.data.save.wallet.coins).toBe(600);
  });

  it('改名：扣 500 金币 → 写展示名 → 镜像余额；GET /save 回带新名', async () => {
    comm.coins.set(accountId, 700);
    const r = body(await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: '  新名字  ' } }));
    expect(r.ok).toBe(true);
    expect(r.data.displayName).toBe('新名字'); // trim
    expect(r.data.save.wallet.coins).toBe(200); // 700 - 500
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBe('新名字');
  });

  it('改名：余额不足 → 402，名字不变', async () => {
    comm.coins.set(accountId, 100);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: 'Broke' } });
    expect(r.statusCode).toBe(402);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBeUndefined();
  });

  it('改名：空名 → 400', async () => {
    comm.coins.set(accountId, 700);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: '   ' } });
    expect(r.statusCode).toBe(400);
  });

  it('商店直购：扣币 → 发皮肤 → 镜像', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } }));
    expect(r.data.granted).toBe('skin_shop_c1');
    expect(r.data.save.inventory.skins).toContain('skin_shop_c1');
    expect(r.data.save.wallet.coins).toBe(700); // 1000-300
    expect(r.data.save.deliveredOrders).toHaveLength(1);
  });

  it('余额不足 → 402', async () => {
    const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_e1' } });
    expect(r.statusCode).toBe(402);
  });

  it('盲盒：扣币 → 发新皮肤 + 标重复 + pity 镜像', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'skin_l1', rarity: 'legendary', duplicate: false });
    expect(r1.data.save.inventory.skins).toContain('skin_l1');
    expect(r1.data.save.gacha.pity.standard).toBe(1);
    // 再抽同物品 → 标 duplicate，皮肤不重复进库存。
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0].duplicate).toBe(true);
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_l1')).toHaveLength(1);
  });

  it('广告 cap：超过 5 次 → 429', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'ok' } });
      expect(r.statusCode).toBe(200);
    }
    const sixth = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'ok' } });
    expect(sixth.statusCode).toBe(429);
  });

  it('对账：扣币后发货前崩溃 → 下次 GET /save 补发，不丢不重', async () => {
    // 模拟「commercial 已扣币建 charged 订单，但 meta 未发货」：直接在 fake 上建订单。
    comm.coins.set(accountId, 1000);
    await comm.shopCharge({ accountId, itemId: 'skin_shop_r1', cost: 800, orderId: 'orphan-1' });
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1);
    // GET /save 顺带对账补发。
    const r1 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r1.data.save.inventory.skins).toContain('skin_shop_r1');
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(0); // 已标 delivered
    // 再次 GET /save：不重复发（皮肤仍只一份）。
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_shop_r1')).toHaveLength(1);
  });

  it('commercial 未配置 → 经济端点 503', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
    const r = await app2.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    expect(r.statusCode).toBe(503);
    await app2.close();
  });
});
