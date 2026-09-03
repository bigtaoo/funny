// httpApi.ts branch-coverage gap-fill (2026-09-03 branch-gate pass), continuing httpApi-routes.test.ts.
//
// Same root cause as the rest of this pass: auction.e2e.test.ts calls `AuctionService` directly (so the
// HTTP parsing/validation layer is bypassed entirely) and auction-fulllink.e2e.test.ts drives only the
// well-formed requests a real client sends. What was left unexecuted:
//   • the whole `/internal/audit/anomalies` ops route (the G7 anti-RMT pull — admin's counterpart of it
//     is tested on the admin side, but nothing ever called this end);
//   • `designatedBuyerId` arriving on a create request (the friend-only listing path);
//   • a bid whose `amount` is not a number at all;
//   • the HTTP-status fallback for an ErrorCode that shared's mapping table has no entry for;
//   • a request with no Host header (HTTP/1.0), which the URL parse has a fallback authority for;
//   • a thrown non-Error reaching the catch-all's log line.
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { ErrorCode, signToken, SlgError } from '@nw/shared';
import { startHttpApi } from '../src/httpApi';
import type { AuctionService } from '../src/auctionService';
import type { AddressInfo } from 'net';

const JWT_SECRET = 'test-secret';
const INTERNAL_KEY = 'test-internal-key';
const ACC = 'acc-1';

let server: ReturnType<typeof startHttpApi> | undefined;

function startServer(auctionSvc: Partial<AuctionService>): Promise<{ base: string; port: number }> {
  server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: JWT_SECRET, internalKey: INTERNAL_KEY }, auctionSvc as unknown as AuctionService);
  return new Promise((resolve) => {
    server!.once('listening', () => {
      const { port } = server!.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, port });
    });
  });
}
afterEach(() => { server?.close(); server = undefined; });

const auth = () => ({ authorization: `Bearer ${signToken(ACC, { secret: JWT_SECRET })}` });

describe('GET /internal/audit/anomalies (G7 anti-RMT pull, X-Internal-Key)', () => {
  it('valid key: forwards a numeric windowSec to scanAnomalies', async () => {
    let received: unknown = 'unset';
    const { base } = await startServer({ scanAnomalies: async (w) => { received = w; return []; } });
    const res = await fetch(`${base}/internal/audit/anomalies?windowSec=3600`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: [] });
    expect(received).toBe(3600);
  });

  it('a non-numeric windowSec is dropped so the service applies its own default window', async () => {
    let received: unknown = 'unset';
    const { base } = await startServer({ scanAnomalies: async (w) => { received = w; return []; } });
    await fetch(`${base}/internal/audit/anomalies?windowSec=last-week`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(received).toBeUndefined();
  });

  it('missing X-Internal-Key -> 401, scanAnomalies never called', async () => {
    const { base } = await startServer({ scanAnomalies: async () => { throw new Error('must not be called'); } });
    const res = await fetch(`${base}/internal/audit/anomalies`);
    expect(res.status).toBe(401);
  });

  it('non-GET method -> 404, never reaches the service', async () => {
    const { base } = await startServer({ scanAnomalies: async () => { throw new Error('must not be called'); } });
    const res = await fetch(`${base}/internal/audit/anomalies`, { method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(404);
  });
});

describe('POST /auction/create input forwarding', () => {
  it('a designatedBuyerId in the body reaches createAuction (the friend-only listing path)', async () => {
    let received: { designatedBuyerId?: string } | undefined;
    const { base } = await startServer({ createAuction: async (p) => { received = p; return {} as never; } });
    const res = await fetch(`${base}/auction/create`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'scrap' }, qty: 1, durationSec: 3600, price: 10, designatedBuyerId: 'friend-1' }),
    });
    expect(res.status).toBe(200);
    expect(received?.designatedBuyerId).toBe('friend-1');
  });

  it('a non-string designatedBuyerId is dropped rather than forwarded as a number', async () => {
    let received: { designatedBuyerId?: string } | undefined;
    const { base } = await startServer({ createAuction: async (p) => { received = p; return {} as never; } });
    await fetch(`${base}/auction/create`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'material', item: { material: 'scrap' }, qty: 1, durationSec: 3600, price: 10, designatedBuyerId: 7 }),
    });
    expect(received?.designatedBuyerId).toBeUndefined();
  });
});

describe('POST /auction/:id/bid input validation', () => {
  it.each([
    ['a missing amount', {}],
    ['a non-numeric amount', { amount: 'lots' }],
  ])('%s -> 400, placeBid never called', async (_label, body) => {
    const { base } = await startServer({ placeBid: async () => { throw new Error('must not be called'); } });
    const res = await fetch(`${base}/auction/a%3Aseller-1%3A1%3A1/bid`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('error mapping fallbacks', () => {
  it('an ErrorCode with no entry in shared`s HTTP mapping table answers 400, not undefined', async () => {
    // ERROR_HTTP_STATUS lives in @nw/shared and does not cover every ErrorCode; a missing entry must
    // degrade to a plain client error rather than producing an invalid status.
    const { base } = await startServer({ listAuctions: async () => { throw new SlgError('ACCOUNT_DELETED', 'account is gone'); } });
    const res = await fetch(`${base}/auction/list`, { headers: auth() });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
  });

  it('a thrown non-Error still logs and answers a sanitized 500', async () => {
    const { base } = await startServer({ listAuctions: async () => { throw 'a bare string rejection'; } });
    const res = await fetch(`${base}/auction/list`, { headers: auth() });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: { message: string } }).error.message).toBe('internal server error');
  });
});

describe('requests that omit the Host header (HTTP/1.0 clients, health probes)', () => {
  it('still route, using the fallback authority for the URL parse', async () => {
    // `fetch` always sends Host, so this has to go out over a raw socket. The fallback exists because
    // `new URL(path, ...)` needs an authority and a HTTP/1.0 request is not required to supply one.
    const { port } = await startServer({});
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /health HTTP/1.0\r\n\r\n'));
      let buf = '';
      sock.on('data', (c) => { buf += c; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    expect(raw).toContain('200');
    expect(raw).toContain('"service":"auctionsvc"');
  });

  it('an unknown path with no Host header falls through to the 404, not to a URL parse failure', async () => {
    const { port } = await startServer({});
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /nope HTTP/1.0\r\n\r\n'));
      let buf = '';
      sock.on('data', (c) => { buf += c; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    expect(raw).toContain('401'); // no bearer token either — the JWT gate is what answers first
  });
});
