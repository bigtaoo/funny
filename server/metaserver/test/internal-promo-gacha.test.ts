// Route-level tests for internal/promoGachaRoutes.ts (split out of internal.ts):
//   /admin/promo/codes, /admin/gacha/pools{,/custom,/close}, /admin/gacha/catalog.
// These routes are pure pass-throughs to CommercialClient — no cols/Mongo involved.
// Uses Fastify inject + a fake commercial client (in-memory promo/pool stores).
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Collections } from '@nw/shared';
import { registerPromoGachaRoutes } from '../src/internal/promoGachaRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';

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
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerPromoGachaRoutes(app, ctx);
  return { app, commercial };
}

describe('GET/POST /admin/promo/codes', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/admin/promo/codes' });
    expect(res.statusCode).toBe(401);
  });

  it('commercial unavailable → 503', async () => {
    const { app } = build(false);
    const res = await app.inject({ method: 'GET', url: '/admin/promo/codes', headers: authHeaders });
    expect(res.statusCode).toBe(503);
  });

  it('create + list round-trip', async () => {
    const { app } = build();
    const create = await app.inject({
      method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
      payload: { code: 'welcome10', coins: 100, createdBy: 'ops1' },
    });
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.payload)).toEqual({ ok: true, code: 'WELCOME10' }); // normalized uppercase

    const list = await app.inject({ method: 'GET', url: '/admin/promo/codes', headers: authHeaders });
    expect(JSON.parse(list.payload).codes).toHaveLength(1);
  });

  it('missing code/coins → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/promo/codes', headers: authHeaders, payload: { code: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate code → 409', async () => {
    const { app } = build();
    await app.inject({ method: 'POST', url: '/admin/promo/codes', headers: authHeaders, payload: { code: 'dup', coins: 10 } });
    const res = await app.inject({ method: 'POST', url: '/admin/promo/codes', headers: authHeaders, payload: { code: 'dup', coins: 10 } });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET/POST /admin/gacha/pools', () => {
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

  it('missing required fields or startAt>=endAt → 400', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools', headers: authHeaders,
      payload: { id: 'p1', name: 'Banner', featuredLegendary: 'hero1', startAt: 2000, endAt: 1000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('create + list round-trip', async () => {
    const { app } = build();
    const create = await app.inject({
      method: 'POST', url: '/admin/gacha/pools', headers: authHeaders,
      payload: { id: 'p1', name: 'Banner', featuredLegendary: 'hero1', startAt: 1000, endAt: 2000, createdBy: 'ops1' },
    });
    expect(create.statusCode).toBe(200);
    expect(JSON.parse(create.payload)).toEqual({ ok: true, id: 'p1' });

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
      method: 'POST', url: '/admin/gacha/pools', headers: authHeaders,
      payload: { id: 'p1', name: 'Banner', featuredLegendary: 'hero1', startAt: 1000, endAt: 2000 },
    });
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: { id: 'p1' } });
    expect(res.statusCode).toBe(200);
    expect(commercial.pools.get('p1')).toMatchObject({ closed: true });
  });
});
