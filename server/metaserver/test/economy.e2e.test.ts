// meta economy orchestration end-to-end (S5-5): real Mongo (saves/adsDaily) + injected fake commercial client.
//   shop/gacha coin deduction → item delivery → mirror, ads cap, iap mirror, reconciliation re-delivery (crash before delivery) with no loss and no duplication.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, ADS_MIN_INTERVAL_MS } from '@nw/shared';
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
if (!mongo) console.warn(`[economy.e2e] Mongo unreachable (${URI}) — skipping.`);

/** In-memory fake commercial: wallet + orders. Coin deduction/delivery/refund logic is sufficient to drive meta orchestration tests. */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  pity = new Map<string, Record<string, number>>();
  orders = new Map<string, { accountId: string; kind: 'shop' | 'gacha'; status: string; result: UndeliveredOrder['result']; refund?: number }>();
  /** Fixed gacha results to be rolled out (preset for tests). */
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
  granted = new Set<string>();
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
}

describe.skipIf(!mongo)('meta economy orchestration e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let fakeNow = 0;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = new FakeCommercial();
    fakeNow = Date.now();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm, now: () => fakeNow });
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

  it('item list / gacha pool comes from catalog', async () => {
    const items = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
    expect(items.data.items.length).toBeGreaterThan(0);
    expect(items.data.items[0]).toHaveProperty('cost');
    const pools = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
    expect(pools.data.pools[0].id).toBe('standard');
    expect(pools.data.pools[0].entries.length).toBeGreaterThan(0);
  });

  it('top-up → mirrored balance pushed back', async () => {
    const r = body(await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:small' } }));
    expect(r.data.granted).toBe(600);
    expect(r.data.save.wallet.coins).toBe(600);
  });

  it('rename: deduct 500 coins → write display name → mirror balance; GET /save returns new name', async () => {
    comm.coins.set(accountId, 700);
    const r = body(await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: '  新名字  ' } }));
    expect(r.ok).toBe(true);
    expect(r.data.displayName).toBe('新名字'); // trimmed
    expect(r.data.save.wallet.coins).toBe(200); // 700 - 500
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBe('新名字');
  });

  it('rename: insufficient balance → 402, name unchanged', async () => {
    comm.coins.set(accountId, 100);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: 'Broke' } });
    expect(r.statusCode).toBe(402);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBeUndefined();
  });

  it('rename: empty name → 400', async () => {
    comm.coins.set(accountId, 700);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: '   ' } });
    expect(r.statusCode).toBe(400);
  });

  it('shop direct purchase: deduct coins → deliver skin → mirror', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } }));
    expect(r.data.granted).toBe('skin_shop_c1');
    expect(r.data.save.inventory.skins).toContain('skin_shop_c1');
    expect(r.data.save.wallet.coins).toBe(700); // 1000-300
    expect(r.data.save.deliveredOrders).toHaveLength(1);
  });

  it('insufficient balance → 402', async () => {
    const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_e1' } });
    expect(r.statusCode).toBe(402);
  });

  it('gacha: deduct coins → deliver new skin + mark duplicate + mirror pity', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'skin_l1', rarity: 'legendary', duplicate: false });
    expect(r1.data.save.inventory.skins).toContain('skin_l1');
    expect(r1.data.save.gacha.pity.standard).toBe(1);
    // Draw the same item again → marked duplicate, skin not added to inventory again.
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0].duplicate).toBe(true);
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_l1')).toHaveLength(1);
  });

  it('gacha unit card pool (S12-C): deduct coins → card goes into cardInventory + derives unitLevels, not treated as a skin', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = [{ itemId: 'archer:3', rarity: 'epic' }]; // epic→T3
    const r = body(
      await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'units', count: 1 } }),
    );
    // Unit card: duplicate is always false, goes into cardInventory, unitLevels derived (single T3 card → archer=3).
    expect(r.data.results[0]).toMatchObject({ itemId: 'archer:3', rarity: 'epic', duplicate: false });
    expect(r.data.save.cardInventory['archer:3']).toBe(1);
    expect(r.data.save.unitLevels.archer).toBe(3);
    expect(r.data.save.inventory.skins).not.toContain('archer:3'); // never goes into skin inventory
    expect(r.data.save.gacha.pity.units).toBe(1);
    // Draw the same card again → inventory incremented (card collection naturally allows duplicates: no refund, no dedup).
    const r2 = body(
      await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'units', count: 1 } }),
    );
    expect(r2.data.results[0].duplicate).toBe(false);
    expect(r2.data.save.cardInventory['archer:3']).toBe(2);
  });

  it('unit card pool reconciliation (S12-C): crash after coin deduction → GET /save re-delivers into cardInventory, no loss no duplication', async () => {
    comm.coins.set(accountId, 2000);
    // Simulate commercial having deducted coins and created a charged units order, but meta has not yet delivered.
    await comm.gachaDraw({ accountId, poolId: 'units', count: 1, orderId: 'orphan-units-1' });
    comm.orders.get('orphan-units-1')!.result.results = [{ itemId: 'infantry:2', rarity: 'rare' }];
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1);
    const r1 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r1.data.save.cardInventory['infantry:2']).toBe(1); // re-delivered into card inventory (not skins)
    expect(r1.data.save.inventory.skins).not.toContain('infantry:2');
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(0);
    // GET /save again: idempotent, no duplicate $inc.
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r2.data.save.cardInventory['infantry:2']).toBe(1);
  });

  it('ad cap: more than 5 times → 429', async () => {
    for (let i = 0; i < 5; i++) {
      fakeNow += ADS_MIN_INTERVAL_MS + 1000;
      const r = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: `ok-${i}` } });
      expect(r.statusCode).toBe(200);
    }
    fakeNow += ADS_MIN_INTERVAL_MS + 1000;
    const sixth = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'ok-5' } });
    expect(sixth.statusCode).toBe(429);
  });

  it('reconciliation: crash after coin deduction but before delivery → next GET /save re-delivers, no loss no duplication', async () => {
    // Simulate "commercial has deducted coins and created a charged order, but meta has not yet delivered": create the order directly on the fake.
    comm.coins.set(accountId, 1000);
    await comm.shopCharge({ accountId, itemId: 'skin_shop_r1', cost: 800, orderId: 'orphan-1' });
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1);
    // GET /save triggers reconciliation re-delivery as a side effect.
    const r1 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r1.data.save.inventory.skins).toContain('skin_shop_r1');
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(0); // already marked delivered
    // GET /save again: no duplicate delivery (skin still only one copy).
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_shop_r1')).toHaveLength(1);
  });

  it('commercial not configured → economy endpoints 503', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
    const r = await app2.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    expect(r.statusCode).toBe(503);
    await app2.close();
  });
});
