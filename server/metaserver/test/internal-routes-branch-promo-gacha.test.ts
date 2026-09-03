// Branch-coverage backfill for internal/promoGachaRoutes.ts — the input shapes and refusal paths
// internal-promo-gacha.test.ts never sends. Three families:
//   (a) the degraded-commercial side of every *write* endpoint (must fail loudly with 503, never
//       silently accept an ops-authored config that was not persisted anywhere),
//   (b) the absent/malformed-field fallbacks: these handlers forward the parsed JSON body verbatim, so
//       every `typeof x === '…' ? x : <default>` is what an operator's typo actually turns into,
//   (c) the "commercial refused the write" mapping (createCustomPool → 400 with the store's own reason).
// Registers the route module from ../src (never ../dist — v8 coverage cannot attribute dist/*.js to src/*.ts).
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Collections } from '@nw/shared';
import type { CommercialClient } from '../src/commercialClient.js';
import { registerPromoGachaRoutes } from '../src/internal/promoGachaRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';
import { AccountCache } from '../src/accountCache.js';

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function build(opts: { available?: boolean; overrides?: Partial<CommercialClient> } = {}) {
  const commercial = fakeCommercial(opts.available ?? true);
  Object.assign(commercial, opts.overrides ?? {});
  const ctx: InternalCtx = {
    cols: {} as unknown as Collections,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial,
    socialsvc: new ThrowingSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerPromoGachaRoutes(app, ctx);
  return { app, commercial };
}

const customPool = (extra: Record<string, unknown> = {}) => ({
  id: 'custom1',
  name: 'Custom Banner',
  costSingle: 100,
  startAt: 1000,
  endAt: 2000,
  categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
  ...extra,
});

describe('POST /admin/promo/codes — refusal paths', () => {
  it('no key → 401 (the write endpoint, not just the listing one)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/promo/codes', payload: { code: 'x', coins: 1 } });
    expect(res.statusCode).toBe(401);
  });

  // Degraded commercial must refuse the *write* loudly: a 503 tells the operator the code was not
  // created, where a silent 200 would leave them believing a promo code exists that nobody can redeem.
  it('commercial unavailable → 503 and nothing is stored', async () => {
    const { app, commercial } = build({ available: false });
    const res = await app.inject({
      method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
      payload: { code: 'welcome10', coins: 100 },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'commercial unavailable' });
    expect(commercial.promoCodes.size).toBe(0);
  });

  // `typeof b.code === 'string' ? … : ''` — a non-string `code` (an operator sending a bare number, or a
  // form posting JSON null) must land in the same 400 as an omitted one, not reach commercial as "123".
  it('non-string code → 400, never forwarded to commercial', async () => {
    const { app, commercial } = build();
    for (const code of [123, null, { v: 'x' }, ['x']]) {
      const res = await app.inject({
        method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
        payload: { code, coins: 100 },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'code + coins required' });
    }
    expect(commercial.promoCodes.size).toBe(0);
  });

  it('whitespace-only code trims to empty → 400', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
      payload: { code: '   ', coins: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-positive / non-number coins → 400', async () => {
    const { app } = build();
    for (const coins of [0, -5, '100']) {
      const res = await app.inject({
        method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
        payload: { code: 'promo', coins },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /admin/promo/codes — optional fields are forwarded when present', () => {
  // expiresAt/totalLimit/note are all `typeof … === '…' ? … : undefined`; the existing suite only ever
  // omits them, so the *present* side (the one an ops console actually posts for a limited-run code)
  // was never exercised. An expiry/limit silently dropped here is a promo code that never expires.
  it('numeric expiresAt + totalLimit and a string note reach commercial verbatim', async () => {
    const { app, commercial } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
      payload: {
        code: 'launch', coins: 500, expiresAt: 1893456000000, totalLimit: 1000,
        note: 'launch week, marketing request #42', createdBy: 'ops1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(commercial.promoCodes.get('LAUNCH')).toMatchObject({
      coins: 500, expiresAt: 1893456000000, totalLimit: 1000,
      note: 'launch week, marketing request #42', createdBy: 'ops1',
    });
  });

  it('wrong-typed optional fields are dropped (undefined), not forwarded as-is', async () => {
    const { app, commercial } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/promo/codes', headers: authHeaders,
      payload: { code: 'sloppy', coins: 10, expiresAt: '2026-01-01', totalLimit: '50', note: 7, createdBy: 9 },
    });
    expect(res.statusCode).toBe(200);
    const stored = commercial.promoCodes.get('SLOPPY') as Record<string, unknown>;
    expect(stored.expiresAt).toBeUndefined();
    expect(stored.totalLimit).toBeUndefined();
    expect(stored.note).toBeUndefined();
    expect(stored.createdBy).toBe('unknown'); // non-string createdBy → attributed to 'unknown', not 9
  });
});

describe('POST /admin/gacha/pools/custom — refusal paths', () => {
  it('commercial unavailable → 503 and no pool is stored', async () => {
    const { app, commercial } = build({ available: false });
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders, payload: customPool(),
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'commercial unavailable' });
    expect(commercial.pools.size).toBe(0);
  });

  // One request exercising every top-level `typeof … ? … : <default>` fallback at once: each malformed
  // field collapses to the empty/zero default *before* validateCustomPool runs, so the operator sees a
  // validation message about the config rather than a 500 from String.prototype.trim on a number.
  it('every top-level field wrong-typed (and categories not an array) → 400 validation message', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: { id: 123, name: 456, costSingle: '100', startAt: '1000', endAt: '2000', categories: 'skin' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('invalid pool id (use letters, digits, underscore)');
  });

  it('valid id but wrong-typed name/costSingle/startAt/endAt → reported in validation order', async () => {
    const { app } = build();
    const noName = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: { id: 'p1', name: 42, costSingle: 100, startAt: 1, endAt: 2, categories: [] },
    });
    expect(JSON.parse(noName.payload).error).toBe('name is required');

    const badCost = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: { id: 'p1', name: 'X', costSingle: '100', startAt: 1, endAt: 2, categories: [] },
    });
    expect(JSON.parse(badCost.payload).error).toBe('costSingle must be > 0');

    const badWindow = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: { id: 'p1', name: 'X', costSingle: 100, startAt: '1', endAt: '2', categories: [] },
    });
    // startAt/endAt both collapse to 0 → endAt is not after startAt.
    expect(JSON.parse(badWindow.payload).error).toBe('endAt must be after startAt');
  });

  // The per-category / per-item normalisation (`String(c.category ?? '')`, `typeof it.weight === 'number'
  // ? … : 0`, `Array.isArray(c.items) ? … : []`): an ops console row missing a field must surface as a
  // named validation error the operator can act on, never as a pool whose weights silently became 0.
  it.each([
    ['category key omitted', [{ weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }], 'unknown category: '],
    ['category weight not a number', [{ category: 'skin', weight: 'lots', items: [{ itemId: 'skin_e1', weight: 1 }] }], 'category skin: weight must be > 0'],
    ['items not an array', [{ category: 'skin', weight: 1, items: 'skin_e1' }], 'category skin: needs at least one item'],
    ['itemId omitted', [{ category: 'skin', weight: 1, items: [{ weight: 1 }] }], 'unknown item: '],
    ['item weight not a number', [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: '1' }] }], 'item skin_e1: weight must be > 0'],
  ])('malformed categories (%s) → 400 "%s"', async (_label, categories, expected) => {
    const { app, commercial } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: customPool({ categories }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe(expected);
    expect(commercial.pools.size).toBe(0);
  });

  it('categories omitted entirely → 400 "at least one category is required"', async () => {
    const { app } = build();
    const payload = customPool();
    delete (payload as Record<string, unknown>).categories;
    const res = await app.inject({ method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders, payload });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('at least one category is required');
  });

  // `...(typeof b.costTen === 'number' ? { costTen } : {})` — the present side. A ten-pull discount that
  // failed to reach the stored config would silently charge 10x the single price.
  it('numeric costTen is included in the stored config', async () => {
    const { app, commercial } = build();
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: customPool({ costTen: 900 }),
    });
    expect(res.statusCode).toBe(200);
    expect(commercial.pools.get('custom1')).toMatchObject({ costTen: 900, costSingle: 100 });
  });

  it('non-number costTen is omitted rather than stored as a string', async () => {
    const { app, commercial } = build();
    await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders,
      payload: customPool({ costTen: '900' }),
    });
    expect(commercial.pools.get('custom1')).not.toHaveProperty('costTen');
  });

  // The config validated locally but commercial itself refused (e.g. the id is already taken there):
  // the operator must see commercial's own reason, mapped to 400 — not a generic 500.
  it('commercial refuses the write → 400 carrying its error code', async () => {
    const { app } = build({
      overrides: {
        createCustomPool: async () => ({ ok: false as const, error: 'POOL_ID_TAKEN' }),
      } as unknown as Partial<CommercialClient>,
    });
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/custom', headers: authHeaders, payload: customPool(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'POOL_ID_TAKEN' });
  });
});

describe('POST /admin/gacha/pools/close — degraded commercial', () => {
  it('commercial unavailable → 503 (closing a live pool must not report success it cannot deliver)', async () => {
    const { app } = build({ available: false });
    const res = await app.inject({
      method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: { id: 'p1' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'commercial unavailable' });
  });

  it('non-string / whitespace id → 400', async () => {
    const { app } = build();
    for (const id of [123, '   ', null]) {
      const res = await app.inject({
        method: 'POST', url: '/admin/gacha/pools/close', headers: authHeaders, payload: { id },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'id required' });
    }
  });
});
