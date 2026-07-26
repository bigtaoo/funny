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
  } catch {
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
  readonly available = true;
  coins = new Map<string, number>();
  subscriptions = new Map<string, { expiry: number; lastClaimDayKey?: string }>();
  /** orderId → granted, so monthlyCardBuy/yearCardBuy/paddleComplete replay idempotently like the real service. */
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
      starterUsed: [],
      firstPurchaseUsed: false,
      totalRechargeCents: 0,
    };
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
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499,monthly_card:pri_monthly,year_card:pri_year';

    // createPaddleTransaction hits the real Paddle API via global fetch — stub it so checkout tests never
    // touch the network. Returns a fresh fake transaction id per call.
    let txCounter = 0;
    fetchMock = vi.fn(async () => ({
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
  });
});
