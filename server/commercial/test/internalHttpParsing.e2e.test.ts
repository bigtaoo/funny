// internalHttp.ts's request-parsing and error-mapping edges (real node:http server + real Mongo).
//
// internalHttp.e2e.test.ts and internalHttpRoutesGaps.e2e.test.ts drive every route with a well-formed
// body; what neither reaches is what happens when the body ISN'T well-formed (77.31% branches,
// claudedocs/server-testing-coverage.md). That gap matters more here than in most parsers, because
// `str()`/`num()`/`strOpt()` are the whole type boundary between meta's JSON and code that moves coins:
// every optional-field ternary in this file exists so a missing or wrongly-typed field becomes a
// harmless default instead of `undefined`/`NaN` reaching a Mongo `$inc`. This file sends bodies with
// fields missing, fields of the wrong type, no body at all, an unparseable body, and one over the 1MB
// cap, and pins that each lands as a business rejection or a 4xx — never a wallet mutation, and never a
// leaked provider/driver message in the response.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { connect } from 'net';
import type { AddressInfo } from 'net';
import { createInternalAuth } from '@nw/shared';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { CommercialDeps } from '../src/service/base';
import { startInternalHttp } from '../src/internalHttp';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_http_parsing_test';
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
if (!mongo) console.warn(`[internalHttpParsing.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 1000;

describe.skipIf(!mongo)('commercial internalHttp request parsing', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new CommercialService({ cols: m.collections, now: () => t++ });
    server = startInternalHttp({ host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) }, svc);
    await new Promise<void>((res) => server.on('listening', res));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const hdr = { 'content-type': 'application/json', 'X-Internal-Key': KEY };
  const get = (path: string) => fetch(`${base}${path}`, { headers: hdr });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  const postRaw = (path: string, body?: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: hdr, ...(body === undefined ? {} : { body }) });

  // ── body parsing ───────────────────────────────────────────────────────────
  describe('body parsing', () => {
    it('a POST with no body at all is read as {} and rejected on the business rule, not a crash', async () => {
      const r = await postRaw('/internal/spend');
      expect(r.status).toBe(200);
      // str() → '', num() → 0 ⇒ amount 0 ⇒ BAD_REQUEST. Nothing was written.
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.orders.countDocuments({})).toBe(0);
    });

    it('an unparseable body is a 400 with no parser detail echoed back', async () => {
      const r = await postRaw('/internal/spend', '{ "accountId": ');
      expect(r.status).toBe(400);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    });

    it('wrongly-typed fields fall back to their defaults instead of reaching the wallet', async () => {
      // num() guards typeof+finite, str() guards typeof: a string amount must not become NaN in a $inc,
      // and a numeric accountId must not become the wallet key "123".
      const r = await post('/internal/spend', { accountId: 123, amount: '500', reason: null, orderId: ['x'], clientPlatform: 7 });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.wallets.countDocuments({})).toBe(0);
    });

    it('an over-1MB body is cut off rather than accumulated (no 2xx, nothing written)', async () => {
      // readJson destroys the request once past the cap, so the client sees either the 400 the outer
      // catch sends or a torn-down connection — the point is that neither is a success, and the body was
      // never buffered to completion (P0-9).
      const huge = JSON.stringify({ accountId: 'huge', amount: 1, reason: 'x', orderId: 'huge-1', pad: 'x'.repeat(1 << 21) });
      const outcome = await postRaw('/internal/spend', huge).then(
        (r) => r.status,
        () => 'connection-torn-down' as const,
      );
      expect([400, 'connection-torn-down']).toContain(outcome);
      expect(await m.collections.orders.countDocuments({ _id: 'huge-1' })).toBe(0);
    });
  });

  // ── method / query-parameter guards ────────────────────────────────────────
  describe('method and query guards', () => {
    it('a non-GET, non-POST method is a 404 (no verb is silently treated as POST)', async () => {
      const r = await fetch(`${base}/internal/spend`, { method: 'PUT', headers: hdr, body: '{}' });
      expect(r.status).toBe(404);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'not found' });
    });

    it('GET /internal/wallet without accountId → 400', async () => {
      const r = await get('/internal/wallet');
      expect(r.status).toBe(400);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'accountId required' });
    });

    it('GET /internal/orders/undelivered without accountId → 400', async () => {
      const r = await get('/internal/orders/undelivered');
      expect(r.status).toBe(400);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'accountId required' });
    });

    it('GET /internal/audit/coin-gains without dayKey → 400', async () => {
      const r = await get('/internal/audit/coin-gains');
      expect(r.status).toBe(400);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'dayKey required' });
    });

    // minGain is a threshold, so a missing/zero/negative/garbage value must clamp to 1 rather than
    // becoming NaN (which would make the `$gte` match nothing and quietly report "no suspicious gains").
    it.each([
      ['absent', '', 1],
      ['zero', '&minGain=0', 1],
      ['negative', '&minGain=-5', 1],
      ['not a number', '&minGain=abc', 1],
      ['positive', '&minGain=7', 7],
    ])('GET /internal/audit/coin-gains with a %s minGain answers 200', async (_label, qs) => {
      const r = await get(`/internal/audit/coin-gains?dayKey=2026-09-03${qs}`);
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, accounts: [] });
    });

    it('GET /internal/gacha/pools?active=1 without a now parameter falls back to the wall clock', async () => {
      const r = await get('/internal/gacha/pools?active=1');
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, pools: [] });
    });

    it('GET /internal/paddle/events with no filters at all answers 200', async () => {
      const r = await get('/internal/paddle/events');
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, events: [] });
    });

    // The URL is parsed against a synthetic base built from the Host header; a request that carries no
    // Host (HTTP/1.0) must still route rather than throwing on `new URL(...)`.
    it('routes a HTTP/1.0 request that sends no Host header', async () => {
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(`GET /internal/wallet?accountId=hostless HTTP/1.0\r\nX-Internal-Key: ${KEY}\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (c) => {
          buf += c;
        });
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
      });
      expect(raw).toContain('200 OK');
      expect(raw).toContain('"ok":true');
    });
  });

  // ── optional-field ternaries ───────────────────────────────────────────────
  describe('optional fields omitted vs supplied', () => {
    it('order/delivered: a non-numeric refundCoins is dropped exactly like an absent one', async () => {
      // A 'charged' shop order is needed for the real delivery flip (a grant lands 'delivered' already,
      // which takes the heal branch instead — see orders.ts).
      expect((await jsonBody(await post('/internal/grant', { accountId: 'opt-a', amount: 1000, reason: 'fund', orderId: 'opt-fund' }))).ok).toBe(true);
      const charge = (orderId: string) =>
        post('/internal/shop/charge', { accountId: 'opt-a', itemId: 'skin_shop_c1', cost: 300, orderId });

      expect((await jsonBody(await charge('opt-no-refund'))).ok).toBe(true);
      expect(await jsonBody(await post('/internal/order/delivered', { orderId: 'opt-no-refund' }))).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'opt-no-refund' }))?.refundCoins).toBe(0);

      // `typeof b.refundCoins === 'number'` drops the string, so the service sees no refund at all —
      // a stringly-typed "50" must not become a 50-coin credit, and must not become NaN either.
      expect((await jsonBody(await charge('opt-bad-refund'))).ok).toBe(true);
      expect(await jsonBody(await post('/internal/order/delivered', { orderId: 'opt-bad-refund', refundCoins: '50' }))).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'opt-bad-refund' }))?.refundCoins).toBe(0);
      expect(await m.collections.ledger.countDocuments({ accountId: 'opt-a', reason: 'gacha_refund' })).toBe(0);
    });

    it('order/delivered: a numeric refundCoins is threaded through and credited', async () => {
      // The other half of the same guard: a real number must reach the service (and the wallet) — the
      // starter order is used because a shop/gacha order's own debit row shares the orderId.
      const buy = await post('/internal/starter/buy', { accountId: 'opt-refund', productId: 'starter_draw', orderId: 'opt-refund-1' });
      expect((await jsonBody(buy)).ok).toBe(true);
      const delivered = await post('/internal/order/delivered', { orderId: 'opt-refund-1', refundCoins: 25 });
      expect(await jsonBody(delivered)).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'opt-refund-1' }))?.refundCoins).toBe(25);
      expect((await m.collections.wallets.findOne({ _id: 'opt-refund' }))?.coins).toBe(25);
    });

    it('clientPlatform is threaded through when it IS a string (ios reads the apple bucket)', async () => {
      // strOpt's other half: the header meta forwards decides which recharged bucket the returned
      // balance reflects (ADR-020), so it must survive the parse rather than being dropped.
      const r = await get('/internal/wallet?accountId=plat-ios&clientPlatform=ios');
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, coins: 0 });
      const buy = await post('/internal/monthly-card/buy', {
        accountId: 'plat-ios', orderId: 'plat-ios-1', rechargePlatform: 'apple', clientPlatform: 'ios',
      });
      const body = await jsonBody(buy);
      expect(body.ok).toBe(true);
      expect(body.coinsAfter).toBeGreaterThan(0); // the apple bucket it just funded, not the free pool
      expect((await m.collections.wallets.findOne({ _id: 'plat-ios' }))?.coins).toBe(0);
    });

    it('promo/codes: expiresAt / totalLimit / note omitted are stored as absent, not as undefined values', async () => {
      const r = await post('/internal/promo/codes', { code: 'BAREBONES', coins: 50, createdBy: 'admin1' });
      expect(await jsonBody(r)).toEqual({ ok: true, code: 'BAREBONES' });
      const doc = await m.collections.promoCodes.findOne({ _id: 'BAREBONES' });
      expect(doc).toMatchObject({ coins: 50, redeemed: 0, createdBy: 'admin1' });
      expect(Object.keys(doc!)).not.toContain('expiresAt');
      expect(Object.keys(doc!)).not.toContain('totalLimit');
      expect(Object.keys(doc!)).not.toContain('note');
    });

    it('promo/codes: expiresAt / totalLimit / note supplied are stored (totalLimit floored)', async () => {
      const r = await post('/internal/promo/codes', {
        code: 'FULLY_SPECD',
        coins: 50,
        createdBy: 'admin1',
        expiresAt: 9_000_000,
        totalLimit: 10.7,
        note: 'summer campaign',
      });
      expect(await jsonBody(r)).toEqual({ ok: true, code: 'FULLY_SPECD' });
      expect(await m.collections.promoCodes.findOne({ _id: 'FULLY_SPECD' })).toMatchObject({
        expiresAt: 9_000_000,
        totalLimit: 10,
        note: 'summer campaign',
      });
    });

    it('promo/codes: wrongly-typed optional fields are dropped rather than stored', async () => {
      const r = await post('/internal/promo/codes', {
        code: 'TYPO',
        coins: 50,
        createdBy: 'admin1',
        expiresAt: 'tomorrow',
        totalLimit: '10',
        note: 42,
      });
      expect(await jsonBody(r)).toEqual({ ok: true, code: 'TYPO' });
      const doc = await m.collections.promoCodes.findOne({ _id: 'TYPO' });
      expect(Object.keys(doc!)).not.toContain('expiresAt');
      expect(Object.keys(doc!)).not.toContain('totalLimit');
      expect(Object.keys(doc!)).not.toContain('note');
    });

    it('paddle/event: status and accountId omitted still logs the event', async () => {
      const r = await post('/internal/paddle/event', {
        transactionId: 'txn_min',
        eventType: 'transaction.created',
        rawEvent: '{}',
      });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: true });
      const ev = await m.collections.paddleEvents.findOne({ _id: 'txn_min:transaction.created' });
      expect(ev).toMatchObject({ transactionId: 'txn_min', eventType: 'transaction.created' });
      // recordPaddleEvent `$set`s both fields unconditionally, and the driver serializes an absent
      // (undefined) value as null — so the log row carries explicit nulls, not the strings. Pinned as-is:
      // every reader treats them as falsy, and listPaddleEvents only filters on truthy values.
      expect(ev?.status).toBeNull();
      expect(ev?.accountId).toBeNull();
    });

    it('paddle/event: non-string status/accountId are dropped, not coerced into the log row', async () => {
      const r = await post('/internal/paddle/event', {
        transactionId: 'txn_typed',
        eventType: 'transaction.updated',
        status: 500,
        accountId: { id: 'x' },
        rawEvent: '{}',
      });
      expect(r.status).toBe(200);
      const ev = await m.collections.paddleEvents.findOne({ _id: 'txn_typed:transaction.updated' });
      expect(ev?.status).toBeNull();
      expect(ev?.accountId).toBeNull();
    });
  });

  // ── custom gacha pool config assembly ──────────────────────────────────────
  describe('POST /internal/gacha/pool/custom body assembly', () => {
    it('a request with no config at all is rejected by validation, not by a crash', async () => {
      const r = await post('/internal/gacha/pool/custom', { createdBy: 'admin1' });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'BAD_REQUEST' });
    });

    it('a category whose items is not an array becomes an empty item list (and fails validation)', async () => {
      const r = await post('/internal/gacha/pool/custom', {
        createdBy: 'admin1',
        config: {
          id: 'no_items_pool',
          name: 'Broken',
          costSingle: 100,
          startAt: 0,
          endAt: 10,
          categories: [{ category: 'material', weight: 1, items: 'oops' }],
        },
      });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.gachaPools.countDocuments({ _id: 'no_items_pool' })).toBe(0);
    });

    it('a valid config without costTen is stored without the field (the ×10 price stays derived)', async () => {
      const r = await post('/internal/gacha/pool/custom', {
        createdBy: 'admin1',
        config: {
          id: 'no_cost_ten',
          name: 'Derived Ten',
          costSingle: 100,
          startAt: 0,
          endAt: 99_999_999,
          categories: [{ category: 'material', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }],
        },
      });
      expect(await jsonBody(r)).toEqual({ ok: true, id: 'no_cost_ten' });
      const doc = await m.collections.gachaPools.findOne({ _id: 'no_cost_ten' });
      expect(Object.keys(doc!)).not.toContain('costTen');
    });

    it('a valid config WITH costTen keeps it', async () => {
      const r = await post('/internal/gacha/pool/custom', {
        createdBy: 'admin1',
        config: {
          id: 'with_cost_ten',
          name: 'Explicit Ten',
          costSingle: 100,
          costTen: 900,
          startAt: 0,
          endAt: 99_999_999,
          categories: [{ category: 'material', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }],
        },
      });
      expect(await jsonBody(r)).toEqual({ ok: true, id: 'with_cost_ten' });
      expect((await m.collections.gachaPools.findOne({ _id: 'with_cost_ten' }))!).toMatchObject({ costTen: 900 });
    });
  });
});

// A service failure must reach meta as a bare INTERNAL_ERROR: `e.message` here can carry a raw payment
// provider response body (iap.ts throws `${status}: ${body}`) or a Mongo connection string, and this
// endpoint's response is not the place for either. Driven with a deliberately dependency-less service so
// the first collection access throws, standing in for any unexpected runtime failure.
describe('internalHttp error mapping', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const broken = new CommercialService({} as CommercialDeps);
    server = startInternalHttp({ host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) }, broken);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('an unexpected service failure is a 400 INTERNAL_ERROR with no internal detail', async () => {
    const r = await fetch(`${base}/internal/spend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Internal-Key': KEY },
      body: JSON.stringify({ accountId: 'a', amount: 10, reason: 'x', orderId: 'o' }),
    });
    expect(r.status).toBe(400);
    expect(await jsonBody(r)).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
