// Unit-style coverage backfill for src/service/economy/{adsPromo,gacha,shop,starter,subscriptions}.ts
// (2026-08-13 test-coverage task). These handlers' business logic is already exercised end-to-end by
// test/economy.e2e.test.ts, but that file imports `buildApp` from '../dist/app.js' — vitest's v8
// coverage provider only source-map-attributes execution of modules it itself loaded via its Vite
// transform, so running the *compiled* dist/*.js through Node's own ESM loader records zero coverage
// against the src/*.ts lines that actually ran. This file imports directly from '../src/...' so the
// exact same kind of request-level exercise gets attributed correctly, and adds the error/edge branches
// the e2e file's happy-path-oriented scenarios don't reach (invalid input, POOL_UNAVAILABLE, promo
// expired/exhausted, ALREADY_ACTIVE, ad cooldown/replay/signature, wallet-unavailable, ...).
//
// Real Mongo (rs0), same convention as economy.e2e.test.ts — deliverGrant/deliverMailGrant rely on
// $addToSet-with-$each + $push-with-$each/$slice + a `{$ne: orderId}` filter guard, none of which
// test/helpers/fakeCollection.ts's generic in-memory double implements, so a real Mongo instance is the
// pragmatic choice here (not a from-scratch reimplementation of those operators).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle, ADS_MIN_INTERVAL_MS, ADS_DAILY_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { CommercialClient, GachaResultEntry, UndeliveredOrder, WalletView } from '../src/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_econ_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[economy-service-unit] Mongo unreachable (${URI}) — skipping.`);

interface OrderRow {
  accountId: string;
  kind: 'shop' | 'gacha';
  status: string;
  result: UndeliveredOrder['result'];
}

/**
 * Configurable fake commercial client. Mirrors economy.e2e.test.ts's FakeCommercial for the happy-path
 * plumbing (wallet/orders/pity/subscriptions/starter/fate/promo), plus a handful of `next*Error`/`force*`
 * knobs so individual tests can steer a call down a specific error branch the e2e file never needed
 * (POOL_UNAVAILABLE, PROMO_EXPIRED/EXHAUSTED, ALREADY_ACTIVE, wallet-unavailable, fateGained>0, ...).
 */
class FakeCommercial implements CommercialClient {
  readonly available: boolean;
  constructor(available = true) {
    this.available = available;
  }

  coins = new Map<string, number>();
  pity = new Map<string, Record<string, number>>();
  fatePoints = new Map<string, number>();
  subscriptions = new Map<string, { expiry: number; lastClaimDayKey?: string }>();
  starterUsed = new Map<string, string[]>();
  totalRecharge = new Map<string, number>();
  orders = new Map<string, OrderRow>();
  promoCodes = new Map<string, { coins: number; usedBy: Set<string>; status?: 'expired' | 'exhausted' }>();
  activeLimitedPools: Array<Record<string, unknown>> = [];
  activeLimitedPoolsThrow = false;

  nextResults: GachaResultEntry[] = [{ itemId: 'skin_l1', rarity: 'legendary' }];
  nextFateGained = 0;
  nextGachaDrawError: 'INSUFFICIENT_FUNDS' | 'POOL_UNAVAILABLE' | 'SOME_OTHER_ERROR' | null = null;
  nextRechargeVerifyError: 'INVALID_RECEIPT' | 'SOME_OTHER_ERROR' | null = null;
  nextAdsCreditError: string | null = null;
  nextMonthlyClaimError: string | null = null;
  /** Skip the extra getWallet() round trip by populating `wallet` directly on the mutation response (mirrorWalletFrom branch). */
  populateWalletInResponses = false;
  walletUnavailableFor = new Set<string>();

  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }

  private walletOf(id: string): WalletView {
    const sub = this.subscriptions.get(id);
    return {
      coins: this.bal(id),
      pity: this.pity.get(id) ?? {},
      fatePoints: this.fatePoints.get(id) ?? 0,
      subscriptionExpiry: sub?.expiry ?? 0,
      subscriptionLastClaimDay: sub?.lastClaimDayKey,
      starterUsed: this.starterUsed.get(id) ?? [],
      firstPurchaseUsed: false,
      totalRechargeCents: this.totalRecharge.get(id) ?? 0,
    };
  }

  async getWallet(id: string) {
    if (this.walletUnavailableFor.has(id)) return null;
    return this.walletOf(id);
  }

  async starterBuy(a: { accountId: string; productId: string; orderId: string }) {
    const used = this.starterUsed.get(a.accountId) ?? [];
    if (used.includes(a.productId)) return { ok: false as const, error: 'ALREADY_PURCHASED' };
    this.starterUsed.set(a.accountId, [...used, a.productId]);
    const wallet = () => (this.populateWalletInResponses ? { wallet: this.walletOf(a.accountId) } : {});
    if (a.productId === 'starter_growth') {
      const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.subscriptions.set(a.accountId, { ...this.subscriptions.get(a.accountId), expiry });
      this.coins.set(a.accountId, this.bal(a.accountId) + 3300);
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry, results: [], ...wallet() };
    }
    const results: GachaResultEntry[] = [{ itemId: 'skin_l1', rarity: 'legendary' }];
    return {
      ok: true as const,
      coinsAfter: this.bal(a.accountId),
      subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0,
      results,
      ...wallet(),
    };
  }

  async monthlyCardBuy(a: { accountId: string; orderId: string }) {
    const sub = this.subscriptions.get(a.accountId);
    if (sub && sub.expiry > Date.now()) return { ok: false as const, error: 'ALREADY_ACTIVE' };
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    this.subscriptions.set(a.accountId, { ...sub, expiry });
    const wallet = this.populateWalletInResponses ? { wallet: this.walletOf(a.accountId) } : {};
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry, ...wallet };
  }

  async monthlyCardClaim(a: { accountId: string; dayKey: string }) {
    if (this.nextMonthlyClaimError) {
      const e = this.nextMonthlyClaimError;
      this.nextMonthlyClaimError = null;
      return { ok: false as const, error: e };
    }
    const sub = this.subscriptions.get(a.accountId);
    const wallet = this.populateWalletInResponses ? { wallet: this.walletOf(a.accountId) } : {};
    if (!sub || sub.lastClaimDayKey === a.dayKey) {
      return { ok: true as const, coinsAfter: this.bal(a.accountId), claimed: 0, subscriptionExpiry: sub?.expiry ?? 0, ...wallet };
    }
    sub.lastClaimDayKey = a.dayKey;
    this.coins.set(a.accountId, this.bal(a.accountId) + 20);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), claimed: 20, subscriptionExpiry: sub.expiry, ...wallet };
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
    if (this.nextGachaDrawError) {
      const e = this.nextGachaDrawError;
      this.nextGachaDrawError = null;
      return { ok: false as const, error: e };
    }
    const ex = this.orders.get(a.orderId);
    if (ex) {
      const p = this.pity.get(a.accountId)?.[a.poolId] ?? 0;
      return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), pityAfter: p, results: ex.result.results ?? [], fateGained: 0, fatePointsAfter: this.fatePoints.get(a.accountId) ?? 0 };
    }
    const cost = a.count === 10 ? 1350 : 150 * a.count;
    if (this.bal(a.accountId) < cost) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - cost);
    const results = this.nextResults.slice(0, a.count);
    const p = (this.pity.get(a.accountId)?.[a.poolId] ?? 0) + a.count;
    this.pity.set(a.accountId, { ...(this.pity.get(a.accountId) ?? {}), [a.poolId]: p });
    this.orders.set(a.orderId, { accountId: a.accountId, kind: 'gacha', status: 'charged', result: { results, poolId: a.poolId } });
    const fateGained = this.nextFateGained;
    this.nextFateGained = 0;
    const fatePointsAfter = (this.fatePoints.get(a.accountId) ?? 0) + fateGained;
    this.fatePoints.set(a.accountId, fatePointsAfter);
    return { ok: true as const, orderId: a.orderId, coinsAfter: this.bal(a.accountId), pityAfter: p, results, fateGained, fatePointsAfter };
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
    if (this.nextRechargeVerifyError) {
      const e = this.nextRechargeVerifyError;
      this.nextRechargeVerifyError = null;
      return { ok: false as const, error: e };
    }
    if (!a.receipt) return { ok: false as const, error: 'INVALID_RECEIPT' };
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

  async verifyNonCoinReceipt(a: { accountId: string; platform: string; receipt: string; receiptId: string; expectedProduct: string }) {
    if (!a.receipt.startsWith('product:')) return { ok: false as const, error: 'INVALID_RECEIPT' };
    const kind = a.receipt.slice(8);
    if (kind !== a.expectedProduct) return { ok: false as const, error: 'INVALID_RECEIPT' };
    return { ok: true as const, product: kind };
  }

  async adsCredit(a: { accountId: string; amount: number; dayKey: string }) {
    if (this.nextAdsCreditError) {
      const e = this.nextAdsCreditError;
      this.nextAdsCreditError = null;
      return { ok: false as const, error: e };
    }
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  async victoryCredit(a: { accountId: string; amount: number; dayKey: string }) {
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }

  async spend(a: { accountId: string; amount: number; orderId: string }) {
    if (this.bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  granted = new Set<string>();
  async grant(a: { accountId: string; amount: number; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  async listActiveLimitedPools() {
    if (this.activeLimitedPoolsThrow) throw new Error('simulated commercial outage');
    return this.activeLimitedPools as never[];
  }

  async redeemFate(a: { accountId: string; itemId: string; orderId: string }) {
    if (a.itemId === 'not_featured') return { ok: false as const, error: 'FATE_INVALID_ITEM' };
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
    const wallet = this.populateWalletInResponses ? { wallet: this.walletOf(a.accountId) } : {};
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: expiry, ...wallet };
  }

  async promoRedeem(a: { accountId: string; code: string }) {
    const entry = this.promoCodes.get(a.code);
    if (!entry) return { ok: false as const, error: 'PROMO_NOT_FOUND' };
    if (entry.status === 'expired') return { ok: false as const, error: 'PROMO_EXPIRED' };
    if (entry.status === 'exhausted') return { ok: false as const, error: 'PROMO_EXHAUSTED' };
    if (entry.usedBy.has(a.accountId)) return { ok: false as const, error: 'PROMO_ALREADY_USED' };
    entry.usedBy.add(a.accountId);
    this.coins.set(a.accountId, this.bal(a.accountId) + entry.coins);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: entry.coins };
  }
  // CommercialClient members this suite never exercises. They throw rather than answer: each was
  // simply absent before test/** was type-checked, so any call already crashed — this keeps that
  // truth while naming what happened.
  async createCustomPool(): Promise<never> { throw new Error('FakeCommercial.createCustomPool is not stubbed in this test'); }
  async closeLimitedPool(): Promise<never> { throw new Error('FakeCommercial.closeLimitedPool is not stubbed in this test'); }
  async listLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listLimitedPools is not stubbed in this test'); }
  async createPromoCode(): Promise<never> { throw new Error('FakeCommercial.createPromoCode is not stubbed in this test'); }
  async listPromoCodes(): Promise<never> { throw new Error('FakeCommercial.listPromoCodes is not stubbed in this test'); }
  async paddleComplete(): Promise<never> { throw new Error('FakeCommercial.paddleComplete is not stubbed in this test'); }
  async paddleRefund(): Promise<never> { throw new Error('FakeCommercial.paddleRefund is not stubbed in this test'); }
  async recordPaddleEvent(): Promise<never> { throw new Error('FakeCommercial.recordPaddleEvent is not stubbed in this test'); }
  async listPaddleEvents(): Promise<never> { throw new Error('FakeCommercial.listPaddleEvents is not stubbed in this test'); }
  async auditCoinGains(): Promise<never> { throw new Error('FakeCommercial.auditCoinGains is not stubbed in this test'); }
}

describe.skipIf(!mongo)('economy service handlers (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let fakeNow = 0;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  async function buildAndAuth(opts: { commercial?: CommercialClient } = {}): Promise<void> {
    comm = (opts.commercial as unknown as FakeCommercial) ?? new FakeCommercial();
    fakeNow = Date.now();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm, authRateLimit: 0, now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `device-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save document
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    await buildAndAuth();
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── adsPromo.ts: adsRewardHandler ──────────────────────────────────────────────────────────────
  describe('POST /ads/reward', () => {
    it('happy path: credits coins and mirrors the wallet', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'tok-1' } }));
      expect(r.ok).toBe(true);
      expect(r.data.granted).toBeGreaterThan(0);
      expect(r.data.save.wallet.coins).toBe(r.data.granted);
    });

    it('missing adToken -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    it('cooldown not elapsed (two calls without advancing the clock) -> 429', async () => {
      const first = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'tok-a' } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'tok-b' } });
      expect(second.statusCode).toBe(429);
      expect(body(second).error.code).toBe('DAILY_CAP_REACHED');
    });

    it('daily cap reached (more than ADS_DAILY_CAP watches in a day) -> 429, distinct from the cooldown branch', async () => {
      for (let i = 0; i < ADS_DAILY_CAP; i++) {
        fakeNow += ADS_MIN_INTERVAL_MS + 1000;
        const r = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: `cap-${i}` } });
        expect(r.statusCode).toBe(200);
      }
      fakeNow += ADS_MIN_INTERVAL_MS + 1000;
      const over = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'cap-over' } });
      expect(over.statusCode).toBe(429);
      expect(body(over).error.code).toBe('DAILY_CAP_REACHED');
    });

    it('duplicate adToken (replay) -> 400, even well past the cooldown', async () => {
      const first = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'replay-me' } });
      expect(first.statusCode).toBe(200);
      fakeNow += 60 * 60 * 1000; // clear the cooldown, but the token hash is already recorded
      const second = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'replay-me' } });
      expect(second.statusCode).toBe(400);
    });

    it('unrecognized platform -> 400 invalid ad signature (dev platform skips this check entirely)', async () => {
      const r = await app.inject({
        method: 'POST', url: '/ads/reward', headers: auth(),
        payload: { adToken: 'tok-sig', platform: 'some_unknown_platform' },
      });
      expect(r.statusCode).toBe(400);
    });

    it('commercial.adsCredit rejects -> 400', async () => {
      comm.nextAdsCreditError = 'SOME_CREDIT_ERROR';
      const r = await app.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'tok-fail' } });
      expect(r.statusCode).toBe(400);
    });

    it('commercial not configured -> 503', async () => {
      const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
      const r = await app2.inject({ method: 'POST', url: '/ads/reward', headers: auth(), payload: { adToken: 'x' } });
      expect(r.statusCode).toBe(503);
      await app2.close();
    });
  });

  // ── adsPromo.ts: iapVerifyHandler ──────────────────────────────────────────────────────────────
  describe('POST /iap/verify', () => {
    it('happy path: mirrors granted coins', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t499' } }));
      expect(r.data.granted).toBe(550);
      expect(r.data.save.wallet.coins).toBe(550);
    });

    it('missing platform/receipt -> 400', async () => {
      const r1 = await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { receipt: 'tier:t499' } });
      expect(r1.statusCode).toBe(400);
      const r2 = await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web' } });
      expect(r2.statusCode).toBe(400);
    });

    it('commercial rejects with INVALID_RECEIPT -> 400 INVALID_RECEIPT', async () => {
      comm.nextRechargeVerifyError = 'INVALID_RECEIPT';
      const r = await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'garbage' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('INVALID_RECEIPT');
    });

    it('commercial rejects with a different error -> 400 BAD_REQUEST (message carries the raw error)', async () => {
      comm.nextRechargeVerifyError = 'SOME_OTHER_ERROR';
      const r = await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'garbage' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
      expect(body(r).error.message).toBe('SOME_OTHER_ERROR');
    });
  });

  // ── adsPromo.ts: redeemPromoCodeHandler ────────────────────────────────────────────────────────
  describe('POST /promo/redeem', () => {
    it('happy path grants coins and mirrors the new balance', async () => {
      comm.promoCodes.set('WELCOME10', { coins: 100, usedBy: new Set() });
      const before = comm.bal(accountId);
      const r = body(await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'WELCOME10' } }));
      expect(r.ok).toBe(true);
      expect(r.data.coinsGranted).toBe(100);
      expect(r.data.save.wallet.coins).toBe(before + 100);
    });

    it('missing / non-string code -> 400', async () => {
      const r1 = await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: {} });
      expect(r1.statusCode).toBe(400);
    });

    it('unknown code -> 404 PROMO_NOT_FOUND', async () => {
      const r = await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'NOPE' } });
      expect(r.statusCode).toBe(404);
      expect(body(r).error.message).toBe('PROMO_NOT_FOUND');
    });

    it('already used by this account -> 400 PROMO_ALREADY_USED', async () => {
      comm.promoCodes.set('ONE-SHOT', { coins: 50, usedBy: new Set() });
      await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'ONE-SHOT' } });
      const r = await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'ONE-SHOT' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('PROMO_ALREADY_USED');
    });

    it('expired code -> 400 PROMO_EXPIRED', async () => {
      comm.promoCodes.set('STALE', { coins: 50, usedBy: new Set(), status: 'expired' });
      const r = await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'STALE' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('PROMO_EXPIRED');
    });

    it('exhausted code -> 400 PROMO_EXHAUSTED', async () => {
      comm.promoCodes.set('GONE', { coins: 50, usedBy: new Set(), status: 'exhausted' });
      const r = await app.inject({ method: 'POST', url: '/promo/redeem', headers: auth(), payload: { code: 'GONE' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('PROMO_EXHAUSTED');
    });
  });

  // ── gacha.ts: getGachaPoolsHandler ────────────────────────────────────────────────────────────
  describe('GET /gacha/pools', () => {
    it('static pools always present, standard pool first', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
      expect(r.data.pools[0].id).toBe('standard');
      expect(r.data.pools[0].entries.length).toBeGreaterThan(0);
      expect(r.data.pools[0].entries[0]).toHaveProperty('probability');
    });

    it('commercial unavailable -> still returns the static pools (does not 503)', async () => {
      const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
      const r = body(await app2.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
      expect(r.data.pools.some((p: { id: string }) => p.id === 'standard')).toBe(true);
      await app2.close();
    });

    it('active derived limited pool -> appended with banner metadata (limited/name/featuredLegendary/endAt)', async () => {
      comm.activeLimitedPools = [{
        id: 'limited_summer', name: 'Summer Banner', featuredLegendary: 'skin_l1',
        startAt: fakeNow - 1000, endAt: fakeNow + 100000, createdBy: 'ops1', createdAt: fakeNow,
      }];
      const r = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
      const limited = r.data.pools.find((p: { id: string }) => p.id === 'limited_summer');
      expect(limited).toMatchObject({ limited: true, name: 'Summer Banner', featuredLegendary: 'skin_l1' });
      expect(limited.entries.length).toBeGreaterThan(0);
    });

    it('active custom pool -> appended via the custom-view branch (own cost/entries, no pity)', async () => {
      comm.activeLimitedPools = [{
        kind: 'custom', id: 'custom_1', name: 'Custom Banner', costSingle: 100,
        startAt: fakeNow - 1000, endAt: fakeNow + 100000,
        categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
        createdBy: 'ops1', createdAt: fakeNow,
      }];
      const r = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
      const custom = r.data.pools.find((p: { id: string }) => p.id === 'custom_1');
      expect(custom).toMatchObject({ limited: true, name: 'Custom Banner', dupePolicy: 'coins', pityThreshold: 0 });
      expect(custom.entries[0]).toMatchObject({ itemId: 'skin_e1' });
    });

    it('commercial.listActiveLimitedPools throws -> best-effort catch, static pools still returned', async () => {
      comm.activeLimitedPoolsThrow = true;
      const r = body(await app.inject({ method: 'GET', url: '/gacha/pools', headers: auth() }));
      expect(r.data.pools.length).toBeGreaterThan(0);
      expect(r.data.pools[0].id).toBe('standard');
    });
  });

  // ── gacha.ts: gachaDrawHandler ────────────────────────────────────────────────────────────────
  describe('POST /gacha/draw', () => {
    it('happy path: deduct coins, deliver a new skin, mirror pity', async () => {
      comm.coins.set(accountId, 1000);
      comm.nextResults = [{ itemId: 'skin_l1', rarity: 'legendary' }];
      const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r.data.results[0]).toMatchObject({ itemId: 'skin_l1', duplicate: false });
      expect(r.data.save.inventory.skins).toContain('skin_l1');
      expect(r.data.save.wallet.coins).toBe(850);
      expect(r.data.save.gacha.pity.standard).toBe(1);
    });

    it('invalid count (not 1 or 10) -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 3 } });
      expect(r.statusCode).toBe(400);
    });

    it('insufficient funds -> 402', async () => {
      const r = await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } });
      expect(r.statusCode).toBe(402);
      expect(body(r).error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('pool unavailable -> 404', async () => {
      comm.nextGachaDrawError = 'POOL_UNAVAILABLE';
      const r = await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'ghost_pool', count: 1 } });
      expect(r.statusCode).toBe(404);
    });

    it('other commercial error -> 400 BAD_REQUEST', async () => {
      comm.nextGachaDrawError = 'SOME_OTHER_ERROR';
      const r = await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
    });

    it('fate points gained on this draw are reflected immediately in the response monetization mirror', async () => {
      comm.coins.set(accountId, 1000);
      comm.nextResults = [{ itemId: 'wp_pencil', rarity: 'common' }];
      comm.nextFateGained = 1;
      const r = body(await app.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } }));
      expect(r.data.save.monetization.fatePoints).toBe(1);
    });

    it('commercial not configured -> 503', async () => {
      const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
      const r = await app2.inject({ method: 'POST', url: '/gacha/draw', headers: auth(), payload: { poolId: 'standard', count: 1 } });
      expect(r.statusCode).toBe(503);
      await app2.close();
    });
  });

  // ── gacha.ts: redeemFateHandler ───────────────────────────────────────────────────────────────
  describe('POST /fate/redeem', () => {
    it('happy path: deducts 30 fate points and delivers the chosen skin', async () => {
      comm.fatePoints.set(accountId, 30);
      const r = body(await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' } }));
      expect(r.ok).toBe(true);
      expect(r.data.granted).toBe('skin_l1');
      expect(r.data.save.monetization.fatePoints).toBe(0);
      expect(r.data.save.inventory.skins).toContain('skin_l1');
    });

    it('missing itemId -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    it('insufficient fate points -> 402 FATE_INSUFFICIENT', async () => {
      comm.fatePoints.set(accountId, 10);
      const r = await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'skin_l1' } });
      expect(r.statusCode).toBe(402);
      expect(body(r).error.code).toBe('FATE_INSUFFICIENT');
    });

    it('not a featured legendary -> 400 FATE_INVALID_ITEM', async () => {
      comm.fatePoints.set(accountId, 30);
      const r = await app.inject({ method: 'POST', url: '/fate/redeem', headers: auth(), payload: { itemId: 'not_featured' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('FATE_INVALID_ITEM');
    });
  });

  // ── shop.ts: getShopItemsHandler ──────────────────────────────────────────────────────────────
  describe('GET /shop/items', () => {
    it('returns the catalog with cost/kind and material daily-cap progress', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/shop/items', headers: auth() }));
      expect(r.data.items.length).toBeGreaterThan(0);
      const scrap = r.data.items.find((i: { id: string }) => i.id === 'mat_buy_scrap');
      expect(scrap).toMatchObject({ dailyLimit: 5, purchasedToday: 0, qty: 10 });
      const stone = r.data.items.find((i: { id: string }) => i.id === 'protect_enhance');
      expect(stone).not.toHaveProperty('dailyLimit');
    });
  });

  // ── shop.ts: shopBuyHandler ───────────────────────────────────────────────────────────────────
  describe('POST /shop/buy', () => {
    it('happy path: skin purchase deducts coins and delivers', async () => {
      comm.coins.set(accountId, 1000);
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } }));
      expect(r.data.granted).toBe('skin_shop_c1');
      expect(r.data.save.inventory.skins).toContain('skin_shop_c1');
      expect(r.data.save.wallet.coins).toBe(700);
    });

    it('happy path: item-kind purchase lands in inventory.items', async () => {
      comm.coins.set(accountId, 1000);
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance' } }));
      expect(r.data.save.inventory.items?.protect_enhance).toBe(1);
    });

    it('happy path: material-kind purchase lands in save.materials, respects the daily cap', async () => {
      comm.coins.set(accountId, 1000);
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap' } }));
      expect(r.data.granted).toBe('scrap');
      expect(r.data.save.materials.scrap).toBe(10);
      const capped = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'mat_buy_scrap', qty: 5 } });
      expect(capped.statusCode).toBe(400); // 1 (above) + 5 = 6 > cap(5)
    });

    it('unknown item -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'no_such_item' } });
      expect(r.statusCode).toBe(400);
    });

    it('insufficient funds -> 402', async () => {
      const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
      expect(r.statusCode).toBe(402);
    });

    it('qty>1 charges cost×qty in one request', async () => {
      comm.coins.set(accountId, 10_000);
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 10 } }));
      expect(r.data.save.inventory.items?.protect_enhance).toBe(10);
      expect(r.data.save.wallet.coins).toBe(10_000 - 500 * 10);
    });

    it('qty above SHOP_BUY_MAX_QTY is rejected outright by request-schema validation (400)', async () => {
      comm.coins.set(accountId, 1_000_000);
      const r = await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance', qty: 999 } });
      expect(r.statusCode).toBe(400);
    });

    it('qty omitted behaves like qty=1 (handler-level default; also covers the Number.isInteger(undefined) clamp branch)', async () => {
      comm.coins.set(accountId, 1000);
      const r = body(await app.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'protect_enhance' } }));
      expect(r.data.save.inventory.items?.protect_enhance).toBe(1);
    });
  });

  // ── starter.ts: starterBuyHandler ─────────────────────────────────────────────────────────────
  describe('POST /starter/buy', () => {
    it('invalid productId -> 400', async () => {
      const r = await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'not_a_real_product', platform: 'dev', receipt: 'product:not_a_real_product' },
      });
      expect(r.statusCode).toBe(400);
    });

    it('missing platform/receipt -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_draw' } });
      expect(r.statusCode).toBe(400);
    });

    it('growth pack window closed (account older than 7 days) -> 403, never charged', async () => {
      fakeNow += 8 * 24 * 60 * 60 * 1000;
      const r = await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
      });
      expect(r.statusCode).toBe(403);
      expect(comm.starterUsed.get(accountId)).toBeUndefined();
    });

    it('bad receipt (does not resolve to the expected product) -> 400 INVALID_RECEIPT', async () => {
      const r = await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_draw', platform: 'dev', receipt: 'product:wrong_product' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('INVALID_RECEIPT');
    });

    it('already purchased -> 409', async () => {
      const buy = () => app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
      });
      await buy();
      const r = await buy();
      expect(r.statusCode).toBe(409);
    });

    it('happy path starter_growth: no items to deliver (results empty), coins/subscription mirrored', async () => {
      const r = body(await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
      }));
      expect(r.data.save.monetization.starterUsed).toContain('starter_growth');
      expect(r.data.save.wallet.coins).toBe(3300);
    });

    it('happy path starter_draw: delivers the pack items via deliverOrder', async () => {
      const r = body(await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_draw', platform: 'dev', receipt: 'product:starter_draw' },
      }));
      expect(r.data.results.length).toBeGreaterThan(0);
      expect(r.data.save.inventory.skins).toContain('skin_l1');
    });

    it('commercial-populated wallet skips the extra getWallet round trip (mirrorWalletFrom branch)', async () => {
      comm.populateWalletInResponses = true;
      const r = body(await app.inject({
        method: 'POST', url: '/starter/buy', headers: auth(),
        payload: { productId: 'starter_growth', platform: 'dev', receipt: 'product:starter_growth' },
      }));
      expect(r.data.save.wallet.coins).toBe(3300);
    });
  });

  // ── subscriptions.ts: monthlyCardBuyHandler / yearCardBuyHandler ─────────────────────────────
  describe('POST /monthly-card/buy', () => {
    it('missing platform/receipt -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/monthly-card/buy', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    it('bad receipt -> 400 INVALID_RECEIPT', async () => {
      const r = await app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'not-a-real-receipt' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('INVALID_RECEIPT');
    });

    it('already active -> 400 with ALREADY_ACTIVE error code', async () => {
      const buy = () => app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:monthly_card' },
      });
      await buy();
      const r = await buy();
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('ALREADY_ACTIVE');
    });

    it('happy path mirrors the new subscription expiry (wallet re-fetched)', async () => {
      const r = body(await app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:monthly_card' },
      }));
      expect(r.data.save.monetization.subscriptionExpiry).toBeGreaterThan(fakeNow);
    });

    it('commercial-populated wallet skips the extra getWallet round trip', async () => {
      comm.populateWalletInResponses = true;
      const r = body(await app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:monthly_card' },
      }));
      expect(r.data.save.monetization.subscriptionExpiry).toBeGreaterThan(fakeNow);
    });
  });

  describe('POST /year-card/buy', () => {
    it('missing platform/receipt -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/year-card/buy', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    it('bad receipt -> 400 INVALID_RECEIPT', async () => {
      const r = await app.inject({
        method: 'POST', url: '/year-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'garbage' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('INVALID_RECEIPT');
    });

    it('already active -> 400 ALREADY_ACTIVE', async () => {
      const buy = () => app.inject({
        method: 'POST', url: '/year-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:year_card' },
      });
      await buy();
      const r = await buy();
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('ALREADY_ACTIVE');
    });

    it('happy path', async () => {
      const r = body(await app.inject({
        method: 'POST', url: '/year-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:year_card' },
      }));
      expect(r.data.save.monetization.subscriptionExpiry).toBeGreaterThan(fakeNow);
    });
  });

  // ── subscriptions.ts: monthlyCardClaimHandler ─────────────────────────────────────────────────
  describe('POST /monthly-card/claim', () => {
    it('commercial rejects -> 400', async () => {
      comm.nextMonthlyClaimError = 'NO_SUBSCRIPTION';
      const r = await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() });
      expect(r.statusCode).toBe(400);
    });

    it('happy path: claims once per day, second same-day claim reports 0', async () => {
      await app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:monthly_card' },
      });
      const r1 = body(await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() }));
      expect(r1.data.claimed).toBeGreaterThan(0);
      const r2 = body(await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() }));
      expect(r2.data.claimed).toBe(0);
    });

    it('commercial-populated wallet skips the extra getWallet round trip', async () => {
      await app.inject({
        method: 'POST', url: '/monthly-card/buy', headers: auth(),
        payload: { platform: 'dev', receipt: 'product:monthly_card' },
      });
      comm.populateWalletInResponses = true;
      const r = body(await app.inject({ method: 'POST', url: '/monthly-card/claim', headers: auth() }));
      expect(r.data.claimed).toBeGreaterThan(0);
    });
  });

  // ── subscriptions.ts: claimRechargeMilestoneHandler ───────────────────────────────────────────
  describe('POST /recharge/claim', () => {
    it('wallet unavailable -> 400', async () => {
      comm.walletUnavailableFor.add(accountId);
      const r = await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } });
      expect(r.statusCode).toBe(400);
    });

    it('unknown tierId -> 400 BAD_REQUEST (claimRechargeReward validation)', async () => {
      const r = await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 9999 } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('bad request');
    });

    it('threshold not reached -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('threshold not reached');
    });

    it('happy path: coin-only reward (tier 1)', async () => {
      await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t999' } });
      const before = comm.bal(accountId);
      const r = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } }));
      expect(r.ok).toBe(true);
      expect(r.data.rewards).toEqual([{ kind: 'coins', count: 60 }]);
      expect(comm.bal(accountId)).toBe(before + 60);
    });

    it('happy path: mixed coin+material reward (tier 3) records material provenance', async () => {
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t1999' } });
      }
      const r = body(await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 3 } }));
      expect(r.data.rewards).toEqual([{ kind: 'coins', count: 550 }, { kind: 'material', id: 'lead', count: 6 }]);
      expect(r.data.save.materials.lead).toBe(6);
    });

    it('already claimed -> 409, and retries the coin grant reconciliation for the tier', async () => {
      await app.inject({ method: 'POST', url: '/iap/verify', headers: auth(), payload: { platform: 'web', receipt: 'tier:t999' } });
      await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } });
      const r = await app.inject({ method: 'POST', url: '/recharge/claim', headers: auth(), payload: { tierId: 1 } });
      expect(r.statusCode).toBe(409);
      expect(body(r).error.code).toBe('ALREADY_CLAIMED');
    });
  });

  it('commercial not configured -> economy endpoints 503 (ensureCommercial gate, spot-checked across handlers)', async () => {
    const app2 = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercialUrl: null });
    const buy = await app2.inject({ method: 'POST', url: '/shop/buy', headers: auth(), payload: { itemId: 'skin_shop_c1' } });
    expect(buy.statusCode).toBe(503);
    const starter = await app2.inject({ method: 'POST', url: '/starter/buy', headers: auth(), payload: { productId: 'starter_draw', platform: 'dev', receipt: 'x' } });
    expect(starter.statusCode).toBe(503);
    const monthly = await app2.inject({ method: 'POST', url: '/monthly-card/buy', headers: auth(), payload: { platform: 'dev', receipt: 'x' } });
    expect(monthly.statusCode).toBe(503);
    await app2.close();
  });
});
