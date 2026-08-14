// Unit coverage for src/internal/paddleEventRoutes.ts (registerPaddleEventRoutes), no Mongo needed —
// mirrors test/internal.test.ts's convention of driving one internal/* route module directly against a
// plain Fastify() instance + a hand-built ctx, rather than the full buildApp.
//
// Why this file exists: this route is registered as part of registerInternalRoutes (internal.ts calls
// registerPaddleEventRoutes(app, ctx)), and test/internal.test.ts already imports registerInternalRoutes
// from '../src/internal.js' (src, not dist) — but no existing test file (paddle-routes.e2e.test.ts,
// paddle.test.ts, paddle-unit.test.ts, internal.test.ts) actually sends a request to GET
// /admin/paddle/events, so the handler body itself (unauthorized/unavailable/query-parsing branches)
// has never been exercised — only the top-level `registerPaddleEventRoutes(app, ctx)` registration call
// runs (accounting for the module's partial 35.7% baseline).
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPaddleEventRoutes } from '../src/internal/paddleEventRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import type { CommercialClient, PaddleEventView } from '../src/commercialClient.js';

const KEY = 'test-internal-key';

interface ListCall { accountId?: string; transactionId?: string; limit?: number }

function fakeCommercial(available: boolean, events: PaddleEventView[] = []): CommercialClient & { calls: ListCall[] } {
  const calls: ListCall[] = [];
  return {
    available,
    calls,
    async listPaddleEvents(args: ListCall) {
      calls.push(args);
      return events;
    },
  } as unknown as CommercialClient & { calls: ListCall[] };
}

function buildTestApp(ctxOverrides: Partial<InternalCtx> = {}): { app: FastifyInstance; ctx: InternalCtx } {
  const app = Fastify({ logger: false });
  const ctx: InternalCtx = {
    cols: {} as InternalCtx['cols'],
    now: () => Date.now(),
    gateway: {} as InternalCtx['gateway'],
    commercial: fakeCommercial(true),
    socialsvc: {} as InternalCtx['socialsvc'],
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: {} as InternalCtx['accountCache'],
    ...ctxOverrides,
  };
  registerPaddleEventRoutes(app, ctx);
  return { app, ctx };
}

describe('registerPaddleEventRoutes: GET /admin/paddle/events', () => {
  it('unauthorized (missing/wrong X-Internal-Key) -> 401', async () => {
    const { app } = buildTestApp();
    const r = await app.inject({ method: 'GET', url: '/admin/paddle/events' });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toEqual({ ok: false, error: 'unauthorized' });
    await app.close();
  });

  it('commercial unavailable -> 503', async () => {
    const { app } = buildTestApp({ commercial: fakeCommercial(false) });
    const r = await app.inject({ method: 'GET', url: '/admin/paddle/events', headers: { 'x-internal-key': KEY } });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toEqual({ ok: false, error: 'commercial unavailable' });
    await app.close();
  });

  it('happy path: no query params -> passes undefined for accountId/transactionId/limit, returns events', async () => {
    const events: PaddleEventView[] = [
      { transactionId: 'tx1', eventType: 'transaction.completed', status: 'completed', accountId: 'acc1', rawEvent: '{}', ts: 1000 },
    ];
    const comm = fakeCommercial(true, events);
    const { app } = buildTestApp({ commercial: comm });
    const r = await app.inject({ method: 'GET', url: '/admin/paddle/events', headers: { 'x-internal-key': KEY } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ ok: true, events });
    expect(comm.calls).toEqual([{ accountId: undefined, transactionId: undefined, limit: undefined }]);
    await app.close();
  });

  it('query params (accountId/transactionId/limit) are forwarded to commercial.listPaddleEvents, limit coerced to a Number', async () => {
    const comm = fakeCommercial(true, []);
    const { app } = buildTestApp({ commercial: comm });
    const r = await app.inject({
      method: 'GET',
      url: '/admin/paddle/events?accountId=acc42&transactionId=tx99&limit=5',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    expect(comm.calls).toEqual([{ accountId: 'acc42', transactionId: 'tx99', limit: 5 }]);
    await app.close();
  });

  it('empty-string query params fall back to undefined (falsy-string guard, not passed through as "")', async () => {
    const comm = fakeCommercial(true, []);
    const { app } = buildTestApp({ commercial: comm });
    const r = await app.inject({
      method: 'GET',
      url: '/admin/paddle/events?accountId=&transactionId=',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    expect(comm.calls).toEqual([{ accountId: undefined, transactionId: undefined, limit: undefined }]);
    await app.close();
  });
});
