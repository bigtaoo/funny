// Route-level tests for internal/gachaPoolRoutes.ts (split out of internal.ts):
//   /admin/gacha/pools{,/custom,/close}, /admin/gacha/catalog.
// These routes are pure pass-throughs to CommercialClient — no cols/Mongo involved.
// Uses Fastify inject + a fake commercial client (in-memory pool store).
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Collections } from '@nw/shared';
import { registerGachaPoolRoutes } from '../src/internal/gachaPoolRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';
import { AccountCache } from '../src/accountCache';

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function build(commercialAvailable = true) {
  const commercial = fakeCommercial(commercialAvailable);
  const ctx: InternalCtx = {
    cols: {} as unknown as Collections,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial,
    socialsvc: new ThrowingSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null, // only the matchReport routes read InternalCtx.redis, and these suites don't register them
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerGachaPoolRoutes(app, ctx);
  return { app, commercial };
}

// POST /admin/gacha/pools (creating a *limited* pool, as opposed to /pools/custom below) was removed
// (comm-audit-internal-2026-07-28 P2): no caller anywhere in the codebase — admin's GachaPoolsClient
// never had a create-limited-pool method, only list/catalog/createCustom/close.
describe('GET /admin/gacha/pools', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/admin/gacha/pools' });
    expect(res.statusCode).toBe(401);
  });

  it('commercial unavailable → 503', async () => {
    const { app } = build(false);
    const res = await app.inject({ method: 'GET', url: '/admin/gacha/pools', headers: authHeaders });
    expect(res.statusCode).toBe(503);
  });

  it('lists pools present in the underlying store', async () => {
    const { app, commercial } = build();
    commercial.pools.set('p1', { id: 'p1', name: 'Banner', kind: 'limited' });
    const list = await app.inject({ method: 'GET', url: '/admin/gacha/pools', headers: authHeaders });
    expect(JSON.parse(list.payload).pools).toHaveLength(1);
  });
});

describe('GET /admin/gacha/catalog', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/admin/gacha/catalog' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the catalog grouped by category (does not require commercial)', async () => {
    const { app } = build(false); // commercial unavailable — catalog is local static data, must not 503
    const res = await app.inject({ method: 'GET', url: '/admin/gacha/catalog', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });
});

describe('POST /admin/gacha/pools/custom', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/custom', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('invalid config (bad id format) → 400', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: { id: 'bad id!', name: 'X', costSingle: 100, startAt: 1000, endAt: 2000, categories: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('valid config → creates the pool', async () => {
    const { app, commercial } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: {
        id: 'custom1', name: 'Custom Banner', costSingle: 100, startAt: 1000, endAt: 2000,
        categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
        createdBy: 'ops1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, id: 'custom1' });
    expect(commercial.pools.get('custom1')).toMatchObject({ kind: 'custom' });
  });
});

describe('POST /admin/gacha/pools/close', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/close', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing id → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('unknown pool → 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: { id: 'ghost' } });
    expect(res.statusCode).toBe(404);
  });

  it('closes an existing pool early', async () => {
    const { app, commercial } = build();
    await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: {
        id: 'p1', name: 'Banner', costSingle: 100, startAt: 1000, endAt: 2000,
        categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
      },
    });
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: { id: 'p1' } });
    expect(res.statusCode).toBe(200);
    expect(commercial.pools.get('p1')).toMatchObject({ closed: true });
  });
});
