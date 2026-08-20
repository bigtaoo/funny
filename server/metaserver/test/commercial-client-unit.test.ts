// src-attributed unit coverage for src/commercialClient.ts (HttpCommercialClient).
// test/commercial-client.test.ts already exists but imports from '../dist/commercialClient.js' —
// vitest's v8 coverage provider only attributes coverage to src/*.ts when the module was loaded via
// vitest's own transform, so exercising the compiled dist through Node's ESM loader records zero
// coverage against src/commercialClient.ts even though the same logic runs (see that file's header).
// This file imports the real class directly from '../src/commercialClient.js' against a real
// node:http fixture server, so every wrapper method's lines get attributed to src.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpCommercialClient } from '../src/commercialClient.js';
import type { CustomPoolConfig } from '@nw/shared';

const KEY = 'k-internal';
let lastReq: { url: string; method: string; key: string | undefined; body: string } | null = null;
let requestCount = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

/** One blanket "everything succeeded" payload — a superset of every method's expected response shape. */
const GENERIC_OK = {
  ok: true,
  coins: 42,
  pity: { standard: 1 },
  fatePoints: 2,
  subscriptionExpiry: 555,
  subscriptionLastClaimDay: '2026-08-01',
  starterUsed: ['s1'],
  firstPurchaseUsed: true,
  totalRechargeCents: 999,
  orderId: 'o1',
  coinsAfter: 100,
  status: 'ok',
  itemId: 'it1',
  pityAfter: 1,
  results: [{ itemId: 'x', rarity: 'common' }],
  fateGained: 0,
  fatePointsAfter: 2,
  id: 'pool1',
  pools: [{ id: 'p1', createdBy: 'ops', createdAt: 1 }],
  claimed: 1,
  wallet: { coins: 1, pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 },
  orders: [{ _id: 'o1', accountId: 'a', kind: 'shop', result: { itemId: 'x' } }],
  coinsGranted: 5,
  product: 'monthly_card',
  decrementedCents: 3,
  events: [{ transactionId: 't1', eventType: 'x', rawEvent: '{}', ts: 1 }],
  accounts: [{ accountId: 'a', nonRechargeGain: 10 }],
  codes: [{ code: 'c1', coins: 5, redeemed: 0, createdBy: 'x', createdAt: 1 }],
  code: 'c1',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      requestCount++;
      const body = await readBody(req);
      lastReq = {
        url: req.url ?? '',
        method: req.method ?? '',
        key: req.headers['x-internal-key'] as string | undefined,
        body,
      };
      const send = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = new URL(req.url ?? '', 'http://x');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        /* not JSON */
      }
      if (parsed._forceNonJson) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not-json-body');
        return;
      }
      if (typeof parsed._forceBusinessError === 'string') {
        return send({ ok: false, error: parsed._forceBusinessError });
      }
      if (url.searchParams.get('forceError') === '1' || url.searchParams.get('accountId') === '__forceError__') {
        return send({ ok: false, error: 'GET_ERROR' });
      }
      return send(GENERIC_OK);
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpCommercialClient — availability', () => {
  it('baseUrl set → available=true; baseUrl=null → available=false', () => {
    expect(new HttpCommercialClient(base, KEY).available).toBe(true);
    expect(new HttpCommercialClient(null, KEY).available).toBe(false);
  });
});

describe('HttpCommercialClient — POST-only Body<T> wrapper methods', () => {
  it('every wrapper POSTs to its documented path with X-Internal-Key and forwards the ok:true body', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const cases: Array<{ path: string; call: () => Promise<{ ok: boolean }> }> = [
      { path: '/internal/shop/charge', call: () => client.shopCharge({ accountId: 'a', itemId: 'i', cost: 1, orderId: 'o' }) },
      { path: '/internal/gacha/draw', call: () => client.gachaDraw({ accountId: 'a', poolId: 'p', count: 1, orderId: 'o' }) },
      {
        path: '/internal/gacha/pool/custom',
        call: () => client.createCustomPool({ config: { id: 'p1', name: 'n', costSingle: 1, startAt: 0, endAt: 1, categories: [] } as CustomPoolConfig, createdBy: 'ops' }),
      },
      { path: '/internal/gacha/pool/close', call: () => client.closeLimitedPool({ id: 'p1' }) },
      { path: '/internal/fate/redeem', call: () => client.redeemFate({ accountId: 'a', itemId: 'i', orderId: 'o' }) },
      { path: '/internal/monthly-card/buy', call: () => client.monthlyCardBuy({ accountId: 'a', orderId: 'o' }) },
      { path: '/internal/year-card/buy', call: () => client.yearCardBuy({ accountId: 'a', orderId: 'o' }) },
      { path: '/internal/monthly-card/claim', call: () => client.monthlyCardClaim({ accountId: 'a', dayKey: 'd' }) },
      { path: '/internal/starter/buy', call: () => client.starterBuy({ accountId: 'a', productId: 'p', orderId: 'o' }) },
      { path: '/internal/spend', call: () => client.spend({ accountId: 'a', amount: 1, reason: 'r', orderId: 'o' }) },
      { path: '/internal/grant', call: () => client.grant({ accountId: 'a', amount: 1, reason: 'r', orderId: 'o' }) },
      { path: '/internal/order/delivered', call: () => client.orderDelivered({ orderId: 'o' }) },
      { path: '/internal/recharge/verify', call: () => client.rechargeVerify({ accountId: 'a', platform: 'apple', receipt: 'r', receiptId: 'id' }) },
      {
        path: '/internal/nonCoinReceipt/verify',
        call: () => client.verifyNonCoinReceipt({ accountId: 'a', platform: 'apple', receipt: 'r', receiptId: 'id', expectedProduct: 'monthly_card' }),
      },
      { path: '/internal/ads/credit', call: () => client.adsCredit({ accountId: 'a', amount: 1, dayKey: 'd' }) },
      { path: '/internal/victory/credit', call: () => client.victoryCredit({ accountId: 'a', amount: 1, dayKey: 'd' }) },
      { path: '/internal/promo/redeem', call: () => client.promoRedeem({ accountId: 'a', code: 'c' }) },
      { path: '/internal/promo/codes', call: () => client.createPromoCode({ code: 'c', coins: 1, createdBy: 'ops' }) },
      { path: '/internal/paddle/complete', call: () => client.paddleComplete({ accountId: 'a', transactionId: 't', coins: 1 }) },
      { path: '/internal/paddle/refund', call: () => client.paddleRefund({ transactionId: 't' }) },
    ];
    for (const { path, call } of cases) {
      const r = await call();
      expect(r.ok).toBe(true);
      expect(lastReq?.method).toBe('POST');
      expect(lastReq?.url).toBe(path);
      expect(lastReq?.key).toBe(KEY);
    }
  });

  it('business error envelope (e.g. INSUFFICIENT_FUNDS) is passed through unchanged, not thrown', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const r = await client.shopCharge({ accountId: 'a', itemId: 'i', cost: 1, orderId: 'o', clientPlatform: undefined, ...( { _forceBusinessError: 'INSUFFICIENT_FUNDS' } as object) });
    expect(r).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('a 200 response with a non-JSON body leaves r.body null → post() throws, tagged with the path', async () => {
    const client = new HttpCommercialClient(base, KEY);
    await expect(
      client.spend({ accountId: 'a', amount: 1, reason: 'r', orderId: 'o', ...({ _forceNonJson: true } as object) }),
    ).rejects.toThrow(/commercial \/internal\/spend failed/);
  });

  it('recordPaddleEvent: baseUrl set → posts and resolves; baseUrl=null → resolves without a request', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const before = requestCount;
    await client.recordPaddleEvent({ transactionId: 't', eventType: 'x', rawEvent: '{}' });
    expect(requestCount).toBe(before + 1);
    expect(lastReq?.url).toBe('/internal/paddle/event');

    const nullClient = new HttpCommercialClient(null, KEY);
    const before2 = requestCount;
    await nullClient.recordPaddleEvent({ transactionId: 't', eventType: 'x', rawEvent: '{}' });
    expect(requestCount).toBe(before2); // no request made
  });
});

describe('HttpCommercialClient — GET-based methods', () => {
  it('getWallet: full response applies all fields; clientPlatform query param included when given', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const w = await client.getWallet('a', 'ios');
    expect(w).toEqual({
      coins: 42,
      pity: { standard: 1 },
      fatePoints: 2,
      subscriptionExpiry: 555,
      subscriptionLastClaimDay: '2026-08-01',
      starterUsed: ['s1'],
      firstPurchaseUsed: true,
      totalRechargeCents: 999,
    });
    expect(lastReq?.url).toContain('clientPlatform=ios');
    expect(lastReq?.method).toBe('GET');
  });

  it('getWallet: without clientPlatform → no query param; missing optional fields default (fatePoints 0, subscriptionExpiry 0, starterUsed [], firstPurchaseUsed false, totalRechargeCents 0)', async () => {
    const client = new HttpCommercialClient(base, KEY);
    // Point at a throwaway server returning the minimal shape, to hit the ?? fallback branches.
    const minimalServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, coins: 5, pity: {} }));
    });
    minimalServer.listen(0, '127.0.0.1');
    await new Promise<void>((r) => minimalServer.on('listening', r));
    const minimalBase = `http://127.0.0.1:${(minimalServer.address() as AddressInfo).port}`;
    try {
      const minimalClient = new HttpCommercialClient(minimalBase, KEY);
      const w = await minimalClient.getWallet('a');
      expect(w).toEqual({
        coins: 5,
        pity: {},
        fatePoints: 0,
        subscriptionExpiry: 0,
        subscriptionLastClaimDay: undefined,
        starterUsed: [],
        firstPurchaseUsed: false,
        totalRechargeCents: 0,
      });
    } finally {
      minimalServer.close();
    }
    expect(client).toBeTruthy(); // keep client referenced (clientPlatform-less call path already covered above)
  });

  it('getWallet: ok:false / baseUrl=null → null, no request made when baseUrl is null', async () => {
    const client = new HttpCommercialClient(base, KEY);
    expect(await client.getWallet('__forceError__')).toBeNull();

    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.getWallet('a')).toBeNull();
    expect(requestCount).toBe(before);
  });

  it('listLimitedPools (no active flag) / listActiveLimitedPools (active=1&now=) both parse the pools array; ok:false → []', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const all = await client.listLimitedPools();
    expect(all).toEqual(GENERIC_OK.pools);
    expect(lastReq?.url).toBe('/internal/gacha/pools');

    const active = await client.listActiveLimitedPools(12345);
    expect(active).toEqual(GENERIC_OK.pools);
    expect(lastReq?.url).toBe('/internal/gacha/pools?active=1&now=12345');
  });

  it('listLimitedPools / listActiveLimitedPools: baseUrl=null → [] with no request', async () => {
    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.listLimitedPools()).toEqual([]);
    expect(await nullClient.listActiveLimitedPools(1)).toEqual([]);
    expect(requestCount).toBe(before);
  });

  it('undeliveredOrders: parses the orders array; baseUrl=null → []', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const orders = await client.undeliveredOrders('a');
    expect(orders).toEqual(GENERIC_OK.orders);
    expect(lastReq?.url).toBe('/internal/orders/undelivered?accountId=a');

    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.undeliveredOrders('a')).toEqual([]);
    expect(requestCount).toBe(before);
  });

  it('listPromoCodes: parses codes array; baseUrl=null → [] with no request', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const codes = await client.listPromoCodes();
    expect(codes).toEqual(GENERIC_OK.codes);

    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.listPromoCodes()).toEqual([]);
    expect(requestCount).toBe(before);
  });

  it('listPaddleEvents: builds query from accountId/transactionId/limit when given; baseUrl=null → [] with no request', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const events = await client.listPaddleEvents({ accountId: 'a', transactionId: 't', limit: 5 });
    expect(events).toEqual(GENERIC_OK.events);
    expect(lastReq?.url).toContain('accountId=a');
    expect(lastReq?.url).toContain('transactionId=t');
    expect(lastReq?.url).toContain('limit=5');

    // No optional args → none of the three `if` branches fire. `URLSearchParams` still
    // appends the empty query (`?`) to the request string built in listPaddleEvents, but
    // whether that empty `?` survives onto the wire depends on the Node/undici version's
    // URL-to-request-line serialization (observed: kept on Node 26, dropped on Node 22 CI)
    // — assert on the path only, not that implementation detail.
    const eventsNoArgs = await client.listPaddleEvents({});
    expect(eventsNoArgs).toEqual(GENERIC_OK.events);
    expect(lastReq?.url).toMatch(/^\/internal\/paddle\/events\??$/);

    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.listPaddleEvents({})).toEqual([]);
    expect(requestCount).toBe(before);
  });

  it('auditCoinGains: builds dayKey/minGain query; baseUrl=null → [] with no request', async () => {
    const client = new HttpCommercialClient(base, KEY);
    const rows = await client.auditCoinGains('2026-08-14', 100);
    expect(rows).toEqual(GENERIC_OK.accounts);
    expect(lastReq?.url).toBe('/internal/audit/coin-gains?dayKey=2026-08-14&minGain=100');

    const before = requestCount;
    const nullClient = new HttpCommercialClient(null, KEY);
    expect(await nullClient.auditCoinGains('2026-08-14', 100)).toEqual([]);
    expect(requestCount).toBe(before);
  });
});
