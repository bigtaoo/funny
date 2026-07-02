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

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_http_test';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
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
    expect(await r.json()).toEqual({
      ok: true,
      coins: 0,
      pity: {},
      fatePoints: 0,
      subscriptionExpiry: 0,
      starterUsed: [],
    });
  });

  it('POST /internal/recharge/verify → adds coins', async () => {
    const r = await fetch(`${base}/internal/recharge/verify`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ accountId: 'u', platform: 'web', receipt: 'tier:t499', receiptId: 'rx1' }),
    });
    expect(await r.json()).toMatchObject({ ok: true, coinsGranted: 550, coinsAfter: 550 });
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
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0]._id).toBe('oU');
  });

  it('unknown route → 404', async () => {
    const r = await fetch(`${base}/internal/nope`, { method: 'POST', headers: hdr(KEY), body: '{}' });
    expect(r.status).toBe(404);
  });
});
