// httpApi.ts route coverage gap-fill: auction.e2e.test.ts (AuctionService directly) and
// auction-fulllink.e2e.test.ts (real HTTP, but only the happy paths a real client actually drives)
// between them never exercise: the /internal/audit/listings and /internal/audit/settlements ops routes
// (X-Internal-Key gate + query
// filter wiring — the auctionsvc-side counterpart of admin's slgAudit.slgQueryAuctionListings), GET
// /auction/refprice, /auction/create's own input-validation 400s (itemType/item/qty/durationSec
// required; price required for a fixed sale; startPrice required for an auction sale), the generic
// unknown-route 404, or a malformed-JSON request body. Same no-Mongo-needed `Partial<AuctionService>`
// mock pattern as httpApi-error-sanitization.test.ts — these are all httpApi.ts's own routing/
// validation logic, not AuctionService's.
import { describe, it, expect, afterEach } from 'vitest';
import { signToken, loadInternalAuth } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { AuctionService } from '../src/auctionService';
import type { AddressInfo } from 'net';

const JWT_SECRET = 'test-secret';
const INTERNAL_KEY = 'test-internal-key';
const ACC = 'acc-1';

let server: ReturnType<typeof startHttpApi> | undefined;

function startServer(auctionSvc: Partial<AuctionService>): Promise<string> {
  server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: JWT_SECRET, internalKey: INTERNAL_KEY }, auctionSvc as unknown as AuctionService);
  return new Promise((resolve) => {
    server!.once('listening', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}
afterEach(() => { server?.close(); server = undefined; });

function auth(): Record<string, string> {
  return { authorization: `Bearer ${signToken(ACC, { secret: JWT_SECRET })}` };
}

describe('GET /internal/audit/listings (ops audit pull, X-Internal-Key)', () => {
  it('valid key: forwards sellerId/itemType/status/itemName/limit query filters to queryListings', async () => {
    let received: unknown;
    const base = await startServer({
      queryListings: async (filter) => { received = filter; return []; },
    });
    const res = await fetch(`${base}/internal/audit/listings?sellerId=acc-2&itemType=equipment&status=open&itemName=wp&limit=25`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: [] });
    expect(received).toEqual({ sellerId: 'acc-2', itemType: 'equipment', status: 'open', itemName: 'wp', limit: 25 });
  });

  it('no filters -> all-undefined + default limit 50', async () => {
    let received: unknown;
    const base = await startServer({ queryListings: async (filter) => { received = filter; return []; } });
    await fetch(`${base}/internal/audit/listings`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(received).toEqual({ sellerId: undefined, itemType: undefined, status: undefined, itemName: undefined, limit: 50 });
  });

  it('missing X-Internal-Key -> 401, queryListings never called', async () => {
    const queryListings = async () => { throw new Error('must not be called'); };
    const base = await startServer({ queryListings });
    const res = await fetch(`${base}/internal/audit/listings`);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('wrong X-Internal-Key -> 401', async () => {
    const base = await startServer({ queryListings: async () => [] });
    const res = await fetch(`${base}/internal/audit/listings`, { headers: { 'x-internal-key': 'not-the-key' } });
    expect(res.status).toBe(401);
  });

  it('non-GET method -> 404 (not found), never reaches the service', async () => {
    const queryListings = async () => { throw new Error('must not be called'); };
    const base = await startServer({ queryListings });
    const res = await fetch(`${base}/internal/audit/listings`, { method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(404);
  });
});

describe('GET /internal/audit/settlements (owed-settlement lookup, X-Internal-Key)', () => {
  it('valid key: forwards auctionId/accountId/minAttempts/limit to listSettlementDebts', async () => {
    let received: unknown;
    const base = await startServer({
      listSettlementDebts: async (filter) => { received = filter; return []; },
    });
    const res = await fetch(`${base}/internal/audit/settlements?auctionId=a:s:1:1&accountId=acc-2&minAttempts=10&limit=25`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: [] });
    expect(received).toEqual({ auctionId: 'a:s:1:1', accountId: 'acc-2', minAttempts: 10, limit: 25 });
  });

  it('no filters -> nothing but the default limit, i.e. "everything still owed"', async () => {
    // The unfiltered call is the useful one here (unlike the listing lookup, whose unbounded query the ops
    // page refuses): an unfinished settlement is rare by nature, so the whole set is the interesting answer.
    let received: unknown;
    const base = await startServer({ listSettlementDebts: async (filter) => { received = filter; return []; } });
    await fetch(`${base}/internal/audit/settlements`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(received).toEqual({ limit: 50 });
  });

  it('omits a non-numeric minAttempts rather than forwarding NaN', async () => {
    let received: unknown;
    const base = await startServer({ listSettlementDebts: async (filter) => { received = filter; return []; } });
    await fetch(`${base}/internal/audit/settlements?minAttempts=abc`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(received).toEqual({ limit: 50 });
  });

  it('forwards an explicit minAttempts=0', async () => {
    let received: unknown;
    const base = await startServer({ listSettlementDebts: async (filter) => { received = filter; return []; } });
    await fetch(`${base}/internal/audit/settlements?minAttempts=0`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(received).toEqual({ minAttempts: 0, limit: 50 });
  });

  it('missing X-Internal-Key -> 401, listSettlementDebts never called', async () => {
    const listSettlementDebts = async () => { throw new Error('must not be called'); };
    const base = await startServer({ listSettlementDebts });
    const res = await fetch(`${base}/internal/audit/settlements`);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('wrong X-Internal-Key -> 401', async () => {
    const base = await startServer({ listSettlementDebts: async () => [] });
    const res = await fetch(`${base}/internal/audit/settlements`, { headers: { 'x-internal-key': 'not-the-key' } });
    expect(res.status).toBe(401);
  });

  it('non-GET method -> 404, never reaches the service — this route is read-only by design', async () => {
    // There is deliberately no "retry now": auctionsvc's sweep already retries every owed hand-over on its
    // own backoff, so a manual poke would only race it.
    const listSettlementDebts = async () => { throw new Error('must not be called'); };
    const base = await startServer({ listSettlementDebts });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/internal/audit/settlements`, { method, headers: { 'x-internal-key': INTERNAL_KEY } });
      expect(res.status, method).toBe(404);
    }
  });
});

describe('GET /auction/refprice', () => {
  it('forwards the category query param to getRefBand and returns its result', async () => {
    let receivedCategory: string | null | undefined;
    const base = await startServer({
      getRefBand: async (category) => { receivedCategory = category; return { ref: 100, floor: 80, ceil: 120 }; },
    });
    const res = await fetch(`${base}/auction/refprice?category=material:paper`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ref: 100, floor: 80, ceil: 120 } });
    expect(receivedCategory).toBe('material:paper');
  });

  it('no category query param -> passes null through', async () => {
    let receivedCategory: string | null | undefined = 'unset';
    const base = await startServer({ getRefBand: async (category) => { receivedCategory = category; return null; } });
    const res = await fetch(`${base}/auction/refprice`, { headers: auth() });
    expect(await res.json()).toEqual({ ok: true, data: null });
    expect(receivedCategory).toBeNull();
  });
});

describe('POST /auction/create validation', () => {
  const createAuction = async () => { throw new Error('must not be called once validation fails'); };

  it('missing itemType -> 400, createAuction never called', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ item: { material: 'paper' }, qty: 1, durationSec: 3600, price: 10 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('missing/non-object item -> 400', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', qty: 1, durationSec: 3600, price: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('non-integer qty -> 400', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'paper' }, qty: 1.5, durationSec: 3600, price: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('non-finite durationSec -> 400', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'paper' }, qty: 1, durationSec: 'soon', price: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('fixed sale (default) missing price -> 400', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'paper' }, qty: 1, durationSec: 3600 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/price required for fixed sale/);
  });

  it('auction sale missing startPrice -> 400', async () => {
    const base = await startServer({ createAuction });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'paper' }, qty: 1, durationSec: 3600, saleMode: 'auction' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/startPrice required for auction sale/);
  });

  it('a fully valid fixed-sale payload passes validation through to createAuction', async () => {
    let received: unknown;
    const base = await startServer({ createAuction: async (input) => { received = input; return {} as never; } });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'paper' }, qty: 3, durationSec: 3600, price: 10 }),
    });
    expect(res.status).toBe(200);
    expect(received).toMatchObject({ sellerId: ACC, itemType: 'material', qty: 3, durationSec: 3600, saleMode: 'fixed', price: 10 });
  });
});

describe('httpApi.ts fallthrough branches', () => {
  it('an unrecognized path/method combination -> 404 not found', async () => {
    const base = await startServer({});
    const res = await fetch(`${base}/auction/does-not-exist`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it('a malformed JSON request body -> 500 (readJson\'s own JSON.parse failure, sanitized like any other unhandled error)', async () => {
    const base = await startServer({});
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: { message: string } }).error.message).toBe('internal server error');
  });
});

describe('loadInternalAuth sanity (used by the /internal/audit/listings gate above)', () => {
  it('accepts the configured key, rejects anything else', () => {
    const auth2 = loadInternalAuth(INTERNAL_KEY);
    expect(auth2.verify({ 'x-internal-key': INTERNAL_KEY }).ok).toBe(true);
    expect(auth2.verify({ 'x-internal-key': 'wrong' }).ok).toBe(false);
  });
});
