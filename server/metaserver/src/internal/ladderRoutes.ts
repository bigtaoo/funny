// Ladder season roll/query, leaderboard, and title grants (S10/S11).
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@nw/shared';
import { getCurrentSeason, rollSeason } from '../ladderSeason.js';
import { grantTitleToPlayer } from '../titles.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

export function registerLadderRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now, commercial, socialsvc } = ctx;

  // ── POST /admin/ladder/season/roll ────────────────────────────────────────
  // admin (ops backend) manually closes the current season and opens a new one (S11-SE-3, SEASON_DESIGN §3.1; closed-loop L2-1).
  // Before rolling, eagerly settles all participants from the previous season (rank reward mail + season title + snapshot, idempotent).
  // CAS idempotent: concurrent or accidental re-entry returns the current season without advancing again.
  app.post('/admin/ladder/season/roll', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    try {
      const season = await rollSeason(cols, commercial, socialsvc, now());
      log.info('POST /admin/ladder/season/roll', { seasonNo: season.seasonNo });
      return reply.send({ ok: true, season });
    } catch (e) {
      log.error('rollSeason failed', { err: (e as Error).message });
      return reply.code(500).send({ ok: false, error: 'roll failed' });
    }
  });

  // ── GET /internal/ladder/season/current ──────────────────────────────────────────
  // ops backend fetches current ladder season info (used to highlight when endAt is approaching).
  app.get('/internal/ladder/season/current', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const season = await getCurrentSeason(cols, now());
    return reply.send({ ok: true, season });
  });

  // POST /internal/title/grant  { accountId, titleId }
  //   → Grant title (idempotent, called from SLG/worldsvc season settlement). Authenticated via X-Internal-Key.
  app.post('/internal/title/grant', async (req, reply) => {
    if (!authed(req.headers)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, titleId } = req.body as { accountId?: string; titleId?: string };
    if (!accountId || !titleId) {
      return reply.code(400).send({ ok: false, error: 'accountId + titleId required' });
    }
    try {
      await grantTitleToPlayer(cols, accountId, titleId, now());
      return reply.send({ ok: true });
    } catch (e) {
      log.error('/internal/title/grant failed', { accountId, titleId, err: (e as Error).message });
      return reply.code(500).send({ ok: false, error: 'grant failed' });
    }
  });
}
