// Split from matchReport.ts (2026-08-10, independent function module range 6, part 6/6b).
// The three lightweight routes that ride alongside /internal/match/report: graceful-shutdown cache
// clear, the admin hash-mismatch list (C3), and the BALANCE pvp-card-stats aggregate (P1).
import type { FastifyInstance } from 'fastify';
import { clearActiveMatch, createLogger } from '@nw/shared';
import type { InternalCtx } from '../context.js';

const log = createLogger('meta:internal');

export function registerMiscMatchReportRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now, redis } = ctx;

  // ── POST /internal/match/abandon ──────────────────────────────────────────
  // gameserver graceful shutdown (login-reconnect-prompt, 2026-07-28): rooms still in progress at
  // shutdown time are wiped from memory with no end-of-match report, so the clearActiveMatch call
  // above (which only fires from /internal/match/report) never runs for them. Without this, a
  // deploy mid-match leaves the Redis flag lingering (bounded only by its 1h TTL) and the next
  // login offers to "resume" into a room that no longer exists. No settlement/archival here —
  // purely a cache clear, so unlike /internal/match/report there is nothing to reconcile/dedupe.
  app.post('/internal/match/abandon', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as { accountIds?: unknown };
    const accountIds = Array.isArray(body?.accountIds)
      ? body.accountIds.filter((a): a is string => typeof a === 'string')
      : [];
    if (accountIds.length > 0) {
      await clearActiveMatch(redis, ...accountIds).catch((e) =>
        log.warn('clearActiveMatch (abandon) failed', { err: (e as Error).message }),
      );
    }
    return reply.send({ ok: true });
  });

  // ── GET /internal/mismatches (C3) ─────────────────────────────────────────
  // Returns the list of matches with hashMismatch=true within the last 24h (admin call).
  app.get('/internal/mismatches', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const since = now() - 24 * 3600 * 1000;
    const matches = await cols.matches
      .find({ hashMismatch: true, ts: { $gte: since } })
      .sort({ ts: -1 })
      .limit(200)
      .project({ roomId: 1, mode: 1, players: 1, reason: 1, ts: 1 })
      .toArray();
    return reply.send({ ok: true, matches });
  });

  // ── GET /internal/pvp-card-stats (BALANCE P1) ──────────────────────────────
  // Aggregates pvpCardStats across days into per-card totals (optionally filtered by mode/since); admin call.
  app.get('/internal/pvp-card-stats', async (req, reply) => {
    if (!authed(req.headers)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const query = req.query as { mode?: string; since?: string };
    const match: Record<string, unknown> = {};
    if (query.mode) match.mode = query.mode;
    if (query.since) match.day = { $gte: query.since };
    const cards = await cols.pvpCardStats
      .aggregate<{ _id: string; games: number; wins: number }>([
        { $match: match },
        { $group: { _id: '$cardId', games: { $sum: '$games' }, wins: { $sum: '$wins' } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return reply.send({
      ok: true,
      cards: cards.map((c) => ({ cardId: c._id, games: c.games, wins: c.wins })),
    });
  });
}
