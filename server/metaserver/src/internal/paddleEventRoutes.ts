// Paddle webhook event log (support/CS lookup — COMMERCIAL_DESIGN §10.4). Admin-only (X-Internal-Key),
// proxies to commercial's paddleEvents collection. Recording happens in paddle.ts; this only exposes read access.
import type { FastifyInstance } from 'fastify';
import type { InternalCtx } from './context.js';

export function registerPaddleEventRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { authed, commercial } = ctx;

  // GET /admin/paddle/events?accountId=&transactionId=&limit= — list logged Paddle events.
  app.get('/admin/paddle/events', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!commercial.available) return reply.code(503).send({ ok: false, error: 'commercial unavailable' });
    const q = req.query as Record<string, string | undefined>;
    const events = await commercial.listPaddleEvents({
      accountId: q.accountId || undefined,
      transactionId: q.transactionId || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return reply.send({ ok: true, events });
  });
}
