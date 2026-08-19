// Direct-from-src unit/route tests for src/paddle/{checkoutRoute,priceIds,signature,webhookRoute}.ts.
//
// Why this file exists (2026-08-13 coverage pass): test/paddle-routes.e2e.test.ts already exercises the
// full checkout+webhook business logic end to end, but it imports `buildApp` from '../dist/app.js' — v8
// coverage only attributes executed lines back to `src/*.ts` when the module was loaded through Vite's
// transform pipeline, so that file's coverage of these four files reports ~0-10% despite being tested
// thoroughly. This file imports everything from '../src/...' (never '../dist/...') so the same kind of
// exercised branches get attributed correctly, and adds a handful of branches paddle-routes.e2e.test.ts
// doesn't reach at all (see inline comments below for which).
//
// test/paddle.test.ts already covers clampPaddleQuantity/coinsForPriceId/subscriptionForPriceId from
// '../src/paddle.js' — this file does not repeat those, only usdCentsForPriceId/starterProductForPriceId/
// priceIdForTier (0% before this file) plus every checkoutRoute.ts/webhookRoute.ts/signature.ts branch.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { CommercialClient, WalletView } from '../src/commercialClient.js';
import { verifyPaddleSignature } from '../src/paddle/signature.js';
import { usdCentsForPriceId, starterProductForPriceId, priceIdForTier } from '../src/paddle/priceIds.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_paddle_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const WEBHOOK_SECRET = 'whsec_unit_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[paddle-unit] Mongo unreachable (${URI}) — skipping route-level describe blocks.`);

// ---------------------------------------------------------------------------------------------
// signature.ts — pure function, no app/mongo needed.
// ---------------------------------------------------------------------------------------------
describe('verifyPaddleSignature', () => {
  const secret = 'a-secret';
  const rawBody = '{"event_type":"transaction.completed"}';

  function sign(body: string, ts: number, key = secret): string {
    const h1 = createHmac('sha256', key).update(`${ts}:${body}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
  }

  it('accepts a correctly signed header', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(secret, rawBody, sign(rawBody, ts))).toBe(true);
  });

  it('rejects a header signed with the wrong secret', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(secret, rawBody, sign(rawBody, ts, 'wrong-secret'))).toBe(false);
  });

  it('rejects when the body was tampered with after signing', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, ts);
    expect(verifyPaddleSignature(secret, rawBody + 'x', header)).toBe(false);
  });

  it('rejects a header missing the ts field', () => {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
    expect(verifyPaddleSignature(secret, rawBody, `h1=${h1}`)).toBe(false);
  });

  it('rejects a header missing the h1 field', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(secret, rawBody, `ts=${ts}`)).toBe(false);
  });

  it('rejects a completely malformed header (no key=value segments at all)', () => {
    expect(verifyPaddleSignature(secret, rawBody, 'garbage-not-a-header')).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(verifyPaddleSignature(secret, rawBody, '')).toBe(false);
  });

  it('h1 with non-hex characters is caught (Buffer.from throws / length mismatch) and returns false, not throw', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(() => verifyPaddleSignature(secret, rawBody, `ts=${ts};h1=not-hex-!!zz`)).not.toThrow();
    expect(verifyPaddleSignature(secret, rawBody, `ts=${ts};h1=not-hex-!!zz`)).toBe(false);
  });

  it('h1 of mismatched length vs. the expected digest is caught by timingSafeEqual and returns false', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyPaddleSignature(secret, rawBody, `ts=${ts};h1=ab`)).toBe(false);
  });

  it('OBSERVATION (not a bug fix, just documenting behavior): a very old ts still verifies true — this function ' +
    'performs no staleness/expiry check of its own, it only verifies the HMAC over "ts:body". Replay protection ' +
    'for this webhook relies entirely on downstream idempotency (transactionId dedup in webhookRoute.ts), not on ' +
    'this function rejecting old timestamps.', () => {
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    expect(verifyPaddleSignature(secret, rawBody, sign(rawBody, tenDaysAgo))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// priceIds.ts — usdCentsForPriceId / starterProductForPriceId / priceIdForTier were NOT covered by
// test/paddle.test.ts at all (it only covers coinsForPriceId/subscriptionForPriceId/clampPaddleQuantity).
// ---------------------------------------------------------------------------------------------
describe('usdCentsForPriceId', () => {
  afterEach(() => {
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  it('resolves a mapped coin-tier price id to its display USD cents', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499,t1999:pri_1999';
    expect(usdCentsForPriceId('pri_499')).toBe(499);
    expect(usdCentsForPriceId('pri_1999')).toBe(1999);
  });

  it('a mapped tierKey that is not in IAP_TIERS_LIST (e.g. a reserved subscription key) returns 0', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'monthly_card:pri_monthly';
    expect(usdCentsForPriceId('pri_monthly')).toBe(0);
  });

  it('unmapped price id returns 0', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499';
    expect(usdCentsForPriceId('pri_unknown')).toBe(0);
  });

  it('unset env var returns 0', () => {
    expect(usdCentsForPriceId('pri_499')).toBe(0);
  });

  it('a malformed pair without a colon is skipped, the well-formed pair after it still resolves', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'not-a-pair,t499:pri_499';
    expect(usdCentsForPriceId('pri_499')).toBe(499);
  });
});

describe('starterProductForPriceId', () => {
  afterEach(() => {
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  it('resolves the reserved starter_draw/starter_growth tier keys', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'starter_draw:pri_draw,starter_growth:pri_growth';
    expect(starterProductForPriceId('pri_draw')).toBe('starter_draw');
    expect(starterProductForPriceId('pri_growth')).toBe('starter_growth');
  });

  it('a coin-tier price id is not mistaken for a starter pack', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499';
    expect(starterProductForPriceId('pri_499')).toBeNull();
  });

  it('a subscription price id is not mistaken for a starter pack', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'monthly_card:pri_monthly';
    expect(starterProductForPriceId('pri_monthly')).toBeNull();
  });

  it('unmapped price id returns null', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'starter_draw:pri_draw';
    expect(starterProductForPriceId('pri_unknown')).toBeNull();
  });

  it('unset env var returns null', () => {
    expect(starterProductForPriceId('pri_draw')).toBeNull();
  });

  it('a malformed pair without a colon is skipped', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'garbage,starter_draw:pri_draw';
    expect(starterProductForPriceId('pri_draw')).toBe('starter_draw');
  });
});

describe('priceIdForTier (checkoutRoute.ts\'s tier→priceId lookup, not re-exported via paddle.ts)', () => {
  afterEach(() => {
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  it('resolves a mapped tier to its Paddle price id', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499,monthly_card:pri_monthly';
    expect(priceIdForTier('t499')).toBe('pri_499');
    expect(priceIdForTier('monthly_card')).toBe('pri_monthly');
  });

  it('unmapped tier returns null', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499';
    expect(priceIdForTier('t999')).toBeNull();
  });

  it('unset env var returns null', () => {
    expect(priceIdForTier('t499')).toBeNull();
  });

  it('a tier key mapped to an empty price id (trailing colon, no value) is treated as unmapped', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:';
    expect(priceIdForTier('t499')).toBeNull();
  });

  it('a malformed pair without a colon is skipped', () => {
    process.env.NW_PADDLE_PRICE_IDS = 'garbage,t499:pri_499';
    expect(priceIdForTier('t499')).toBe('pri_499');
  });
});

// ---------------------------------------------------------------------------------------------
// checkoutRoute.ts / webhookRoute.ts — full route-level tests via a real fastify app (src/app.ts)
// + real Mongo (shared instance, see NW_MONGO_URI) + an in-file FakeCommercial. Skips gracefully
// if Mongo is unreachable, same pattern as paddle-routes.e2e.test.ts.
// ---------------------------------------------------------------------------------------------

/** Minimal fake commercial covering only what checkoutRoute.ts/webhookRoute.ts touch, plus a couple of
 * accountId sentinels to force failure branches paddle-routes.e2e.test.ts never triggers for starter/coin. */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  subscriptions = new Map<string, { expiry: number }>();
  starterUsed = new Map<string, string[]>();
  claimedOrders = new Set<string>();
  events: Array<{ transactionId: string; eventType: string; status?: string; accountId?: string }> = [];
  refunds: string[] = [];
  now = () => Date.now();

  /** accountIds in this set make monthlyCardBuy/yearCardBuy/starterBuy/paddleComplete report a business
   * failure (ok:false) even on a fresh, never-before-seen orderId — exercises the "grant refused after
   * money already changed hands" logging branches that paddle-routes.e2e.test.ts only reaches via the
   * much narrower already-active-subscription race, never for starter packs or plain coins. */
  forceGrantFail = new Set<string>();
  /** accountIds for which getWallet returns null — exercises webhookRoute.ts's `if (w) await mirrorWalletFrom(...)`
   * false branch (wallet mirror skipped), which every success-path test in paddle-routes.e2e.test.ts skips past
   * because its FakeCommercial.getWallet always returns a wallet. */
  walletNullFor = new Set<string>();

  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }

  async getWallet(id: string): Promise<WalletView | null> {
    if (this.walletNullFor.has(id)) return null;
    const sub = this.subscriptions.get(id);
    return {
      coins: this.bal(id),
      pity: {},
      fatePoints: 0,
      subscriptionExpiry: sub?.expiry ?? 0,
      starterUsed: this.starterUsed.get(id) ?? [],
      firstPurchaseUsed: false,
      totalRechargeCents: 0,
    };
  }

  async starterBuy(a: { accountId: string; productId: string; orderId: string }) {
    if (this.forceGrantFail.has(a.accountId)) return { ok: false as const, error: 'FORCED_FAIL' };
    if (this.claimedOrders.has(a.orderId)) {
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: [] };
    }
    const used = this.starterUsed.get(a.accountId) ?? [];
    if (used.includes(a.productId)) return { ok: false as const, error: 'ALREADY_PURCHASED' };
    this.claimedOrders.add(a.orderId);
    this.starterUsed.set(a.accountId, [...used, a.productId]);
    if (a.productId === 'starter_growth') {
      this.coins.set(a.accountId, this.bal(a.accountId) + 3300);
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: [] };
    }
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: [{ itemId: 'skin_starter_l1', rarity: 'legendary' as const }] };
  }

  async orderDelivered(_a: { orderId: string; refundCoins?: number }) {
    return { ok: true as const };
  }

  private subscriptionCardBuy(accountId: string, orderId: string, days: number) {
    if (this.forceGrantFail.has(accountId)) return { ok: false as const, error: 'FORCED_FAIL' };
    if (this.claimedOrders.has(orderId)) {
      return { ok: true as const, coinsAfter: this.bal(accountId), subscriptionExpiry: this.subscriptions.get(accountId)?.expiry ?? 0 };
    }
    const now = this.now();
    const cur = this.subscriptions.get(accountId);
    if (cur && cur.expiry > now) return { ok: false as const, error: 'ALREADY_ACTIVE' };
    this.claimedOrders.add(orderId);
    const expiry = now + days * 86400000;
    this.subscriptions.set(accountId, { expiry });
    this.coins.set(accountId, this.bal(accountId) + 600);
    return { ok: true as const, coinsAfter: this.bal(accountId), subscriptionExpiry: expiry };
  }

  async monthlyCardBuy(a: { accountId: string; orderId: string }) {
    return this.subscriptionCardBuy(a.accountId, a.orderId, 30);
  }

  async yearCardBuy(a: { accountId: string; orderId: string }) {
    return this.subscriptionCardBuy(a.accountId, a.orderId, 365);
  }

  async paddleComplete(a: { accountId: string; transactionId: string; coins: number; usdCents?: number }) {
    if (this.forceGrantFail.has(a.accountId)) return { ok: false as const, error: 'FORCED_FAIL' };
    const key = `paddle:${a.transactionId}`;
    if (this.claimedOrders.has(key)) return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 0 };
    this.claimedOrders.add(key);
    this.coins.set(a.accountId, this.bal(a.accountId) + a.coins);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: a.coins };
  }

  async recordPaddleEvent(a: { transactionId: string; eventType: string; status?: string; accountId?: string; rawEvent: string }) {
    this.events.push({ transactionId: a.transactionId, eventType: a.eventType, status: a.status, accountId: a.accountId });
  }

  async paddleRefund(a: { transactionId: string }) {
    this.refunds.push(a.transactionId);
    return { ok: true as const, decrementedCents: 999 };
  }

  // --- Unused by paddle routes; only here to satisfy `implements CommercialClient` ---
  async shopCharge(): Promise<never> { throw new Error('not used by paddle routes'); }
  async gachaDraw(): Promise<never> { throw new Error('not used by paddle routes'); }
  async undeliveredOrders(): Promise<never[]> { return []; }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount };
  }
  async victoryCredit(): Promise<never> { throw new Error('not used by paddle routes'); }
  async createPromoCode(): Promise<never> { throw new Error('not used by paddle routes'); }
  async redeemPromoCode(): Promise<never> { throw new Error('not used by paddle routes'); }
  async listPromoCodes(): Promise<never[]> { return []; }
  async createCustomPool(): Promise<never> { throw new Error('not used by paddle routes'); }
  async closeLimitedPool(): Promise<never> { throw new Error('not used by paddle routes'); }
  async listLimitedPools(): Promise<never[]> { return []; }
  async auditCoinGains(): Promise<never[]> { return []; }
  // CommercialClient members this suite never exercises. They throw rather than answer: each was
  // simply absent before test/** was type-checked, so any call already crashed — this keeps that
  // truth while naming what happened.
  async listActiveLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listActiveLimitedPools is not stubbed in this test'); }
  async redeemFate(): Promise<never> { throw new Error('FakeCommercial.redeemFate is not stubbed in this test'); }
  async monthlyCardClaim(): Promise<never> { throw new Error('FakeCommercial.monthlyCardClaim is not stubbed in this test'); }
  async spend(): Promise<never> { throw new Error('FakeCommercial.spend is not stubbed in this test'); }
  async rechargeVerify(): Promise<never> { throw new Error('FakeCommercial.rechargeVerify is not stubbed in this test'); }
  async verifyNonCoinReceipt(): Promise<never> { throw new Error('FakeCommercial.verifyNonCoinReceipt is not stubbed in this test'); }
  async adsCredit(): Promise<never> { throw new Error('FakeCommercial.adsCredit is not stubbed in this test'); }
  async promoRedeem(): Promise<never> { throw new Error('FakeCommercial.promoRedeem is not stubbed in this test'); }
  async listPaddleEvents(): Promise<never> { throw new Error('FakeCommercial.listPaddleEvents is not stubbed in this test'); }
}

describe.skipIf(!mongo)('checkoutRoute.ts / webhookRoute.ts (src-level route tests)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let fakeNow = 0;
  let fetchMock: ReturnType<typeof vi.fn>;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  /** Same rawBody-signing helper as paddle-routes.e2e.test.ts's signWebhook, reused verbatim here per the
   * task brief ("signWebhook 这个签名辅助函数的实现值得直接搬一份到你的新文件里"). */
  function signWebhook(rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
    const h1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${rawBody}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
  }

  const postWebhook = (payload: object, sigHeader?: string) => {
    const raw = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/paddle/webhook',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'paddle-signature': sigHeader ?? signWebhook(raw),
      },
    });
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = new FakeCommercial();
    fakeNow = Date.now();
    comm.now = () => fakeNow;

    process.env.NW_PADDLE_API_KEY = 'sk_test_fake';
    process.env.NW_PADDLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.NW_PADDLE_PRICE_IDS =
      't499:pri_499,monthly_card:pri_monthly,year_card:pri_year,starter_draw:pri_starter_draw,starter_growth:pri_starter_growth';
    delete process.env.NW_PADDLE_SANDBOX;

    let txCounter = 0;
    fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: `txn_${++txCounter}` } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm, now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-paddle-unit-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save document
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NW_PADDLE_API_KEY;
    delete process.env.NW_PADDLE_WEBHOOK_SECRET;
    delete process.env.NW_PADDLE_PRICE_IDS;
    delete process.env.NW_PADDLE_SANDBOX;
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  describe('POST /shop/paddle/checkout', () => {
    it('unauthenticated → 401 UNAUTHENTICATED', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', payload: { tierId: 't499' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('UNAUTHENTICATED');
    });

    it('missing tierId → 400 INVALID_TIER', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: {} }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_TIER');
    });

    it('unknown tierId → 400 INVALID_TIER, never reaches Paddle', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'not_a_real_tier' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_TIER');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('valid coin tier → creates a Paddle transaction against the production API base by default', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(true);
      expect(r.data.transactionId).toMatch(/^txn_/);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toBe('https://api.paddle.com/transactions');
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_499');
      expect(callBody.custom_data.accountId).toBe(accountId);
    });

    it('NW_PADDLE_SANDBOX=true routes checkout creation to the sandbox API base', async () => {
      process.env.NW_PADDLE_SANDBOX = 'true';
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(true);
      expect(fetchMock.mock.calls[0]![0]).toBe('https://sandbox-api.paddle.com/transactions');
    });

    it('a valid IAP tier with no mapped price id → 503 PADDLE_NOT_CONFIGURED', async () => {
      // t999 is a real IAP tier but is NOT in NW_PADDLE_PRICE_IDS above.
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't999' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_NOT_CONFIGURED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('missing NW_PADDLE_API_KEY → createPaddleTransaction throws → 502 PADDLE_ERROR', async () => {
      delete process.env.NW_PADDLE_API_KEY;
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_ERROR');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Paddle API responds !ok with an error.detail → 502 PADDLE_ERROR (detail path)', async () => {
      fetchMock.mockImplementationOnce(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { type: 'request_error', detail: 'price_id is required' } }),
      }));
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_ERROR');
    });

    it('Paddle API responds !ok with no error.detail → 502 PADDLE_ERROR (resp.status fallback path)', async () => {
      fetchMock.mockImplementationOnce(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }));
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_ERROR');
    });

    it('Paddle API responds ok:true but with no data.id → still treated as a failure → 502 PADDLE_ERROR', async () => {
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      }));
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_ERROR');
    });

    it('monthly_card with no active subscription → creates a checkout for the mapped subscription price', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'monthly_card' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_monthly');
    });

    it('monthly_card while a card is already active → 400 ALREADY_ACTIVE, never reaches Paddle', async () => {
      comm.subscriptions.set(accountId, { expiry: fakeNow + 10 * 86400000 });
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'monthly_card' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_ACTIVE');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('year_card is blocked by the same single-slot gate as monthly_card', async () => {
      comm.subscriptions.set(accountId, { expiry: fakeNow + 10 * 86400000 });
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'year_card' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_ACTIVE');
    });

    it('monthly_card is allowed again once the previous card has expired', async () => {
      comm.subscriptions.set(accountId, { expiry: fakeNow - 1000 }); // expired
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'monthly_card' } }));
      expect(r.ok).toBe(true);
    });

    it('starter_draw with no prior purchase → creates a checkout for the mapped starter price', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_draw' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_starter_draw');
    });

    it('starter pack already purchased → 400 ALREADY_PURCHASED, never reaches Paddle', async () => {
      comm.starterUsed.set(accountId, ['starter_draw']);
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_draw' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_PURCHASED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('starter_growth within the first-N-days window → creates a checkout', async () => {
      // Account was just created at fakeNow (see beforeEach) — well inside GROWTH_PACK_WINDOW_DAYS(7).
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_growth' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_starter_growth');
    });

    it('starter_growth after the first-N-days window has closed → 400 NO_PERMISSION, never reaches Paddle ' +
      '(branch paddle-routes.e2e.test.ts never exercises: it only tests the already-purchased precheck)', async () => {
      fakeNow += 8 * 86400000; // account is now 8 days old, window is GROWTH_PACK_WINDOW_DAYS(7)
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_growth' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('NO_PERMISSION');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /paddle/webhook', () => {
    it('NW_PADDLE_WEBHOOK_SECRET not configured → 503, before signature is even checked', async () => {
      delete process.env.NW_PADDLE_WEBHOOK_SECRET;
      const raw = JSON.stringify({ event_type: 'transaction.completed' });
      const r = await app.inject({
        method: 'POST', url: '/paddle/webhook', payload: raw,
        headers: { 'content-type': 'application/json', 'paddle-signature': 'ts=1;h1=deadbeef' },
      });
      expect(r.statusCode).toBe(503);
    });

    it('malformed JSON body → the custom content-type parser\'s JSON.parse failure path (done(e)) is hit, ' +
      'Fastify responds with a parse error before the handler ever runs (branch not reachable via postWebhook, ' +
      'which always sends valid JSON)', async () => {
      const raw = '{not valid json';
      const r = await app.inject({
        method: 'POST', url: '/paddle/webhook', payload: raw,
        headers: { 'content-type': 'application/json', 'paddle-signature': signWebhook(raw) },
      });
      // The content-type parser's done(e) surfaces as a plain 500 (Fastify treats a bare Error from a
      // content-type parser as an internal error, not a 4xx client error) — still proves the JSON.parse
      // catch branch (webhookRoute.ts lines 56-57) executed, and definitely never reaches the handler.
      expect(r.statusCode).toBe(500);
    });

    it('invalid signature → 400, event never processed', async () => {
      const r = await postWebhook(
        { event_type: 'transaction.completed', data: { id: 'tx1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] } },
        'ts=1;h1=deadbeef',
      );
      expect(r.statusCode).toBe(400);
      expect(comm.bal(accountId)).toBe(0);
    });

    it('an event type that is neither transaction.* nor adjustment.* is silently ignored, not logged ' +
      '(paddle-routes.e2e.test.ts never sends a non-transaction/non-adjustment event type)', async () => {
      const r = await postWebhook({ event_type: 'payout.created', data: { id: 'po_1' } });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('ignored');
      expect(comm.events).toHaveLength(0);
    });

    it('a transaction.* event with no data.id is ignored, not logged (recordPaddleEvent guarded on txData?.id)', async () => {
      const r = await postWebhook({ event_type: 'transaction.created', data: { status: 'draft' } });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('ignored');
      expect(comm.events).toHaveLength(0);
    });

    it('non-completed transaction event with data.id present (e.g. payment_failed) is logged via recordPaddleEvent', async () => {
      const r = await postWebhook({
        event_type: 'transaction.payment_failed',
        data: { id: 'tx-failed-1', status: 'payment_failed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('ignored');
      expect(comm.events).toHaveLength(1);
      expect(comm.events[0]).toMatchObject({ transactionId: 'tx-failed-1', eventType: 'transaction.payment_failed', accountId });
      expect(comm.bal(accountId)).toBe(0);
    });

    describe('transaction.completed missing required fields → 400, no grant attempted', () => {
      it('missing transaction id', async () => {
        const r = await postWebhook({
          event_type: 'transaction.completed',
          data: { status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
        });
        expect(r.statusCode).toBe(400);
        expect(r.payload).toBe('missing required fields');
      });

      it('status is not "completed" despite the event type', async () => {
        const r = await postWebhook({
          event_type: 'transaction.completed',
          data: { id: 'tx-bad-status', status: 'billed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
        });
        expect(r.statusCode).toBe(400);
        expect(comm.bal(accountId)).toBe(0);
      });

      it('missing accountId in custom_data', async () => {
        const r = await postWebhook({
          event_type: 'transaction.completed',
          data: { id: 'tx-no-acct', status: 'completed', items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
        });
        expect(r.statusCode).toBe(400);
      });

      it('missing price id (no items)', async () => {
        const r = await postWebhook({
          event_type: 'transaction.completed',
          data: { id: 'tx-no-price', status: 'completed', custom_data: { accountId }, items: [] },
        });
        expect(r.statusCode).toBe(400);
      });
    });

    it('unknown/unmapped priceId → 200 "unknown price", no coins credited (so Paddle does not retry)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-unknown-price', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_never_mapped' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('unknown price');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('transaction.completed for a coin price with quantity 1 → credits unitCoins × 1', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('ok');
      expect(comm.bal(accountId)).toBe(550);
    });

    it('transaction.completed for a coin price with quantity 3 (within range) → credits unitCoins × 3, ' +
      'and mirrors into the save (branch paddle-routes.e2e.test.ts never exercises: its coin-price test is always qty 1)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-qty3', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 3 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(550 * 3);
      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.wallet.coins).toBe(550 * 3);
    });

    it('transaction.completed for a coin price with an out-of-range quantity (999) is clamped to MAX(5) before crediting', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-qty999', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 999 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(550 * 5);
    });

    it('redelivered coin webhook (same transactionId) is idempotent — no double credit', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-replay', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
      };
      await postWebhook(payload);
      const first = comm.bal(accountId);
      const r2 = await postWebhook(payload);
      expect(r2.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(first);
    });

    it('paddleComplete business failure (grant refused after money changed hands) → logs via recordPaddleEvent, ' +
      'still 200 (no retry loop), no coins mirrored (branch not reached anywhere in paddle-routes.e2e.test.ts)', async () => {
      comm.forceGrantFail.add(accountId);
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-fail', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('processed');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('transaction.completed for monthly_card price → grants a 30-day subscription + 600 immediate coins', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(600);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000);
      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.monetization.subscriptionExpiry).toBe(fakeNow + 30 * 86400000);
    });

    it('transaction.completed for year_card price → grants a 365-day subscription', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-year-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_year' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 365 * 86400000);
    });

    it('reported quantity > 1 on a subscription price is ignored — grants exactly one card, not N', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-qty3', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 3 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000);
      expect(comm.bal(accountId)).toBe(600);
    });

    it('subscription grant business failure (e.g. race against a second checkout) → logs, no mirror, still 200', async () => {
      comm.forceGrantFail.add(accountId);
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-fail', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('processed');
      expect(comm.subscriptions.get(accountId)).toBeUndefined();
      expect(comm.events).toHaveLength(1);
    });

    it('subscription grant succeeds but getWallet then returns null → mirrorWalletFrom is skipped, still 200 ' +
      '(the `if (w)` false branch — every subscription success test in paddle-routes.e2e.test.ts has getWallet return non-null)', async () => {
      comm.walletNullFor.add(accountId);
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-nullwallet', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('ok');
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000); // grant still happened
    });

    it('transaction.completed for starter_draw price → grants the pack + delivers the loot-box result into the save', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-draw-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_draw' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.starterUsed.get(accountId)).toContain('starter_draw');
      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.inventory.skins).toContain('skin_starter_l1');
    });

    it('transaction.completed for starter_growth price → grants coins, mirrored into the save (results.length===0 branch, no deliverOrder call)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-growth-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_growth' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.starterUsed.get(accountId)).toContain('starter_growth');
      expect(comm.bal(accountId)).toBe(3300);
      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.wallet.coins).toBe(3300);
    });

    it('reported quantity > 1 on a starter pack price is ignored — grants exactly one pack, not N ' +
      '(the analogous warn-and-ignore branch to the subscription quantity check above; not reached by ' +
      'paddle-routes.e2e.test.ts, whose starter tests are always quantity 1)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-qty3', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_growth' }, quantity: 3 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.starterUsed.get(accountId)).toContain('starter_growth');
      expect(comm.bal(accountId)).toBe(3300); // 1× grant, not 3×
    });

    it('starter pack grant business failure → logs via recordPaddleEvent, no delivery, still 200 ' +
      '(branch not reached anywhere in paddle-routes.e2e.test.ts — its starter tests are all success paths)', async () => {
      comm.forceGrantFail.add(accountId);
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-fail', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_draw' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.payload).toBe('processed');
      expect(comm.starterUsed.get(accountId) ?? []).not.toContain('starter_draw');
      expect(comm.events).toHaveLength(1);
    });

    it('redelivered starter webhook (same transactionId) is idempotent — no double grant', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-replay', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_growth' }, quantity: 1 }] },
      };
      await postWebhook(payload);
      const first = comm.bal(accountId);
      const r2 = await postWebhook(payload);
      expect(r2.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(first);
    });

    it('adjustment.created refund (approved) → calls commercial.paddleRefund with the refunded transactionId', async () => {
      const r = await postWebhook({
        event_type: 'adjustment.created',
        data: { action: 'refund', status: 'approved', transaction_id: 'tx-refunded-1' },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.refunds).toEqual(['tx-refunded-1']);
    });

    it('adjustment.updated refund not yet approved (pending_approval) → does not call paddleRefund', async () => {
      const r = await postWebhook({
        event_type: 'adjustment.updated',
        data: { action: 'refund', status: 'pending_approval', transaction_id: 'tx-pending-1' },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.refunds).toEqual([]);
    });

    it('adjustment.created with action other than "refund" (e.g. a chargeback-related adjustment action) → does not call paddleRefund ' +
      '(branch not exercised by paddle-routes.e2e.test.ts, which only ever sends action:"refund")', async () => {
      const r = await postWebhook({
        event_type: 'adjustment.created',
        data: { action: 'credit', status: 'approved', transaction_id: 'tx-credit-1' },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.refunds).toEqual([]);
    });
  });
});
