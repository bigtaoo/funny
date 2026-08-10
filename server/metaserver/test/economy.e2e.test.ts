// meta economy orchestration end-to-end (S5-5): real Mongo (saves/adsDaily) + injected fake commercial client.
//   shop/gacha coin deduction → item delivery → mirror, ads cap, iap mirror, reconciliation re-delivery (crash before delivery) with no loss and no duplication.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, ADS_MIN_INTERVAL_MS, CARD_INV_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type {
  CommercialClient,
  GachaResultEntry,
  UndeliveredOrder,
} from '../dist/commercialClient.js';
import type { SystemMailContent } from '../dist/socialsvcClient.js';
import { seedEquipmentBatch } from './helpers/equipment.js';
import { seedCardBatch } from './helpers/cards.js';

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
  totalRecharge = new Map<string, number>();
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
      totalRechargeCents: this.totalRecharge.get(id) ?? 0,
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
  async shopCharge(a: { accountId: string; itemId: string; cost: number; qty?: number; orderId: string }) {
    const ex = this.orders.get(a.orderId);
    if (ex) return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), status: ex.status };
    const qty = a.qty ?? 1;
    const totalCost = a.cost * qty;
    if (this.bal(a.accountId) < totalCost) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - totalCost);
    this.orders.set(a.orderId, { accountId: a.accountId, kind: 'shop', status: 'charged', result: { itemId: a.itemId, qty } });
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
    // Tiny local tier→{coins,usdCents} table mirroring @nw/shared IAP_TIERS_LIST, just enough for the fake
    // to grant tier-accurate amounts and drive totalRechargeCents in the recharge-milestone tests below.
    const TIERS: Record<string, { coins: number; usdCents: number }> = {
      t499: { coins: 550, usdCents: 499 },
      t999: { coins: 1150, usdCents: 999 },
      t1999: { coins: 2400, usdCents: 1999 },
    };
    const tier = a.receipt.startsWith('tier:') ? a.receipt.slice(5) : 't499';
    const { coins, usdCents } = TIERS[tier] ?? TIERS.t499!;
    this.coins.set(a.accountId, this.bal(a.accountId) + coins);
    this.totalRecharge.set(a.accountId, (this.totalRecharge.get(a.accountId) ?? 0) + usdCents);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: coins };
  }
  async verifyNonCoinReceipt(a: {
    accountId: string; platform: string; receipt: string; receiptId: string; expectedProduct: string;
  }) {
    if (!a.receipt.startsWith('product:')) return { ok: false as const, error: 'INVALID_RECEIPT' };
    const kind = a.receipt.slice(8);
    if (kind !== a.expectedProduct) return { ok: false as const, error: 'INVALID_RECEIPT' };
    return { ok: true as const, product: kind };
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
  /** Makes the next grant() call throw (simulates a transient commercial failure), then behaves normally. */
  failNextGrant = false;
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.failNextGrant) { this.failNextGrant = false; throw new Error('injected grant failure'); }
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  // ── fate points / year card / promo codes (minimal fakes for /fate/redeem, /year-card/buy, /promo/redeem) ──
  fatePoints = new Map<string, number>();
  async listActiveLimitedPools() {
    return [];
  }
  async redeemFate(a: { accountId: string; itemId: string; orderId: string }) {
    const pts = this.fatePoints.get(a.accountId) ?? 0;
    if (pts < 30) return { ok: false as const, error: 'FATE_INSUFFICIENT' };
    const after = pts - 30;
    this.fatePoints.set(a.accountId, after);
    return { ok: true as const, orderId: a.orderId, itemId: a.itemId, coinsAfter: this.bal(a.accountId), fatePointsAfter: after };
  }
  async yearCardBuy(a: { accountId: string; orderId: string }) {
    const sub = this.subscriptions.get(a.accountId);
    if (sub && sub.expiry > Date.now()) return { ok: false as const, error: 'ALREADY_ACTIVE' };
    const expiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
    this.subscriptions.set(a.accountId, { ...sub, expiry });
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry };
  }
  promoCodes = new Map<string, { coins: number; usedBy: Set<string> }>();
  async promoRedeem(a: { accountId: string; code: string }) {
    const entry = this.promoCodes.get(a.code);
    if (!entry) return { ok: false as const, error: 'PROMO_NOT_FOUND' };
    if (entry.usedBy.has(a.accountId)) return { ok: false as const, error: 'PROMO_ALREADY_USED' };
    entry.usedBy.add(a.accountId);
    this.coins.set(a.accountId, this.bal(a.accountId) + entry.coins);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: entry.coins };
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

  it('item list: material bundles carry their qty (ECONOMY_NUMBERS §6.5); non-material items omit it entirely', async () => {
    const items = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
    type Item = { id: string; kind: string; qty?: number };
    const scrap = (items.data.items as Item[]).find((i) => i.id === 'mat_buy_scrap');
    expect(scrap?.kind).toBe('material');
    expect(scrap?.qty).toBe(10);
    const lead = (items.data.items as Item[]).find((i) => i.id === 'mat_buy_lead');
    expect(lead?.qty).toBe(3);
    // Skin/consumable entries never had a qty concept — the field must be entirely absent, not `qty: undefined`
    // serialized some other way, on the wire.
    const stone = (items.data.items as Item[]).find((i) => i.id === 'protect_enhance');
    expect(stone).not.toHaveProperty('qty');
  });

  it('top-up → mirrored balance pushed back', async () => {
    const r = body(await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t499' } }));
    expect(r.data.granted).toBe(550);
    expect(r.data.save.wallet.coins).toBe(550);
  });

  it('recharge milestone (GACHA_DESIGN §13): totalRechargeCents mirrors, tier 1 claimable once crossed, not before', async () => {
    // t999 = 999 usdCents, crosses tier 1's 600-cent threshold but not tier 2's 2000.
    await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t999' } });
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.monetization.totalRechargeCents).toBe(999);

    // Tier 2 (threshold 2000) is not yet reached.
    const tooEarly = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 2 } }));
    expect(tooEarly.ok).toBe(false);

    // Tier 1 (threshold 600, reward coins(60)) is claimable.
    const before = comm.bal(accountId);
    const claim = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } }));
    expect(claim.ok).toBe(true);
    expect(claim.data.rewards).toEqual([{ kind: 'coins', count: 60 }]);
    expect(claim.data.save.rechargeMilestone.claimed).toEqual([1]);
    expect(comm.bal(accountId)).toBe(before + 60);

    // Re-claiming the same tier is rejected (already claimed).
    const again = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } }));
    expect(again.ok).toBe(false);
  });

  it('regression (2026-08-03 fix): recharge milestone coins are reconciled on a later ALREADY_CLAIMED retry after the first grant failed', async () => {
    // Root cause: the milestone tier is marked claimed (irreversibly — a repeat claim bounces off
    // ALREADY_CLAIMED) BEFORE the coin grant runs. If that grant throws or returns ok:false, the coins
    // used to be silently lost forever (no error surfaced, no way to retry — the milestone was already
    // consumed). Since the grant's orderId is deterministic per account+tier, an ALREADY_CLAIMED response
    // can still recompute the tier's coin reward and retry the grant.
    await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t999' } });
    const before = comm.bal(accountId);

    comm.failNextGrant = true;
    const claim = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } }));
    expect(claim.ok).toBe(true); // milestone claim itself still "succeeds" from the client's perspective
    expect(claim.data.rewards).toEqual([{ kind: 'coins', count: 60 }]);
    expect(comm.bal(accountId)).toBe(before); // but the grant failed — coins not actually delivered yet

    // A later retry of the same (now-already-claimed) tier reconciles the missed coin grant instead of
    // silently losing it forever.
    const retry = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } }));
    expect(retry.ok).toBe(false); // still reports ALREADY_CLAIMED — milestone state itself is unchanged
    expect(comm.bal(accountId)).toBe(before + 60); // but the coins have now landed via reconciliation

    // A further retry does not re-grant a third time (deterministic orderId, commercial-side dedup).
    await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } });
    expect(comm.bal(accountId)).toBe(before + 60);
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

  it('shop direct purchase of an already-owned skin still delivers a real second instance (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08 — used to be a silent no-op)', async () => {
    comm.coins.set(accountId, 1000);
    await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    const r2 = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } }));
    expect(r2.ok).toBe(true);
    expect(r2.data.save.wallet.coins).toBe(400); // charged both times: 1000-300-300
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_shop_c1')).toHaveLength(1); // still a dedup set
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_shop_c1' })).toBe(2); // but 2 real instances exist
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

  // ── Bulk buy (qty param, 2026-08-10) — closes the "×10 button = 10 sequential round trips" latency
  // bug: the client used to loop cb.buy() qty times under one busy-lock; now it's one request that
  // charges/delivers all qty units server-side (see ShopScene/actions.ts onBuyBulk + this handler). ──

  it('shop direct purchase: qty>1 charges cost×qty in one request and delivers the full quantity at once (kind="item")', async () => {
    comm.coins.set(accountId, 10_000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 10 } }));
    expect(r.data.granted).toBe('protect_enhance');
    expect(r.data.save.inventory.items?.protect_enhance).toBe(10);
    expect(r.data.save.wallet.coins).toBe(10_000 - 500 * 10);
  });

  it('shop direct purchase: qty>1 for a material bundle multiplies BOTH the per-purchase qty and the unit count (mat_buy_scrap grants 10/purchase × qty)', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap', qty: 3 } }));
    expect(r.data.save.materials.scrap).toBe(30); // 10/purchase × 3
    expect(r.data.save.wallet.coins).toBe(1000 - 20 * 3);
  });

  it('shop direct purchase: qty>1 for a skin grants that many real instances in one order, still dedupes inventory.skins to one entry', async () => {
    comm.coins.set(accountId, 10_000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1', qty: 3 } }));
    expect(r.data.save.wallet.coins).toBe(10_000 - 300 * 3);
    expect(r.data.save.inventory.skins.filter((s: string) => s === 'skin_shop_c1')).toHaveLength(1); // dedup set, still one entry
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_shop_c1' })).toBe(3); // 3 real instances
  });

  it('shop direct purchase: qty request that cannot be fully afforded is rejected entirely (402), no partial charge and no partial delivery', async () => {
    comm.coins.set(accountId, 2000); // enough for 4× protect_enhance (500 each), not 10×
    const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 10 } });
    expect(r.statusCode).toBe(402);
    expect(comm.bal(accountId)).toBe(2000); // untouched
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.inventory.items?.protect_enhance).toBeUndefined(); // nothing delivered
  });

  it('shop direct purchase: qty above the server-side max (SHOP_BUY_MAX_QTY=20) is rejected outright by request-schema validation (400), never trusted verbatim', async () => {
    comm.coins.set(accountId, 1_000_000);
    const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 999 } });
    expect(r.statusCode).toBe(400);
    expect(comm.bal(accountId)).toBe(1_000_000); // rejected before ever reaching the handler — nothing charged
    // The handler's own qty clamp (economy.ts shopBuy) is a second line of defense for whatever the
    // route schema doesn't catch — exactly at the max still works.
    const ok20 = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 20 } }));
    expect(ok20.data.save.inventory.items?.protect_enhance).toBe(20);
  });

  it('shop direct purchase: qty omitted still behaves exactly like qty=1 (default, backward compatible)', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance' } }));
    expect(r.data.save.inventory.items?.protect_enhance).toBe(1);
    expect(r.data.save.wallet.coins).toBe(500);
  });

  it('shop direct purchase: qty for a material bundle that cannot fit the remaining daily cap is rejected entirely (400), cap left untouched', async () => {
    comm.coins.set(accountId, 1000);
    // mat_buy_scrap cap is 5 purchases/day; a qty=6 request would need to claim all 6 in one call.
    const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap', qty: 6 } });
    expect(r.statusCode).toBe(400);
    expect(comm.bal(accountId)).toBe(1000); // never charged
    // The daily counter itself must be untouched too (not partially bumped) — a normal qty=5 buy right
    // after should still succeed and reach exactly the cap, not be blocked by a phantom partial bump.
    const r2 = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap', qty: 5 } }));
    expect(r2.data.save.materials.scrap).toBe(50); // 5 purchases × 10, exactly at the daily cap
  });

  it('reconciliation replays the full bulk qty (not just 1) when a bulk order crashes between charge and delivery', async () => {
    comm.coins.set(accountId, 10_000);
    await comm.shopCharge({ accountId, itemId: 'protect_enhance', cost: 500, qty: 7, orderId: 'orphan-bulk-1' });
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1);
    const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() })); // reconciliation side effect
    expect(r.data.save.inventory.items?.protect_enhance).toBe(7); // full qty delivered, not 1
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(0);
  });

  it('shop direct purchase: kind="material" (mat_buy_scrap) delivers a qty>1 bundle into save.materials, not inventory.items/skins (ECONOMY_NUMBERS §6.5 gold→material exchange)', async () => {
    comm.coins.set(accountId, 1000);
    const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } }));
    expect(r.data.granted).toBe('scrap'); // `granted` mirrors ShopItemDef.grants (the material id), not the shop itemId
    expect(r.data.save.materials.scrap).toBe(10);
    expect(r.data.save.wallet.coins).toBe(980); // 1000-20
    expect(r.data.save.inventory.items?.mat_buy_scrap).toBeUndefined();
    expect(r.data.save.inventory.skins).not.toContain('mat_buy_scrap');
    // A second purchase accumulates (materials are $inc'd, not a set).
    const r2 = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } }));
    expect(r2.data.save.materials.scrap).toBe(20);
  });

  it('shop direct purchase: mat_buy_scrap daily cap (5 purchases/day = 50 scrap) rejects the 6th with 400, without charging coins', async () => {
    comm.coins.set(accountId, 1000);
    for (let i = 0; i < 5; i++) {
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } }));
      expect(r.data.save.materials.scrap).toBe((i + 1) * 10);
    }
    expect(comm.bal(accountId)).toBe(900); // 1000 - 5×20
    const capped = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } });
    expect(capped.statusCode).toBe(400);
    expect(comm.bal(accountId)).toBe(900); // unchanged — cap is checked before charging
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.materials.scrap).toBe(50); // still capped at the 5th purchase's result
  });

  it('shop direct purchase: mat_buy_lead daily cap (6 purchases/day = 18 lead) rejects the 7th with 400 — each material item is capped independently', async () => {
    comm.coins.set(accountId, 2000);
    for (let i = 0; i < 6; i++) {
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_lead' } }));
      expect(r.data.save.materials.lead).toBe((i + 1) * 3);
    }
    expect(comm.bal(accountId)).toBe(2000 - 6 * 105);
    const capped = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_lead' } });
    expect(capped.statusCode).toBe(400);
    expect(comm.bal(accountId)).toBe(2000 - 6 * 105); // unchanged — cap is checked before charging
    // Buying scrap right after hitting lead's cap still succeeds — the two material items track
    // separate daily counters (bumpCappedCounter is keyed per itemId), not a shared "any material" cap.
    const scrap = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } }));
    expect(scrap.data.save.materials.scrap).toBe(10);
  });

  it('item list: material bundles carry the account\'s live daily-cap progress (dailyLimit/purchasedToday); non-capped items omit both', async () => {
    comm.coins.set(accountId, 1000);
    type Item = { id: string; dailyLimit?: number; purchasedToday?: number };
    const before = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
    const scrapBefore = (before.data.items as Item[]).find((i) => i.id === 'mat_buy_scrap');
    expect(scrapBefore).toMatchObject({ dailyLimit: 5, purchasedToday: 0 });
    const stoneBefore = (before.data.items as Item[]).find((i) => i.id === 'protect_enhance');
    expect(stoneBefore).not.toHaveProperty('dailyLimit');
    expect(stoneBefore).not.toHaveProperty('purchasedToday');

    await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } });
    await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } });
    const after = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
    const scrapAfter = (after.data.items as Item[]).find((i) => i.id === 'mat_buy_scrap');
    expect(scrapAfter).toMatchObject({ dailyLimit: 5, purchasedToday: 2 });
    // mat_buy_lead's counter is independent of mat_buy_scrap's.
    const leadAfter = (after.data.items as Item[]).find((i) => i.id === 'mat_buy_lead');
    expect(leadAfter).toMatchObject({ dailyLimit: 6, purchasedToday: 0 });
  });

  it('gacha: deduct coins → deliver new skin + mark duplicate + mirror pity', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'skin_l1', rarity: 'legendary', duplicate: false });
    expect(r1.data.save.inventory.skins).toContain('skin_l1');
    expect(r1.data.save.gacha.pity.standard).toBe(1);
    // Draw the same item again → marked duplicate, skin not added to inventory.skins a second time
    // (that array stays a dedup "do I own at least one" view — see skin.ts), but unlike the old design
    // this must NOT be a no-op: a real second SkinInstance is minted (ITEM_IDENTITY_DESIGN.md task1,
    // 2026-08-08 fix — a duplicate pull used to vanish entirely, no item, no coin refund).
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0].duplicate).toBe(true);
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_l1')).toHaveLength(1);
    const instanceDocs = await m.collections.skinInstances.find({ accountId, skinId: 'skin_l1' }).toArray();
    expect(instanceDocs).toHaveLength(2); // the dupe pull really did mint a second instance, not nothing
    // GET /save's skinCounts join surfaces the real count so the client can offer the surplus copy for sale/auction.
    const saveRes = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(saveRes.data.save.skinCounts.skin_l1).toBe(2);
  });

  it('skinCounts self-heals a legacy account (inventory.skins populated, zero skinInstances rows) to exactly 1 instance, idempotently across repeat reads (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08)', async () => {
    // Simulates a pre-2026-08-08 save: owned per inventory.skins, but this account predates the
    // skinInstances collection entirely (no instance rows at all for it).
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': ['skin_l1'] } });
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(0);

    const r1 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r1.data.save.skinCounts.skin_l1).toBe(1);
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(1);

    // A second read must not mint a duplicate legacy instance ($setOnInsert idempotency).
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r2.data.save.skinCounts.skin_l1).toBe(1);
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(1);
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

  it('regression (2026-08-03 fix): repeated GET /save while an order stays "charged" does not re-grant materials (unlike skins, materials are $inc\'d, not naturally idempotent)', async () => {
    // Root cause: reconcileUndelivered re-delivers any order commercial still reports as "charged".
    // gachaDraw marks delivery via a fire-and-forget (unawaited) orderDelivered call, so a GET /save
    // racing that call (or, as here, an orderDelivered that keeps failing) would re-run deliverGrant and
    // re-$inc the same materials every time — skins were accidentally safe via $addToSet, materials were
    // not. Fixed by gating deliverGrant/deliverMailGrant's whole write on
    // `'save.deliveredOrders': { $ne: orderId }`.
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }]; // routes to save.materials.scrap += 10
    comm.failDelivered = true; // orderDelivered keeps failing — order never leaves 'charged' status
    const draw = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(draw.data.save.materials.scrap).toBe(10); // delivered once, synchronously, by gachaDraw itself
    await new Promise((resolve) => setImmediate(resolve));
    expect(await comm.undeliveredOrders(accountId)).toHaveLength(1); // still "charged" from commercial's POV

    // Multiple GET /save calls each trigger reconcileUndelivered against the still-"charged" order.
    const r1 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    const r2 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    const r3 = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(r1.data.save.materials.scrap).toBe(10);
    expect(r2.data.save.materials.scrap).toBe(10);
    expect(r3.data.save.materials.scrap).toBe(10); // not 20, not 40 — the dedup guard holds every time
  });

  it('gacha: standard-pool character card result lands in cardInv, not inventory.skins (regression — gachaDraw used to skip the loot-box category routing entirely)', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'suyuan', rarity: 'epic' }];
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r.data.results[0]).toMatchObject({ itemId: 'suyuan', rarity: 'epic' });
    // Lean response (2026-07-28): save.cardInv is always null here — the actual delta is cardGrants.
    expect(r.data.save.cardInv).toBeNull();
    const granted = r.data.cardGrants.find((c: { defId: string }) => c.defId === 'suyuan');
    expect(granted).toBeDefined();
    expect(r.data.save.inventory.skins).not.toContain('suyuan');
    // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): gacha card grants are tagged 'gacha:<orderId>'.
    expect(granted.sourceType).toMatch(/^gacha:/);
    expect(typeof granted.obtainedAt).toBe('number');
  });

  it('gacha: equipment result lands in equipmentInv via equipmentGrants (lean response, 2026-07-28) — save.equipmentInv stays null', async () => {
    comm.coins.set(accountId, 1000);
    comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r.data.results[0]).toMatchObject({ itemId: 'wp_marker', rarity: 'rare' });
    expect(r.data.save.equipmentInv).toBeNull();
    expect(r.data.equipmentGrants).toHaveLength(1);
    expect(r.data.equipmentGrants[0]).toMatchObject({ defId: 'wp_marker', rarity: 'rare' });
    // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): gacha equipment grants are tagged 'gacha:<orderId>'.
    expect(r.data.equipmentGrants[0].sourceType).toMatch(/^gacha:/);
    expect(typeof r.data.equipmentGrants[0].obtainedAt).toBe('number');
    // GET /save still does the full join (unaffected by gachaDraw's lean response) — the instance really landed.
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.equipmentInv[r.data.equipmentGrants[0].id]).toMatchObject({
      defId: 'wp_marker',
      sourceType: r.data.equipmentGrants[0].sourceType,
      obtainedAt: r.data.equipmentGrants[0].obtainedAt,
    });
  });

  it('gacha: equipment NEW badge checks equipmentInstances by defId, not inventory.skins (regression — equipment fell into markDuplicates\' generic skin branch, so a defId already owned kept showing NEW every draw since equipment never lands in inventory.skins)', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'wp_marker', rarity: 'rare', duplicate: false });
    // Drawing the same defId again (a distinct instance, possibly a different rolled rarity/level) must be marked duplicate — no NEW badge.
    comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0]).toMatchObject({ itemId: 'wp_marker', rarity: 'rare', duplicate: true });
  });

  it('gacha: within a single ten-pull, the first copy of a new equipment defId is NEW and later copies of the same defId in the same batch are duplicate', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'wp_marker', rarity: 'rare' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(r.data.results).toHaveLength(10);
    expect(r.data.results[0].duplicate).toBe(false);
    expect(r.data.results.slice(1).every((e: { duplicate: boolean }) => e.duplicate)).toBe(true);
  });

  it('gacha: material NEW badge checks save.materials (already-in-bag), not just within-batch dedup (regression — materials fell into markDuplicates\' generic skin branch, so a material already stacked in the bag still showed NEW as long as it wasn\'t a second copy in the very same pull — exact bug report: player with a large existing Lead/Scraps stack kept seeing NEW on every gacha result)', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'mat_scrap', rarity: 'common', duplicate: false });
    // Drawing the same material again in a later, separate draw (scrap already sitting in the bag) must be marked duplicate.
    comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }];
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0]).toMatchObject({ itemId: 'mat_scrap', rarity: 'common', duplicate: true });
  });

  it('gacha: within a single ten-pull, the first copy of a new material is NEW and later copies of the same material in the same batch are duplicate', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'mat_lead', rarity: 'common' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(r.data.results).toHaveLength(10);
    expect(r.data.results[0].duplicate).toBe(false);
    expect(r.data.results.slice(1).every((e: { duplicate: boolean }) => e.duplicate)).toBe(true);
  });

  it('gacha: card NEW badge checks cardInv, not inventory.skins (regression — markDuplicates only checked inventory.skins, so an already-owned card kept showing NEW on every later draw since cards never land in inventory.skins)', async () => {
    comm.coins.set(accountId, 2000);
    // 'max' is not one of the 3 auto-granted starter cards (lichuang/chenshou/suyuan), so the account starts without it.
    comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.results[0]).toMatchObject({ itemId: 'max', rarity: 'epic', duplicate: false });
    // Drawing the same card again (already owned, e.g. leveled up via feed) must be marked duplicate — no NEW badge.
    comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.results[0]).toMatchObject({ itemId: 'max', rarity: 'epic', duplicate: true });
    // A third draw of the same defId is still marked duplicate.
    comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
    const r3 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r3.data.results[0].duplicate).toBe(true);
  });

  it('gacha: card already owned via the account-creation starter grant (lichuang/chenshou/suyuan, CHARACTER_CARDS_DESIGN §4) is never shown as NEW (exact bug report: player already had a levelled-up Li Chuang, gacha still badged it NEW every pull)', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = [{ itemId: 'lichuang', rarity: 'common' }];
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r.data.results[0]).toMatchObject({ itemId: 'lichuang', rarity: 'common', duplicate: true });
  });

  it('gacha: within a single ten-pull, the first copy of a new card is NEW and later copies of the same card in the same batch are duplicate', async () => {
    comm.coins.set(accountId, 2000);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'max', rarity: 'epic' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(r.data.results).toHaveLength(10);
    expect(r.data.results[0].duplicate).toBe(false);
    expect(r.data.results.slice(1).every((e: { duplicate: boolean }) => e.duplicate)).toBe(true);
  });

  // 2026-08-08 fix's core claim: ownership for the NEW badge is "live inventory ∪ everOwned",
  // never either alone. The four tests above only exercise the happy path where both stay in sync
  // (a fresh gacha grant sets both together); the tests below decouple them on purpose.
  describe('NEW badge: everOwned survives the item later being fully removed from the live inventory', () => {
    it('equipment: defId stays duplicate=true after every instance of it is deleted (e.g. salvaged/reforge-consumed) — only everOwned.equipment can prove this, since the equipmentInstances query alone would come back empty', async () => {
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
      const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r1.data.results[0].duplicate).toBe(false);
      // Simulate every wp_marker instance being salvaged away — the live equipmentInstances query for
      // this defId now comes back empty, unlike a fresh account that never owned it.
      await m.collections.equipmentInstances.deleteMany({ accountId, defId: 'wp_marker' });
      expect(await m.collections.equipmentInstances.countDocuments({ accountId, defId: 'wp_marker' })).toBe(0);
      comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
      const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r2.data.results[0].duplicate).toBe(true);
    });

    it('material: stays duplicate=true after the stack is fully spent to 0 — only everOwned.material can prove this, since save.materials.scrap alone would read 0 (falsy)', async () => {
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }];
      const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r1.data.results[0].duplicate).toBe(false);
      expect(r1.data.save.materials.scrap).toBe(10);
      // Simulate spending the whole stack (enhancement/refinement material cost) down to 0.
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials.scrap': 0 } });
      comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }];
      const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r2.data.results[0].duplicate).toBe(true);
    });

    it('card: stays duplicate=true after every instance of the defId is deleted (e.g. fused away as fodder) — only everOwned.hero can prove this, since the cardInstances query alone would come back empty', async () => {
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
      const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r1.data.results[0].duplicate).toBe(false);
      await m.collections.cardInstances.deleteMany({ accountId, defId: 'max' });
      expect(await m.collections.cardInstances.countDocuments({ accountId, defId: 'max' })).toBe(0);
      comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
      const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r2.data.results[0].duplicate).toBe(true);
    });

    it('skin: a copy sold via auction escrow (removed from inventory.skins, everOwned.skin untouched) stays duplicate=true on re-pull, AND is still re-added to inventory.skins — the two concerns markDuplicates keeps separate', async () => {
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'skin_e1', rarity: 'epic' }];
      const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r1.data.results[0].duplicate).toBe(false);
      expect(r1.data.save.inventory.skins).toContain('skin_e1');
      // Simulate auction escrow: the skin leaves inventory.skins (the "current copy" view) but
      // everOwned.skin — the lifetime "ever obtained" ledger — is untouched (per its own doc comment,
      // this is exactly what it exists to survive).
      await m.collections.saves.updateOne({ _id: accountId }, { $pull: { 'save.inventory.skins': 'skin_e1' } });
      const mid = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(mid.data.save.inventory.skins).not.toContain('skin_e1');
      expect(mid.data.save.everOwned.skin).toContain('skin_e1');
      comm.nextResults = [{ itemId: 'skin_e1', rarity: 'epic' }];
      const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r2.data.results[0].duplicate).toBe(true); // no NEW badge — everOwned.skin remembers it
      expect(r2.data.save.inventory.skins).toContain('skin_e1'); // but it's still re-added to the plain array
    });
  });

  // The other half of the union: a legacy save whose everOwned ledger has a gap for an item the
  // account demonstrably already has (predates the ledger, or some other write path never
  // populated it) must still resolve from the live inventory alone.
  describe('NEW badge: live inventory alone (empty everOwned) is still enough to suppress the badge', () => {
    it('equipment seeded directly into equipmentInstances (bypassing gacha, so everOwned.equipment is never touched) is still duplicate=true on a gacha re-pull of the same defId', async () => {
      await seedEquipmentBatch(m, accountId, [
        { id: 'legacy_eq_1', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
      ]);
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(before.data.save.everOwned?.equipment ?? []).not.toContain('wp_marker');
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' }];
      const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r.data.results[0].duplicate).toBe(true);
    });

    it('card seeded directly into cardInstances (bypassing gacha, so everOwned.hero is never touched) is still duplicate=true on a gacha re-pull of the same defId', async () => {
      await seedCardBatch(m, accountId, [
        { id: 'legacy_card_1', defId: 'max', level: 1, gear: {}, locked: false },
      ]);
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(before.data.save.everOwned?.hero ?? []).not.toContain('max');
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'max', rarity: 'epic' }];
      const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r.data.results[0].duplicate).toBe(true);
    });

    it('material set directly on save.materials (bypassing gacha, so everOwned.material is never touched) is still duplicate=true on a gacha re-pull of the same material', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials.scrap': 5 } });
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(before.data.save.everOwned?.material ?? []).not.toContain('scrap');
      comm.coins.set(accountId, 2000);
      comm.nextResults = [{ itemId: 'mat_scrap', rarity: 'common' }];
      const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r.data.results[0].duplicate).toBe(true);
    });
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
    await app.inject({
      method: 'POST', url: '/monthly-card/buy', headers: auth(),
      payload: { platform: 'dev', receipt: 'product:monthly_card' },
    });
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
    const r = body(await app.inject({
      method: 'POST', url: '/starter/buy', headers: auth(),
      payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
    }));
    expect(r.data.save.monetization.starterUsed).toContain('starter_growth');
    expect(r.data.save.wallet.coins).toBe(3300);
    // Already claimed — eligibility mirror is irrelevant now (client hides the card via starterUsed), but must not read false.
    expect(r.data.save.monetization.starterGrowthEligible).not.toBe(false);
  });

  it('starter growth: window closed (account older than 7 days) → 403, card left unclaimed, eligibility mirrored false so the client can hide it (2026-07-15 fix — client used to keep showing a Buy button that always 403s)', async () => {
    fakeNow += 8 * 24 * 60 * 60 * 1000; // account was created at the original fakeNow in beforeEach
    const r = await app.inject({
      method: 'POST', url: '/starter/buy', headers: auth(),
      payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
    });
    expect(r.statusCode).toBe(403);
    expect(comm.starterUsed.get(accountId)).toBeUndefined(); // never charged/claimed
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.monetization?.starterGrowthEligible).toBe(false);
  });

  it('starter draw: not gated by account age — still buyable after the growth pack window closes', async () => {
    fakeNow += 8 * 24 * 60 * 60 * 1000;
    const r = body(await app.inject({
      method: 'POST', url: '/starter/buy', headers: auth(),
      payload: { productId: 'starter_draw', platform: 'dev', receipt: 'product:starter_draw' },
    }));
    expect(r.data.save.monetization.starterUsed).toContain('starter_draw');
  });

  it('starter growth: already purchased → 409', async () => {
    await app.inject({
      method: 'POST', url: '/starter/buy', headers: auth(),
      payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
    });
    const r = await app.inject({
      method: 'POST', url: '/starter/buy', headers: auth(),
      payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('fate redeem: happy path deducts 30 fate points and delivers the chosen skin', async () => {
    comm.fatePoints.set(accountId, 30);
    const r = body(await app.inject({
      method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' },
    }));
    expect(r.ok).toBe(true);
    expect(r.data.granted).toBe('skin_l1');
    expect(r.data.save.monetization.fatePoints).toBe(0);
    expect(r.data.save.inventory.skins).toContain('skin_l1');
  });

  it('fate redeem of an already-owned skin still delivers a real second instance (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08 — used to be a silent no-op)', async () => {
    comm.fatePoints.set(accountId, 60);
    await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' } });
    const r2 = body(await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' } }));
    expect(r2.ok).toBe(true);
    expect(r2.data.save.monetization.fatePoints).toBe(0); // 60 - 30 - 30
    expect(r2.data.save.inventory.skins.filter((s: string) => s === 'skin_l1')).toHaveLength(1);
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(2);
  });

  it('fate redeem: insufficient fate points → 402 FATE_INSUFFICIENT', async () => {
    comm.fatePoints.set(accountId, 10);
    const r = await app.inject({
      method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' },
    });
    expect(r.statusCode).toBe(402);
    expect(body(r).error.code).toBe('FATE_INSUFFICIENT');
  });

  it('year card buy: happy path verifies the receipt and mirrors the new subscription expiry', async () => {
    const r = body(await app.inject({
      method: 'POST', url: '/year-card/buy', headers: auth(),
      payload: { platform: 'dev', receipt: 'product:year_card' },
    }));
    expect(r.ok).toBe(true);
    expect(r.data.save.monetization.subscriptionExpiry).toBeGreaterThan(fakeNow);
  });

  it('year card buy: bad receipt → 400 INVALID_RECEIPT, no subscription granted', async () => {
    const r = await app.inject({
      method: 'POST', url: '/year-card/buy', headers: auth(),
      payload: { platform: 'dev', receipt: 'not-a-real-receipt' },
    });
    expect(r.statusCode).toBe(400);
    expect(body(r).error.code).toBe('INVALID_RECEIPT');
  });

  it('promo redeem: happy path grants coins and mirrors the new balance', async () => {
    comm.promoCodes.set('WELCOME10', { coins: 100, usedBy: new Set() });
    const before = comm.bal(accountId);
    const r = body(await app.inject({
      method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'WELCOME10' },
    }));
    expect(r.ok).toBe(true);
    expect(r.data.coinsGranted).toBe(100);
    expect(r.data.save.wallet.coins).toBe(before + 100);
  });

  it('promo redeem: unknown code → 404 PROMO_NOT_FOUND', async () => {
    const r = await app.inject({
      method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'NO-SUCH-CODE' },
    });
    expect(r.statusCode).toBe(404);
    // redeemPromoCode always sends ErrorCode.BAD_REQUEST as the code — only the HTTP status and message vary by error.
    expect(body(r).error.code).toBe('BAD_REQUEST');
    expect(body(r).error.message).toBe('PROMO_NOT_FOUND');
  });

  it('commercial not configured → economy endpoints 503', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
    const r = await app2.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    expect(r.statusCode).toBe(503);
    await app2.close();
  });
});

/**
 * Roster/inventory-full overflow → mail (CHARACTER_CARDS_DESIGN §4 / EQUIPMENT_DESIGN §3.3):
 * first INV_FULL_MAIL_COUNT overflow items per type since that inventory last had free space are
 * mailed as real instances; the rest fall back to coin compensation. Own describe block with its
 * own Mongo connection + DB (the describe above closes the shared `mongo` handle in its afterAll,
 * which runs before this block's tests start) and its own app instance wired with a fake socialsvc.
 */
const mongo2 = await tryConnect();
describe.skipIf(!mongo2)('gacha inventory-full overflow → mail', () => {
  const m = mongo2!;

  /** Records every system-mail write in memory instead of hitting a real socialsvc. */
  class FakeSocialsvc {
    readonly available = true;
    sent: Array<{ dispatchKey: string; to: string; content: SystemMailContent }> = [];
    async proxy(): Promise<{ status: number; data: unknown }> { return { status: 503, data: {} }; }
    async claimMail(): Promise<{ error: 'NOT_FOUND' }> { return { error: 'NOT_FOUND' }; }
    async insertSystemMail(dispatchKey: string, to: string, content: SystemMailContent) {
      this.sent.push({ dispatchKey, to, content });
      return { mailId: `${dispatchKey}:${to}`, inserted: true, hasAttachment: !!content.attachments?.length };
    }
    async bulkInsertSystemMail(dispatchKey: string, accountIds: string[], content: SystemMailContent) {
      for (const to of accountIds) this.sent.push({ dispatchKey, to, content });
      return { insertedAccountIds: accountIds, hasAttachment: !!content.attachments?.length };
    }
  }

  let app: FastifyInstance;
  let comm: FakeCommercial;
  let socialsvc: FakeSocialsvc;
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
    socialsvc = new FakeSocialsvc();
    fakeNow = Date.now();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm, socialsvc, now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-overflow-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    comm.coins.set(accountId, 100000);
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  /** Directly fill `cardInstances` with exactly N dummy instances so a draw starts already at the cap
   * (card instances moved out of save.cardInv in the 2026-07-27 storage split — see cards.ts). Clears
   * the account's existing cards first (the 3 auto-granted starter cards) — the old direct
   * `$set: {'save.cardInv': cardInv}` replaced the whole map, so this mirrors that semantics. */
  async function fillCardInv(n: number): Promise<void> {
    await m.collections.cardInstances.deleteMany({ accountId });
    const instances = Array.from({ length: n }, (_, i) => ({
      id: `card_filler_${i}`, defId: 'lichuang', level: 1, gear: {}, locked: false,
    }));
    await seedCardBatch(m, accountId, instances);
  }

  /** Directly fill equipmentInstances with N dummy instances so a draw starts already at the cap
   * (equipment instances moved out of save.equipmentInv in the 2026-07-26 storage split — see equipment.ts). */
  async function fillEquipInv(n: number): Promise<void> {
    const instances = Array.from({ length: n }, (_, i) => ({
      id: `eq_filler_${i}`, defId: 'wp_pencil', rarity: 'common' as const, level: 0, affixes: [],
    }));
    await seedEquipmentBatch(m, accountId, instances);
  }

  it('roster full: first 10 overflow cards in one draw are mailed, not coin-compensated', async () => {
    await fillCardInv(CARD_INV_CAP);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'lichuang', rarity: 'common' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(r.data.overflow).toMatchObject({ cardMailed: 10, cardCompensatedCoins: 0 });
    expect(r.data.cardGrants).toHaveLength(0); // none of the 10 landed in cardInv — all mailed
    expect(r.data.save.cardMailOverflowCount).toBe(10);
    const cardMail = socialsvc.sent.find((s) => s.content.attachments?.[0]?.kind === 'card');
    expect(cardMail?.content.attachments).toHaveLength(10);
  });

  it('roster full: overflow beyond the first 10 (across draws) falls back to coin compensation', async () => {
    await fillCardInv(CARD_INV_CAP);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'lichuang', rarity: 'common' as const }));
    const first = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(first.data.overflow.cardMailed).toBe(10);
    const coinsAfterFirst = comm.bal(accountId);

    const second = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(second.data.overflow).toMatchObject({ cardMailed: 0, cardCompensatedCoins: 100 }); // 10 x CARD_FULL_COMPENSATION_COINS(10)
    expect(second.data.save.cardMailOverflowCount).toBe(10); // unchanged — quota already exhausted
    // The commercial-authoritative balance reflects the compensation grant immediately; the save's
    // wallet.coins mirror (from draw.coinsAfter, taken before the compensation grant) catches up on next GET /save.
    expect(comm.bal(accountId)).toBe(coinsAfterFirst - 1350 + 100); // -draw cost, +compensation
  });

  it('roster no longer full → mail quota refills', async () => {
    await fillCardInv(CARD_INV_CAP);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'lichuang', rarity: 'common' as const }));
    await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } });
    // Free up room: drop back to CARD_INV_CAP - 1 entries. Bumps rev alongside the raw mutation (matching every
    // real write path's convention) so it can't be silently clobbered by the first draw's still-in-flight
    // fire-and-forget bumpRetentionTask (service/base.ts mutateSave) racing to land its own stale-read rewrite —
    // without this, mutateSave's optimistic-lock rev-check has nothing to detect the conflict against.
    await m.collections.cardInstances.deleteOne({ _id: 'card_filler_0' });
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $inc: { 'save.cardInvCount': -1, rev: 1, 'save.rev': 1 } },
    );
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    // 1 slot free → 1 card lands in cardInv; remaining 9 overflow, and since room was seen the mail quota reset to 0 first.
    expect(r.data.overflow).toMatchObject({ cardMailed: 9, cardCompensatedCoins: 0 });
    expect(r.data.save.cardMailOverflowCount).toBe(9);
  });

  it('equipment full: first 10 overflow instances in one draw are mailed, not coin-compensated (previously silently discarded)', async () => {
    await fillEquipInv(300);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'wp_pencil', rarity: 'common' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(r.data.overflow).toMatchObject({ equipMailed: 10, equipCompensatedCoins: 0 });
    expect(r.data.equipmentGrants).toHaveLength(0); // none of the 10 landed in equipmentInv — all mailed
    expect(r.data.save.equipMailOverflowCount).toBe(10);
    const equipMail = socialsvc.sent.find((s) => s.content.attachments?.[0]?.kind === 'equipment');
    expect(equipMail?.content.attachments).toHaveLength(10);
  });

  it('equipment full: overflow beyond the first 10 (across draws) falls back to coin compensation', async () => {
    await fillEquipInv(300);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'wp_pencil', rarity: 'common' as const }));
    await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } });
    const second = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    expect(second.data.overflow).toMatchObject({ equipMailed: 0, equipCompensatedCoins: 100 }); // 10 x EQUIP_FULL_COMPENSATION_COINS(10)
  });

  it('equipment no longer full → mail quota refills (parity with the card-roster case above)', async () => {
    await fillEquipInv(300);
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'wp_pencil', rarity: 'common' as const }));
    await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } });
    // Free up room: drop back to 299 entries. Bumps rev alongside the raw mutation for the same reason as the
    // card-roster case above — otherwise this can race against the first draw's fire-and-forget bumpRetentionTask.
    await m.collections.equipmentInstances.deleteOne({ _id: 'eq_filler_0' });
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $inc: { 'save.equipmentInvCount': -1, rev: 1, 'save.rev': 1 } },
    );
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    // 1 slot free → 1 instance lands in equipmentInv; remaining 9 overflow, quota reset to 0 first since room was seen.
    expect(r.data.overflow).toMatchObject({ equipMailed: 9, equipCompensatedCoins: 0 });
    expect(r.data.save.equipMailOverflowCount).toBe(9);
  });

  it('mailed attachments carry the real instance data, not just a count — cards keep defId/level, equipment keeps defId/rarity', async () => {
    await fillCardInv(CARD_INV_CAP);
    comm.nextResults = [{ itemId: 'chenshou', rarity: 'rare' as const }];
    const r1 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r1.data.overflow.cardMailed).toBe(1);
    const cardMail = socialsvc.sent.find((s) => s.content.attachments?.[0]?.kind === 'card');
    expect(cardMail?.content.attachments?.[0]?.instance).toMatchObject({ defId: 'chenshou', level: 1, locked: false });

    await fillEquipInv(300);
    comm.nextResults = [{ itemId: 'wp_marker', rarity: 'rare' as const }];
    const r2 = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r2.data.overflow.equipMailed).toBe(1);
    const equipMail = socialsvc.sent.find((s) => s.content.attachments?.[0]?.kind === 'equipment');
    expect(equipMail?.content.attachments?.[0]?.instance).toMatchObject({ defId: 'wp_marker', rarity: 'rare', level: 0 });
  });

  it('mail delivery failure (socialsvc unreachable) does not block the draw response or lose the overflow accounting', async () => {
    await fillCardInv(CARD_INV_CAP);
    socialsvc.insertSystemMail = async () => { throw new Error('simulated socialsvc outage'); };
    comm.nextResults = Array.from({ length: 10 }, () => ({ itemId: 'lichuang', rarity: 'common' as const }));
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 10 } }));
    // Draw still succeeds and reports the intended split even though the mail write itself failed —
    // best-effort delivery, same risk tolerance as the existing coin-compensation `commercial.grant` calls.
    expect(r.data.overflow).toMatchObject({ cardMailed: 10, cardCompensatedCoins: 0 });
    expect(r.data.save.cardMailOverflowCount).toBe(10);
  });

  it('fresh account with room to spare never touches the overflow counters', async () => {
    comm.nextResults = [{ itemId: 'lichuang', rarity: 'common' as const }];
    const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
    expect(r.data.overflow).toMatchObject({ cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 });
    expect(r.data.save.cardMailOverflowCount ?? 0).toBe(0);
    expect(r.data.save.equipMailOverflowCount ?? 0).toBe(0);
    expect(socialsvc.sent).toHaveLength(0);
  });
});
