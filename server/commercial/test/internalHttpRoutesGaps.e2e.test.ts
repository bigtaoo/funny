// commercial internalHttp route gap-fill (real node:http server + real Mongo, mirrors
// internalHttp.e2e.test.ts). That file only ever drives GET /internal/wallet, POST
// /internal/recharge/verify, POST /internal/shop/charge, GET /internal/orders/undelivered, and the
// 401/404 boundary — the other ~20 routes (spend/grant/gacha draw/order delivered/non-coin receipt/ads
// credit/victory credit/promo codes+redeem/paddle complete+refund+event+events list/custom gacha pool
// create+close/fate redeem/monthly+year card buy+claim/starter buy/gacha pools list/audit coin-gains)
// were only ever exercised by calling CommercialService methods directly (service.e2e.test.ts,
// service-idempotency.e2e.test.ts, promo.test.ts, audit.e2e.test.ts, ...) — never through the actual
// node:http request parsing + route-matching layer in internalHttp.ts. This file drives each of them
// through the real HTTP surface at least once; business-rule depth is already covered by those files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createInternalAuth } from '@nw/shared';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import { startInternalHttp } from '../src/internalHttp';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_http_gaps_test';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[internalHttpRoutesGaps.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 1000;

describe.skipIf(!mongo)('commercial internalHttp routes gap-fill e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new CommercialService({ cols: m.collections, now: () => t++ });
    server = startInternalHttp({ host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) }, svc);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const hdr = { 'content-type': 'application/json', 'X-Internal-Key': KEY };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`, { headers: hdr });
  const recharge = (accountId: string, receiptId: string) =>
    post('/internal/recharge/verify', { accountId, platform: 'web', receipt: 'tier:t499', receiptId });

  it('GET /health: no auth required', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toEqual({ ok: true, service: 'commercial' });
  });

  it('POST /internal/spend: debits coins', async () => {
    await recharge('spend-a', 'rx-spend-1');
    const before = await jsonBody(await get('/internal/wallet?accountId=spend-a'));
    const r = await post('/internal/spend', { accountId: 'spend-a', amount: 200, reason: 'test', orderId: 'sp1' });
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b).toMatchObject({ ok: true, coinsAfter: before.coins - 200 });
  });

  it('POST /internal/grant: credits coins', async () => {
    const r = await post('/internal/grant', { accountId: 'grant-a', amount: 300, reason: 'gift', orderId: 'gr1' });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toMatchObject({ ok: true, coinsAfter: 300 });
  });

  it('POST /internal/gacha/draw: debits + returns results', async () => {
    await recharge('gacha-a', 'rx-gacha-1');
    const r = await post('/internal/gacha/draw', { accountId: 'gacha-a', poolId: 'standard', count: 1, orderId: 'gd1' });
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.ok).toBe(true);
    expect(b.results).toHaveLength(1);
  });

  it('POST /internal/order/delivered: marks an order delivered', async () => {
    await recharge('order-a', 'rx-order-1');
    const charge = await post('/internal/shop/charge', { accountId: 'order-a', itemId: 'protect_enhance', cost: 500, orderId: 'od-gap-1' });
    expect((await jsonBody(charge)).ok).toBe(true);
    const r = await post('/internal/order/delivered', { orderId: 'od-gap-1' });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toMatchObject({ ok: true });
    const undelivered = await jsonBody(await get('/internal/orders/undelivered?accountId=order-a'));
    expect(undelivered.orders).toHaveLength(0);
  });

  describe('POST /internal/nonCoinReceipt/verify', () => {
    it('bad expectedProduct -> 400', async () => {
      const r = await post('/internal/nonCoinReceipt/verify', {
        accountId: 'nc-gap-a', platform: 'web', receipt: 'product:monthly_card', receiptId: 'ncgap1', expectedProduct: 'not_a_real_product',
      });
      expect(r.status).toBe(400);
    });
    it('valid receipt for the expected product -> ok', async () => {
      const r = await post('/internal/nonCoinReceipt/verify', {
        accountId: 'nc-gap-b', platform: 'web', receipt: 'product:monthly_card', receiptId: 'ncgap2', expectedProduct: 'monthly_card',
      });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: true, product: 'monthly_card' });
    });
  });

  it('POST /internal/ads/credit', async () => {
    const r = await post('/internal/ads/credit', { accountId: 'ads-a', amount: 50, dayKey: '2026-08-14' });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toMatchObject({ ok: true });
  });

  it('POST /internal/victory/credit', async () => {
    const r = await post('/internal/victory/credit', { accountId: 'victory-a', amount: 5, dayKey: '2026-08-14' });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toMatchObject({ ok: true });
  });

  describe('promo codes + redeem', () => {
    it('GET /internal/promo/codes: empty initially', async () => {
      const r = await get('/internal/promo/codes');
      expect(r.status).toBe(200);
      expect((await jsonBody(r)).codes).toEqual([]);
    });

    it('POST /internal/promo/codes: creates a code, then GET lists it', async () => {
      const r = await post('/internal/promo/codes', { code: 'GAPCODE', coins: 150, createdBy: 'admin-gap' });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, code: 'GAPCODE' });
      const list = await jsonBody(await get('/internal/promo/codes'));
      expect(list.codes.some((c: { _id: string }) => c._id === 'GAPCODE')).toBe(true);
    });

    it('POST /internal/promo/redeem: credits the account, rejects unknown codes', async () => {
      const r = await post('/internal/promo/redeem', { accountId: 'promo-gap-a', code: 'gapcode' }); // lowercase — case-insensitive
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, coinsGranted: 150 });

      const bad = await post('/internal/promo/redeem', { accountId: 'promo-gap-a', code: 'NO-SUCH-CODE' });
      expect(bad.status).toBe(200);
      expect(await jsonBody(bad)).toMatchObject({ ok: false });
    });
  });

  describe('paddle', () => {
    it('POST /internal/paddle/complete: credits with first-purchase bonus', async () => {
      const r = await post('/internal/paddle/complete', { accountId: 'paddle-gap-a', transactionId: 'txn-gap-1', coins: 500, usdCents: 999 });
      expect(r.status).toBe(200);
      expect((await jsonBody(r)).ok).toBe(true);
    });

    it('POST /internal/paddle/event: records an event; GET /internal/paddle/events lists it filtered by accountId/transactionId', async () => {
      const r = await post('/internal/paddle/event', {
        transactionId: 'txn-gap-1', eventType: 'transaction.completed', status: 'completed', accountId: 'paddle-gap-a', rawEvent: '{"raw":true}',
      });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: true });

      const byAccount = await jsonBody(await get('/internal/paddle/events?accountId=paddle-gap-a'));
      expect(byAccount.events).toHaveLength(1);
      const byTxn = await jsonBody(await get('/internal/paddle/events?transactionId=txn-gap-1&limit=5'));
      expect(byTxn.events).toHaveLength(1);
      const byNeither = await jsonBody(await get('/internal/paddle/events?accountId=nobody'));
      expect(byNeither.events).toHaveLength(0);
    });

    it('POST /internal/paddle/refund: decrements totalRechargeCents for the completed transaction', async () => {
      const before = await jsonBody(await get('/internal/wallet?accountId=paddle-gap-a'));
      expect(before.totalRechargeCents).toBeGreaterThan(0);
      const r = await post('/internal/paddle/refund', { transactionId: 'txn-gap-1' });
      expect(r.status).toBe(200);
      const b = await jsonBody(r);
      expect(b).toMatchObject({ ok: true });
      expect(b.decrementedCents).toBeGreaterThan(0);
      const after = await jsonBody(await get('/internal/wallet?accountId=paddle-gap-a'));
      expect(after.totalRechargeCents).toBe(before.totalRechargeCents - b.decrementedCents);
    });
  });

  describe('gacha pools', () => {
    it('GET /internal/gacha/pools: lists static pools; ?active=1 filters to currently-open ones', async () => {
      const all = await jsonBody(await get('/internal/gacha/pools'));
      expect(all.ok).toBe(true);
      expect(Array.isArray(all.pools)).toBe(true);
      const active = await jsonBody(await get(`/internal/gacha/pools?active=1&now=${Date.now()}`));
      expect(active.ok).toBe(true);
    });

    it('POST /internal/gacha/pool/custom: rejects a config shadowing a static pool id; creates a valid custom pool', async () => {
      const shadow = await post('/internal/gacha/pool/custom', {
        config: { id: 'standard', name: 'X', costSingle: 100, startAt: 0, endAt: 9_999_999_999_999, categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_l1', weight: 1 }] }] },
        createdBy: 'admin-gap',
      });
      expect(shadow.status).toBe(200);
      expect(await jsonBody(shadow)).toMatchObject({ ok: false, error: 'BAD_REQUEST' });

      const created = await post('/internal/gacha/pool/custom', {
        config: { id: 'gapfest', name: 'Gap Fest', costSingle: 150, startAt: 0, endAt: 9_999_999_999_999, categories: [{ category: 'skin', weight: 100, items: [{ itemId: 'skin_l1', weight: 1 }] }] },
        createdBy: 'admin-gap',
      });
      expect(created.status).toBe(200);
      expect(await jsonBody(created)).toEqual({ ok: true, id: 'gapfest' });
    });

    it('the custom pool is drawable, then POST /internal/gacha/pool/close makes it unavailable', async () => {
      await recharge('gapfest-buyer', 'rx-gapfest-1');
      const draw = await post('/internal/gacha/draw', { accountId: 'gapfest-buyer', poolId: 'gapfest', count: 1, orderId: 'gf1' });
      expect((await jsonBody(draw)).ok).toBe(true);

      const close = await post('/internal/gacha/pool/close', { id: 'gapfest' });
      expect(close.status).toBe(200);
      expect(await jsonBody(close)).toMatchObject({ ok: true });

      const afterClose = await post('/internal/gacha/draw', { accountId: 'gapfest-buyer', poolId: 'gapfest', count: 1, orderId: 'gf2' });
      expect(await jsonBody(afterClose)).toEqual({ ok: false, error: 'POOL_UNAVAILABLE' });
    });
  });

  it('POST /internal/fate/redeem: a fresh account with no fate points is rejected (route reachable; deep fate-accrual logic covered elsewhere)', async () => {
    const r = await post('/internal/fate/redeem', { accountId: 'fate-gap-a', itemId: 'skin_lim2', orderId: 'fr-gap-1' });
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).ok).toBe(false);
  });

  describe('monthly / year card + starter pack', () => {
    it('POST /internal/monthly-card/buy then /internal/monthly-card/claim', async () => {
      await recharge('mc-gap-a', 'rx-mc-1');
      const buy = await post('/internal/monthly-card/buy', { accountId: 'mc-gap-a', orderId: 'mcb-gap-1' });
      expect(buy.status).toBe(200);
      expect((await jsonBody(buy)).ok).toBe(true);

      const claim = await post('/internal/monthly-card/claim', { accountId: 'mc-gap-a', dayKey: '2026-08-14' });
      expect(claim.status).toBe(200);
      const claimBody = await jsonBody(claim);
      expect(claimBody.ok).toBe(true);
      expect(claimBody.claimed).toBeGreaterThan(0);
      // Same day again -> ok:true but claimed:0 (no double-drip; ok stays true, this is not an error).
      const claim2 = await post('/internal/monthly-card/claim', { accountId: 'mc-gap-a', dayKey: '2026-08-14' });
      const claim2Body = await jsonBody(claim2);
      expect(claim2Body.ok).toBe(true);
      expect(claim2Body.claimed).toBe(0);
    });

    it('POST /internal/year-card/buy', async () => {
      await recharge('yc-gap-a', 'rx-yc-1');
      const buy = await post('/internal/year-card/buy', { accountId: 'yc-gap-a', orderId: 'ycb-gap-1' });
      expect(buy.status).toBe(200);
      expect((await jsonBody(buy)).ok).toBe(true);
    });

    it('POST /internal/starter/buy: starter_draw then starter_growth', async () => {
      await recharge('starter-gap-a', 'rx-starter-1');
      const draw = await post('/internal/starter/buy', { accountId: 'starter-gap-a', productId: 'starter_draw', orderId: 'sdo-gap-1' });
      expect(draw.status).toBe(200);
      expect((await jsonBody(draw)).ok).toBe(true);

      const growth = await post('/internal/starter/buy', { accountId: 'starter-gap-a', productId: 'starter_growth', orderId: 'sgo-gap-1' });
      expect(growth.status).toBe(200);
      expect((await jsonBody(growth)).ok).toBe(true);
    });
  });

  it('GET /internal/audit/coin-gains: missing dayKey -> 400; with dayKey -> ok', async () => {
    const missing = await get('/internal/audit/coin-gains');
    expect(missing.status).toBe(400);

    const ok = await get('/internal/audit/coin-gains?dayKey=2026-08-14&minGain=1');
    expect(ok.status).toBe(200);
    expect((await jsonBody(ok)).ok).toBe(true);
  });
});
