// Consent-free server retention report for the admin backend (ops analytics page). See ../retentionReport.ts
// for what is counted, what is excluded and why no consent is needed.
import type { FastifyInstance } from 'fastify';
import { clampRetentionDays, retentionReport } from '../retentionReport.js';
import type { InternalCtx } from './context.js';

export function registerRetentionRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now } = ctx;

  // ── GET /internal/retention?days=N (N default 30, 1..90) ─────────────────────
  // Signup cohorts of the last N UTC days, newest first.
  app.get('/internal/retention', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const days = clampRetentionDays((req.query as { days?: string }).days);
    const cohorts = await retentionReport(cols, now(), days);
    return reply.send({ ok: true, days, cohorts });
  });
}
