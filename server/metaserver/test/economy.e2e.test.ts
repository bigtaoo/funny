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
  subscriptions = new Map<string, { expiry: number; lastClaimDayKey?: string }>();
  starterUsed = new Map<string, string[]>();
  async getWallet(id: string) {
    const sub = this.subscriptions.get(id);
    return {
      coins: this.bal(id),
      pity: this.pity.get(id) ?? {},
      fatePoints: 0,
      subscriptionExpiry: sub?.expiry ?? 0,
      subscriptionLastClaimDay: sub?.lastClaimDayKey,
      starterUsed: this.starterUsed.get(id) ?? [],
      firstPurchaseUsed: false,
    };
  }
  async starterBuy(a: { accountId: string; productId: string; orderId: string }) {
    const used = this.starterUsed.get(a.accountId) ?? [];
    if (used.includes(a.productId)) return { ok: false as const, error: 'ALREADY_PURCHASED' };
    this.starterUsed.set(a.accountId, [...used, a.productId]);
    if (a.productId === 'starter_growth') {
      const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.subscriptions.set(a.accountId, { ...this.subscriptions.get(a.accountId), expiry });
      this.coins.set(a.accountId, this.bal(a.accountId) + 3300);
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry, results: [] };
    }
    const results: GachaResultEntry[] = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results };
  }
  async monthlyCardBuy(a: { accountId: string; orderId: string }) {
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    this.subscriptions.set(a.accountId, { ...this.subscriptions.get(a.accountId), expiry });
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry };
  }
  async monthlyCardClaim(a: { accountId: string; dayKey: string }) {
    const sub = this.subscriptions.get(a.accountId);
    if (!sub || sub.lastClaimDayKey === a.dayKey) {
      return { ok: true as const, coinsAfter: this.bal(a.accountId), claimed: 0, subscriptionExpiry: sub?.expiry ?? 0 };
    }
    sub.lastClaimDayKey = a.dayKey;
    this.coins.set(a.accountId, this.bal(a.accountId) + 20);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), claimed: 20, subscriptionExpiry: sub.expiry };
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
  /** Simulates a network/commercial-side failure on the fire-and-forget orderDelivered call (2026-07-15 latency fix). */
  failDelivered = false;
  async orderDelivered(a: { orderId: string; refundCoins?: number }) {
    if (this.failDelivered) throw new Error('simulated orderDelivered failure');
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
    this.coins.set(a.accountId, this.bal(a.accountId) + 550);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 550 };
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
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save document
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
    // The retired unit-card pool (`units`) must never be surfaced as a second standard pool (removed 2026-07-03).
    expect(pools.data.pools.some((p: { id: string }) => p.id === 'units')).toBe(false);
  });

  it('top-up → mirrored balance pushed back', async () => {
    const r = body(await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t499' } }));
    expect(r.data.granted).toBe(550);
    expect(r.data.save.wallet.coins).toBe(550);
  });

  it('rename: deduct 500 coins → write display name → mirror balance; GET /save returns new name', async () => {
    comm.coins.set(accountId, 700);
    // The device account never chose a name, so its first rename is free — consume it so this exercises the paid path.
    await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: 'FreeFirst' } });
    expect(comm.bal(accountId)).toBe(700); // free rename did not deduct
    const r = body(await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: '  NewName  ' } }));
    expect(r.ok).toBe(true);
    expect(r.data.displayName).toBe('NewName'); // trimmed
    expect(r.data.save.wallet.coins).toBe(200); // 700 - 500
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBe('NewName');
  });

  it('rename: insufficient balance → 402, name unchanged', async () => {
    comm.coins.set(accountId, 100);
    // Consume the free first rename so the next one takes the paid path.
    await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: 'FreeFirst' } });
    const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() })).data.displayName;
    expect(before).toBe('FreeFirst');
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: auth(), payload: { displayName: 'Broke' } });
    expect(r.statusCode).toBe(402);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.displayName).toBe(before); // unchanged — paid rename rejected
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

  it('shop direct purchase: kind="item" (protect_enhance) delivers to inventory.items, not inventory.skins (regression — shopBuy used to always route through the skin path)', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance' } }));
    expect(r.data.granted).toBe('protect_enhance');
    expect(r.data.save.inventory.items?.protect_enhance).toBe(1);
    expect(r.data.save.inventory.skins).not.toContain('protect_enhance');
    expect(r.data.save.wallet.coins).toBe(500); // 1000-500
    // Buying a second one increments the stack instead of no-op'ing like a skin re-buy would.
    const r2 = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance' } }));
    expect(r2.data.save.inventory.items?.protect_enhance).toBe(2);
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

  it('gacha: fire-and-forget orderDelivered failure does not block the response, and the order stays reconcilable (2026-07-15 latency fix)', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    comm.failDelivered = true;
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    // The client still gets the delivered item + charged coins even though the delivered-marking call failed.
    expect(r.data.results[0]).toMatchObject({ itemId: 'skin_l1', rarity: 'legendary', duplicate: false });
    expect(r.data.save.inventory.skins).toContain('skin_l1');
    expect(r.data.save.wallet.coins).toBe(850);
    // Let the fire-and-forget orderDelivered call's rejection settle (it's not awaited by the handler).
    await new Promise((resolve) => setImmediate(resolve));
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1); // order still 'charged', not 'delivered'
    // Next login (GET /save) reconciles it: marks delivered, does not re-grant the skin a second time.
    comm.failDelivered = false;
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_l1')).toHaveLength(1);
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(0);
  });

  it('gacha: standard-pool character card result lands in cardInv, not inventory.skins (regression — gachaDraw used to skip the loot-box category routing entirely)', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'suyuan', rarity: 'epic' }];
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r.data.results[0]).toMatchObject({ itemId: 'suyuan', rarity: 'epic' });
    const cards: Array<{ defId: string }> = Object.values(r.data.save.cardInv ?? {});
    expect(cards.some((c) => c.defId === 'suyuan')).toBe(true);
    expect(r.data.save.inventory.skins).not.toContain('suyuan');
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

  it('monthly card claim: subscriptionLastClaimDay survives response serialization (regression — openapi.yml Monetization schema silently dropped this field, so Fastify\'s response schema stripped it even though the server computed it correctly; ShopScene.ts compared it to "today" and never showed the claimed state)', async () => {
    await app.inject({ method: 'POST', url: '/monthly-card/buy', headers: auth() });
    const dayKey = new Date(fakeNow).toISOString().slice(0, 10);

    const r1 = body(await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() }));
    expect(r1.data.claimed).toBeGreaterThan(0);
    expect(r1.data.save.monetization.subscriptionLastClaimDay).toBe(dayKey);

    // Second claim same day: server correctly reports claimed:0, but the mirrored save must still carry
    // today's claim day — this is exactly the field a stale response schema would silently drop.
    const r2 = body(await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() }));
    expect(r2.data.claimed).toBe(0);
    expect(r2.data.save.monetization.subscriptionLastClaimDay).toBe(dayKey);

    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.monetization.subscriptionLastClaimDay).toBe(dayKey);
  });

  it('starter growth: buy within the 7-day window succeeds and mirrors starterUsed + eligibility', async () => {
    const r = body(await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_growth' } }));
    expect(r.data.save.monetization.starterUsed).toContain('starter_growth');
    expect(r.data.save.wallet.coins).toBe(3300);
    // Already claimed — eligibility mirror is irrelevant now (client hides the card via starterUsed), but must not read false.
    expect(r.data.save.monetization.starterGrowthEligible).not.toBe(false);
  });

  it('starter growth: window closed (account older than 7 days) → 403, card left unclaimed, eligibility mirrored false so the client can hide it (2026-07-15 fix — client used to keep showing a Buy button that always 403s)', async () => {
    fakeNow += 8 * 24 * 60 * 60 * 1000; // account was created at the original fakeNow in beforeEach
    const r = await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_growth' } });
    expect(r.statusCode).toBe(403);
    expect(comm.starterUsed.get(accountId)).toBeUndefined(); // never charged/claimed
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.monetization?.starterGrowthEligible).toBe(false);
  });

  it('starter draw: not gated by account age — still buyable after the growth pack window closes', async () => {
    fakeNow += 8 * 24 * 60 * 60 * 1000;
    const r = body(await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_draw' } }));
    expect(r.data.save.monetization.starterUsed).toContain('starter_draw');
  });

  it('starter growth: already purchased → 409', async () => {
    await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_growth' } });
    const r = await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_growth' } });
    expect(r.statusCode).toBe(409);
  });

  it('commercial not configured → economy endpoints 503', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
    const r = await app2.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    expect(r.statusCode).toBe(503);
    await app2.close();
  });
});
