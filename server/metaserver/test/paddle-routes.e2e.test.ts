// Paddle route-level e2e: real Mongo + FakeCommercial + real fastify app via inject(). Covers what
// test/paddle.test.ts explicitly excludes — POST /shop/paddle/checkout and POST /paddle/webhook end to end,
// including the monthly/year card subscription branch added 2026-07-25 (COMMERCIAL_DESIGN.md §10.7).
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { CommercialClient, WalletView } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_paddle_routes_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const WEBHOOK_SECRET = 'whsec_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[paddle-routes.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Signs a raw webhook body the same way Paddle does (h1 scheme), so verifyPaddleSignature accepts it. */
function signWebhook(rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${rawBody}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

/**
 * Minimal fake commercial: only the surface paddle.ts actually touches (checkout's ALREADY_ACTIVE precheck via
 * getWallet, webhook grants via monthlyCardBuy/yearCardBuy/paddleComplete, event logging). Other CommercialClient
 * methods are never called by these routes and are left unimplemented (test files aren't part of the tsc
 * project — see metaserver/tsconfig.json `include` — so this compiles fine under `implements` regardless).
 */
class FakeCommercial implements CommercialClient {

  // Not exercised by this file — the Apple auto-renewal sync has its own suites
  // (commercial/test/appleSubscriptionSync.e2e.test.ts, metaserver/test/iapAppleSync.test.ts).
  // Present because CommercialClient requires it: a double that silently lacked a money-moving
  // method would let a handler regress to calling nothing at all and still look green.
  async subscriptionSyncApple(_a: { accountId: string; receipt: string }) {
    return { ok: true as const, coinsAfter: 0, subscriptionExpiry: 0, granted: 0 };
  }
  readonly available = true;
  coins = new Map<string, number>();
  subscriptions = new Map<string, { expiry: number; lastClaimDayKey?: string }>();
  starterUsed = new Map<string, string[]>();
  /** orderId → granted, so monthlyCardBuy/yearCardBuy/paddleComplete/starterBuy replay idempotently like the real service. */
  claimedOrders = new Set<string>();
  events: Array<{ transactionId: string; eventType: string; status?: string; accountId?: string }> = [];
  now = () => Date.now();

  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }

  async getWallet(id: string): Promise<WalletView | null> {
    const sub = this.subscriptions.get(id);
    return {
      coins: this.bal(id),
      pity: {},
      fatePoints: 0,
      subscriptionExpiry: sub?.expiry ?? 0,
      subscriptionLastClaimDay: sub?.lastClaimDayKey,
      starterUsed: this.starterUsed.get(id) ?? [],
      firstPurchaseUsed: false,
      totalRechargeCents: 0,
    };
  }

  /** Minimal starter pack fake (GACHA_DESIGN §6): once-per-account, mirrors the real service's shape closely
   * enough to exercise paddle.ts's webhook → deliverOrder path (starter_draw delivers one gacha result). */
  async starterBuy(a: { accountId: string; productId: string; orderId: string }) {
    if (this.claimedOrders.has(a.orderId)) {
      const used = this.starterUsed.get(a.accountId) ?? [];
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: used.includes(a.productId) ? [] : [] };
    }
    const used = this.starterUsed.get(a.accountId) ?? [];
    if (used.includes(a.productId)) return { ok: false as const, error: 'ALREADY_PURCHASED' };
    this.claimedOrders.add(a.orderId);
    this.starterUsed.set(a.accountId, [...used, a.productId]);
    if (a.productId === 'starter_growth') {
      this.coins.set(a.accountId, this.bal(a.accountId) + 3300);
      return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: [] };
    }
    return { ok: true as const, coinsAfter: this.bal(a.accountId), subscriptionExpiry: this.subscriptions.get(a.accountId)?.expiry ?? 0, results: [{ itemId: 'skin_l1', rarity: 'legendary' as const }] };
  }

  async orderDelivered(_a: { orderId: string; refundCoins?: number }) {
    return { ok: true as const };
  }

  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }

  private subscriptionCardBuy(accountId: string, orderId: string, days: number) {
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
    const key = `paddle:${a.transactionId}`;
    if (this.claimedOrders.has(key)) return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: 0 };
    this.claimedOrders.add(key);
    this.coins.set(a.accountId, this.bal(a.accountId) + a.coins);
    return { ok: true as const, coinsAfter: this.bal(a.accountId), coinsGranted: a.coins };
  }

  async recordPaddleEvent(a: { transactionId: string; eventType: string; status?: string; accountId?: string; rawEvent: string }) {
    this.events.push({ transactionId: a.transactionId, eventType: a.eventType, status: a.status, accountId: a.accountId });
  }

  /** Refund adjustment (ADR-045): records which transactionId was decremented, matching the real
   *  service's transactionId → totalRechargeCents lookup closely enough to prove the webhook reaches it. */
  refunds: string[] = [];
  async paddleRefund(a: { transactionId: string }) {
    this.refunds.push(a.transactionId);
    return { ok: true as const, decrementedCents: 999 };
  }
  // CommercialClient members this suite never exercises. They throw rather than answer: each was
  // simply absent before test/** was type-checked, so any call already crashed — this keeps that
  // truth while naming what happened.
  async shopCharge(): Promise<never> { throw new Error('FakeCommercial.shopCharge is not stubbed in this test'); }
  async gachaDraw(): Promise<never> { throw new Error('FakeCommercial.gachaDraw is not stubbed in this test'); }
  async createCustomPool(): Promise<never> { throw new Error('FakeCommercial.createCustomPool is not stubbed in this test'); }
  async closeLimitedPool(): Promise<never> { throw new Error('FakeCommercial.closeLimitedPool is not stubbed in this test'); }
  async listLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listLimitedPools is not stubbed in this test'); }
  async listActiveLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listActiveLimitedPools is not stubbed in this test'); }
  async redeemFate(): Promise<never> { throw new Error('FakeCommercial.redeemFate is not stubbed in this test'); }
  async monthlyCardClaim(): Promise<never> { throw new Error('FakeCommercial.monthlyCardClaim is not stubbed in this test'); }
  async spend(): Promise<never> { throw new Error('FakeCommercial.spend is not stubbed in this test'); }
  async undeliveredOrders(): Promise<never> { throw new Error('FakeCommercial.undeliveredOrders is not stubbed in this test'); }
  async rechargeVerify(): Promise<never> { throw new Error('FakeCommercial.rechargeVerify is not stubbed in this test'); }
  async verifyNonCoinReceipt(): Promise<never> { throw new Error('FakeCommercial.verifyNonCoinReceipt is not stubbed in this test'); }
  async adsCredit(): Promise<never> { throw new Error('FakeCommercial.adsCredit is not stubbed in this test'); }
  async victoryCredit(): Promise<never> { throw new Error('FakeCommercial.victoryCredit is not stubbed in this test'); }
  async promoRedeem(): Promise<never> { throw new Error('FakeCommercial.promoRedeem is not stubbed in this test'); }
  async createPromoCode(): Promise<never> { throw new Error('FakeCommercial.createPromoCode is not stubbed in this test'); }
  async listPromoCodes(): Promise<never> { throw new Error('FakeCommercial.listPromoCodes is not stubbed in this test'); }
  async listPaddleEvents(): Promise<never> { throw new Error('FakeCommercial.listPaddleEvents is not stubbed in this test'); }
  async auditCoinGains(): Promise<never> { throw new Error('FakeCommercial.auditCoinGains is not stubbed in this test'); }
}

describe.skipIf(!mongo)('paddle routes e2e (checkout + webhook)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let fakeNow = 0;
  let fetchMock: ReturnType<typeof vi.fn>;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  /** Injects a raw-string JSON payload through the webhook's custom content-type parser, matching how Paddle
   * actually posts (signature is computed over the exact raw body string). */
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

    // createPaddleTransaction hits the real Paddle API via global fetch — stub it so checkout tests never
    // touch the network. Returns a fresh fake transaction id per call.
    let txCounter = 0;
    fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      json: async () => ({ data: { id: `txn_${++txCounter}` } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm, now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-paddle-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save document
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NW_PADDLE_API_KEY;
    delete process.env.NW_PADDLE_WEBHOOK_SECRET;
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  describe('POST /shop/paddle/checkout', () => {
    it('unauthenticated → 401', async () => {
      const r = await app.inject({ method: 'POST', url: '/shop/paddle/checkout', payload: { tierId: 't499' } });
      expect(r.statusCode).toBe(401);
    });

    it('unknown tierId → 400 INVALID_TIER', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'not_a_real_tier' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('INVALID_TIER');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('valid coin tier → creates a Paddle transaction and returns its id', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't499' } }));
      expect(r.ok).toBe(true);
      expect(r.data.transactionId).toMatch(/^txn_/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_499');
    });

    it('a valid IAP tier with no mapped price id → 503 PADDLE_NOT_CONFIGURED', async () => {
      // t999 is a real IAP tier but NOT in NW_PADDLE_PRICE_IDS above.
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 't999' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PADDLE_NOT_CONFIGURED');
    });

    it('monthly_card with no active subscription → creates a checkout for the mapped subscription price', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'monthly_card' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_monthly');
    });

    it('year_card with no active subscription → creates a checkout for the mapped subscription price', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'year_card' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_year');
    });

    it('monthly_card while a card is already active → 400 ALREADY_ACTIVE, never reaches Paddle (no charge for a doomed purchase)', async () => {
      comm.subscriptions.set(accountId, { expiry: fakeNow + 10 * 86400000 });
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'monthly_card' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_ACTIVE');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('year_card is blocked by the same single-slot gate as monthly_card (shared subscription slot)', async () => {
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

    it('starter_draw with no prior purchase → creates a checkout for the mapped starter price (GACHA_DESIGN §6)', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_draw' } }));
      expect(r.ok).toBe(true);
      const callBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(callBody.items[0].price_id).toBe('pri_starter_draw');
    });

    it('starter_growth already purchased → 400 ALREADY_PURCHASED, never reaches Paddle', async () => {
      comm.starterUsed.set(accountId, ['starter_growth']);
      const r = body(await app.inject({ method: 'POST', url: '/shop/paddle/checkout', headers: auth(), payload: { tierId: 'starter_growth' } }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_PURCHASED');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /paddle/webhook', () => {
    it('invalid signature → 400', async () => {
      const r = await postWebhook(
        { event_type: 'transaction.completed', data: { id: 'tx1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] } },
        'ts=1;h1=deadbeef',
      );
      expect(r.statusCode).toBe(400);
    });

    it('transaction.completed for a coin price → credits coins (pre-existing flow, previously untested at route level)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-coin-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_499' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(550);
      expect(comm.subscriptions.get(accountId)).toBeUndefined();
    });

    it('transaction.completed for monthly_card price → grants a 30-day subscription + 600 immediate coins, mirrored into the save', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(600);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000);

      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.wallet.coins).toBe(600);
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

    it('redelivered webhook (same transactionId) is idempotent — no double grant', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-replay', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      };
      await postWebhook(payload);
      const expiryAfterFirst = comm.subscriptions.get(accountId)?.expiry;
      const coinsAfterFirst = comm.bal(accountId);

      const r2 = await postWebhook(payload); // Paddle's at-least-once redelivery
      expect(r2.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(expiryAfterFirst);
      expect(comm.bal(accountId)).toBe(coinsAfterFirst);
    });

    it('reported quantity > 1 on a subscription price is ignored — grants exactly one card, not N', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-qty3', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 3 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000); // 1×30 days, not 3×
      expect(comm.bal(accountId)).toBe(600); // 1× immediate bonus, not 3×
    });

    it('an extreme race where the subscription is already active by webhook time → logs the event for CS/refund lookup, does not extend twice, does not 5xx', async () => {
      // Simulates a second checkout slipping past the pre-check (e.g. two tabs) and completing payment
      // just as the first webhook already granted the card.
      comm.subscriptions.set(accountId, { expiry: fakeNow + 30 * 86400000 });
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-monthly-race', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)?.expiry).toBe(fakeNow + 30 * 86400000); // unchanged, not extended
      expect(comm.events).toHaveLength(1);
      expect(comm.events[0]).toMatchObject({ transactionId: 'tx-monthly-race', eventType: 'transaction.completed', accountId });
    });

    it('non-completed transaction event (e.g. payment_failed) is logged, not granted', async () => {
      const r = await postWebhook({
        event_type: 'transaction.payment_failed',
        data: { id: 'tx-failed-1', status: 'payment_failed', custom_data: { accountId }, items: [{ price: { id: 'pri_monthly' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.subscriptions.get(accountId)).toBeUndefined();
      expect(comm.events).toHaveLength(1);
      expect(comm.events[0]!.eventType).toBe('transaction.payment_failed');
    });

    it('adjustment.created refund (approved) → calls commercial.paddleRefund with the refunded transactionId (ADR-045)', async () => {
      const r = await postWebhook({
        event_type: 'adjustment.created',
        data: { action: 'refund', status: 'approved', transaction_id: 'tx-refunded-1' },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.refunds).toEqual(['tx-refunded-1']);
    });

    it('adjustment.updated refund not yet approved (e.g. pending_approval) → does not call paddleRefund', async () => {
      const r = await postWebhook({
        event_type: 'adjustment.updated',
        data: { action: 'refund', status: 'pending_approval', transaction_id: 'tx-pending-1' },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.refunds).toEqual([]);
    });

    it('transaction.completed for starter_draw price → grants the pack + delivers the gacha result into the save (GACHA_DESIGN §6)', async () => {
      const r = await postWebhook({
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-draw-1', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_draw' }, quantity: 1 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(comm.starterUsed.get(accountId)).toContain('starter_draw');
      const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(save.data.save.inventory.skins).toContain('skin_l1');
    });

    it('transaction.completed for starter_growth price → grants coins, mirrored into the save', async () => {
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

    it('redelivered starter webhook (same transactionId) is idempotent — no double grant', async () => {
      const payload = {
        event_type: 'transaction.completed',
        data: { id: 'tx-starter-replay', status: 'completed', custom_data: { accountId }, items: [{ price: { id: 'pri_starter_growth' }, quantity: 1 }] },
      };
      await postWebhook(payload);
      const coinsAfterFirst = comm.bal(accountId);
      const r2 = await postWebhook(payload); // Paddle's at-least-once redelivery
      expect(r2.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBe(coinsAfterFirst);
    });
  });
});
