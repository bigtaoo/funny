// commercial internalHttp end-to-end (S5-1 acceptance): real node:http server + global fetch calls.
//   • missing/wrong X-Internal-Key → 401 (S5-1 "requests without an internal key are rejected");
//   • routes: GET /internal/wallet, POST /internal/recharge/verify, GET /internal/orders/undelivered;
//   • unknown route → 404.
// service requires a real Mongo (dedicated database); entire suite skipped when Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import { startInternalHttp } from '../src/internalHttp';
import { createInternalAuth } from '@nw/shared';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_http_test';
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
if (!mongo) console.warn(`[internalHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 1000;

describe.skipIf(!mongo)('commercial internalHttp', () => {
  const m = mongo!;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new CommercialService({ cols: m.collections, now: () => t++ });
    server = startInternalHttp(
      { host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) },
      svc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const hdr = (key?: string) => ({
    'content-type': 'application/json',
    ...(key ? { 'X-Internal-Key': key } : {}),
  });

  it('no X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/wallet?accountId=a`, { headers: hdr() });
    expect(r.status).toBe(401);
  });

  it('wrong X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/wallet?accountId=a`, { headers: hdr('wrong') });
    expect(r.status).toBe(401);
  });

  it('GET /internal/wallet (with key) → default 0', async () => {
    const r = await fetch(`${base}/internal/wallet?accountId=newbie`, { headers: hdr(KEY) });
    expect(r.status).toBe(200);
    expect(await jsonBody(r)).toEqual({
      ok: true,
      coins: 0,
      pity: {},
      fatePoints: 0,
      subscriptionExpiry: 0,
      starterUsed: [],
      firstPurchaseUsed: false,
      totalRechargeCents: 0,
    });
  });

  it('POST /internal/recharge/verify → adds coins', async () => {
    const r = await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'u', platform: 'web', receipt: 'tier:t499', receiptId: 'rx1' }),
    });
    // First recharge on a fresh account gets the first-purchase 2× bonus (t499 = 550 → 1100).
    expect(await jsonBody(r)).toMatchObject({ ok: true, coinsGranted: 1100, coinsAfter: 1100 });
  });

  it('POST /internal/shop/charge with qty in the raw JSON body debits cost×qty and records qty on the order (2026-08-10 bulk-buy)', async () => {
    // Two recharges (500*3=1500 needed; a single t499 recharge only nets 1100 with the first-purchase bonus).
    await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'bulk-w', platform: 'web', receipt: 'tier:t499', receiptId: 'rx-bulk-1' }),
    });
    await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'bulk-w', platform: 'web', receipt: 'tier:t499', receiptId: 'rx-bulk-2' }),
    });
    const before = await jsonBody(await fetch(`${base}/internal/wallet?accountId=bulk-w`, { headers: hdr(KEY) }));
    const r = await fetch(`${base}/internal/shop/charge`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'bulk-w', itemId: 'protect_enhance', cost: 500, qty: 3, orderId: 'oBulk' }),
    });
    const b = await jsonBody(r);
    expect(b).toMatchObject({ ok: true, coinsAfter: before.coins - 500 * 3, status: 'charged' });
    const undelivered = await jsonBody(await fetch(`${base}/internal/orders/undelivered?accountId=bulk-w`, { headers: hdr(KEY) }));
    expect(undelivered.orders[0].result.qty).toBe(3);
  });

  it('POST /internal/shop/charge omits qty in the raw JSON body → defaults to 1, unchanged from before the qty param existed', async () => {
    await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'no-qty-w', platform: 'web', receipt: 'tier:t499', receiptId: 'rx-noqty' }),
    });
    const before = await jsonBody(await fetch(`${base}/internal/wallet?accountId=no-qty-w`, { headers: hdr(KEY) }));
    const r = await fetch(`${base}/internal/shop/charge`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'no-qty-w', itemId: 'protect_enhance', cost: 500, orderId: 'oNoQty' }),
    });
    const b = await jsonBody(r);
    expect(b).toMatchObject({ ok: true, coinsAfter: before.coins - 500 });
    const undelivered = await jsonBody(await fetch(`${base}/internal/orders/undelivered?accountId=no-qty-w`, { headers: hdr(KEY) }));
    expect(undelivered.orders[0].result.qty).toBe(1);
  });

  it('GET /internal/orders/undelivered → list', async () => {
    // Recharge first, then spend coins to create an undelivered order.
    await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'v', platform: 'web', receipt: 'tier:t499', receiptId: 'rx2' }),
    });
    await fetch(`${base}/internal/shop/charge`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'v', itemId: 'skin_shop_c1', cost: 300, orderId: 'oU' }),
    });
    const r = await fetch(`${base}/internal/orders/undelivered?accountId=v`, { headers: hdr(KEY) });
    const b = await jsonBody(r);
    expect(b.ok).toBe(true);
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0]._id).toBe('oU');
  });

  it('unknown route → 404', async () => {
    const r = await fetch(`${base}/internal/nope`, { method: 'POST', headers: hdr(KEY), body: '{}' });
    expect(r.status).toBe(404);
  });
});
