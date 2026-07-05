// Promo code management (B-PROMO) + limited/custom gacha pool management (GACHA_DESIGN §2.2, §12).
// Both are ops-authored configs stored via commercial; these are admin-only endpoints (X-Internal-Key).
import type { FastifyInstance } from 'fastify';
import { createLogger, catalogByCategory, validateCustomPool, type CustomPoolConfig, type CustomPoolCategory } from '@nw/shared';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

export function registerPromoGachaRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { authed, commercial } = ctx;

  // ── Promo code management ──────────────────────────────────────────────
  // GET /admin/promo/codes — list all promo codes.
  app.get('/admin/promo/codes', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const codes = await commercial.listPromoCodes();
    return reply.send({ ok: true, codes });
  });
  // POST /admin/promo/codes — create a promo code. body = { code, coins, expiresAt?, totalLimit?, note?, createdBy }
  app.post('/admin/promo/codes', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const b = req.body as Record<string, unknown>;
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    const coins = typeof b.coins === 'number' ? b.coins : 0;
    if (!code || coins <= 0) return reply.code(400).send({ ok: false, error: 'code + coins required' });
    const r = await commercial.createPromoCode({
      code,
      coins,
      expiresAt: typeof b.expiresAt === 'number' ? b.expiresAt : undefined,
      totalLimit: typeof b.totalLimit === 'number' ? b.totalLimit : undefined,
      note: typeof b.note === 'string' ? b.note : undefined,
      createdBy: typeof b.createdBy === 'string' ? b.createdBy : 'unknown',
    });
    if (!r.ok) return reply.code(409).send({ ok: false, error: r.error });
    log.info('POST /admin/promo/codes', { code: r.code, coins });
    return reply.send({ ok: true, code: r.code });
  });

  // ── Limited gacha pool management ──────────────────────────────────────
  // GET /admin/gacha/pools — list all limited pool configs.
  app.get('/admin/gacha/pools', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const pools = await commercial.listLimitedPools();
    return reply.send({ ok: true, pools });
  });
  // POST /admin/gacha/pools — create/replace a limited pool. body = { id, name, featuredLegendary, startAt, endAt, fillerLegendaries?, createdBy }
  app.post('/admin/gacha/pools', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const b = req.body as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const featuredLegendary = typeof b.featuredLegendary === 'string' ? b.featuredLegendary.trim() : '';
    const startAt = typeof b.startAt === 'number' ? b.startAt : 0;
    const endAt = typeof b.endAt === 'number' ? b.endAt : 0;
    if (!id || !name || !featuredLegendary || !(endAt > startAt)) {
      return reply.code(400).send({ ok: false, error: 'id + name + featuredLegendary + startAt<endAt required' });
    }
    const r = await commercial.createLimitedPool({
      config: {
        id,
        name,
        featuredLegendary,
        startAt,
        endAt,
        ...(Array.isArray(b.fillerLegendaries)
          ? { fillerLegendaries: (b.fillerLegendaries as unknown[]).filter((x): x is string => typeof x === 'string') }
          : {}),
      },
      createdBy: typeof b.createdBy === 'string' ? b.createdBy : 'unknown',
    });
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error });
    log.info('POST /admin/gacha/pools', { id: r.id });
    return reply.send({ ok: true, id: r.id });
  });
  // GET /admin/gacha/catalog — the item catalogue (grouped by category) an operator may place in a custom pool (§12).
  app.get('/admin/gacha/catalog', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    return reply.send({ ok: true, catalog: catalogByCategory() });
  });
  // POST /admin/gacha/pools/custom — create/replace an ops-authored custom pool (GACHA_DESIGN §12).
  // body = { id, name, costSingle, costTen?, startAt, endAt, categories:[{category,weight,items:[{itemId,weight}]}], createdBy }
  app.post('/admin/gacha/pools/custom', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const b = req.body as Record<string, unknown>;
    const categories = Array.isArray(b.categories)
      ? (b.categories as Record<string, unknown>[]).map((c) => ({
          category: String(c.category ?? '') as CustomPoolCategory['category'],
          weight: typeof c.weight === 'number' ? c.weight : 0,
          items: Array.isArray(c.items)
            ? (c.items as Record<string, unknown>[]).map((it) => ({
                itemId: String(it.itemId ?? ''),
                weight: typeof it.weight === 'number' ? it.weight : 0,
              }))
            : [],
        }))
      : [];
    const config: CustomPoolConfig = {
      id: typeof b.id === 'string' ? b.id.trim() : '',
      name: typeof b.name === 'string' ? b.name.trim() : '',
      costSingle: typeof b.costSingle === 'number' ? b.costSingle : 0,
      ...(typeof b.costTen === 'number' ? { costTen: b.costTen } : {}),
      startAt: typeof b.startAt === 'number' ? b.startAt : 0,
      endAt: typeof b.endAt === 'number' ? b.endAt : 0,
      categories,
    };
    const invalid = validateCustomPool(config);
    if (invalid) return reply.code(400).send({ ok: false, error: invalid });
    const r = await commercial.createCustomPool({
      config,
      createdBy: typeof b.createdBy === 'string' ? b.createdBy : 'unknown',
    });
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error });
    log.info('POST /admin/gacha/pools/custom', { id: r.id });
    return reply.send({ ok: true, id: r.id });
  });
  // POST /admin/gacha/pools/close — close a limited or custom pool early. body = { id }
  app.post('/admin/gacha/pools/close', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const b = req.body as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    if (!id) return reply.code(400).send({ ok: false, error: 'id required' });
    const r = await commercial.closeLimitedPool({ id });
    if (!r.ok) return reply.code(404).send({ ok: false, error: r.error });
    log.info('POST /admin/gacha/pools/close', { id: r.id });
    return reply.send({ ok: true, id: r.id });
  });
}
