// Account/profile lookups + moderation (ban/unban, anti-cheat review queue) used by gateway + admin backend.
import type { FastifyInstance } from 'fastify';
import { INITIAL_ELO, createLogger } from '@nw/shared';
import { getProfile, resolveByPublicId, searchAccounts } from '../accounts.js';
import { profileOf } from '../social.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

export function registerAccountRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed } = ctx;

  // ── GET /internal/elo?accountId= ──────────────────────────────────────
  app.get('/internal/elo', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    const elo = doc?.save.pvp.elo ?? INITIAL_ELO;
    const seasonPeakElo = doc?.save.pvp.seasonPeakElo ?? elo;
    log.info('GET /internal/elo', { accountId, elo, seasonPeakElo, hasSave: !!doc });
    return reply.send({ elo, seasonPeakElo });
  });

  // ── GET /internal/profile?accountId= ──────────────────────────────────
  // gateway uses this to display room players by display name (#publicId) instead of accountId. publicId is lazily generated.
  app.get('/internal/profile', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const profile = await getProfile(cols, accountId);
    return reply.send(profile); // { displayName?, publicId }
  });

  // ── GET /internal/players/search?q=&limit= ───────────────────────────
  // admin backend fuzzy player search (OPS_DESIGN §4.1): a single keyword matches publicId/accountId/loginId/display name,
  // returns the hit list (summary); full details are fetched via /internal/player. q < 2 chars returns empty; limit 1..50.
  app.get('/internal/players/search', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const q = (req.query as { q?: string }).q;
    if (!q) return reply.code(400).send({ ok: false, error: 'q required' });
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit) || 20, 1), 50);
    const players = await searchAccounts(cols, q, limit);
    return reply.send({ players });
  });

  // ── GET /internal/player?publicId= | ?accountId= ─────────────────────
  // admin backend player detail (OPS_DESIGN §4.1 player.lookup): reverse-lookup profile summary by 9-digit publicId or accountId.
  app.get('/internal/player', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { publicId, accountId: accountIdQ } = req.query as {
      publicId?: string;
      accountId?: string;
    };
    if (!publicId && !accountIdQ) {
      return reply.code(400).send({ ok: false, error: 'publicId or accountId required' });
    }
    let accountId: string | null;
    if (publicId) {
      accountId = await resolveByPublicId(cols, publicId);
    } else {
      const exists = await cols.accounts.findOne({ _id: accountIdQ! }, { projection: { _id: 1 } });
      accountId = exists?._id ?? null;
    }
    if (!accountId) return reply.code(404).send({ ok: false, error: 'not found' });
    const [profile, saveDoc] = await Promise.all([
      getProfile(cols, accountId),
      cols.saves.findOne({ _id: accountId }),
    ]);
    const pvp = saveDoc?.save.pvp;
    return reply.send({
      publicId: profile.publicId,
      accountId,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(pvp
        ? { rank: pvp.rank, elo: pvp.elo, wins: pvp.wins, losses: pvp.losses }
        : {}),
    });
  });

  // ── GET /internal/anticheat/reviews?accountId=&status=&limit= ────────
  // admin backend anti-cheat review queue (S9-7, ACHIEVEMENT_DESIGN §4.4): lists over-reported records flagged by offline sampling.
  // Default status=open; can be filtered by accountId; limit 1..100.
  app.get('/internal/anticheat/reviews', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const q = req.query as { accountId?: string; status?: string; limit?: string };
    const filter: Record<string, unknown> = {};
    if (q.accountId) filter.accountId = q.accountId;
    if (q.status === 'open' || q.status === 'reviewed') filter.status = q.status;
    else if (q.status === undefined) filter.status = 'open';
    // status=all (or any other value) → no status filter
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const reviews = await cols.antiCheatReviews
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return reply.send({ reviews });
  });

  // ── GET /internal/social/friends?accountId= ──────────────────────────
  // gateway uses this to determine the presence broadcast scope (pushes friend_presence to the user's online friends on connect/disconnect).
  app.get('/internal/social/friends', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    // After P2, friend data has been migrated to socialsvc; this fallback endpoint is only used when socialsvc is not configured and returns an empty list.
    return reply.send({ friends: [] as string[] });
  });

  // ── P2: socialsvc account reverse-lookup ──────────────────────────────────────────────
  // socialsvc does not connect directly to the accounts collection; it resolves publicId and fetches profiles in bulk via these two internal endpoints.

  // GET /internal/account/by-public-id/:publicId → { accountId, profile }
  app.get('/internal/account/by-public-id/:publicId', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { publicId } = req.params as { publicId: string };
    const accountId = await resolveByPublicId(cols, publicId);
    if (!accountId) return reply.code(404).send({ ok: false, error: 'not found' });
    const profile = await getProfile(cols, accountId);
    return reply.send({ accountId, profile });
  });

  // POST /internal/account/batch-profiles → { profiles: { [accountId]: ProfileView } }
  app.post('/internal/account/batch-profiles', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { accountIds } = req.body as { accountIds?: unknown };
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return reply.send({ profiles: {} });
    }
    const ids = (accountIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 200);
    const profiles: Record<string, object> = {};
    await Promise.all(ids.map(async (id) => {
      const p = await profileOf(cols, id);
      if (p) profiles[id] = p;
    }));
    return reply.send({ profiles });
  });

  // ── GET /internal/suspicious-pve (C4) ─────────────────────────────────────────
  // Returns the list of accounts with pveWarnings > 0 (for admin manual review).
  app.get('/internal/suspicious-pve', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accounts = await cols.accounts
      .find({ 'flags.pveWarnings': { $gt: 0 } })
      .sort({ 'flags.pveWarnings': -1 })
      .limit(200)
      .project({ _id: 1, displayName: 1, publicId: 1, 'flags.pveWarnings': 1, 'flags.banned': 1, createdAt: 1 })
      .toArray();
    return reply.send({ ok: true, accounts });
  });

  // ── POST /internal/accounts/:id/ban (S4-4) ─────────────────────────────────────
  // Admin manual ban: sets accounts.flags.banned = true. Idempotent.
  app.post('/internal/accounts/:id/ban', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { id } = req.params as { id: string };
    const doc = await cols.accounts.findOne({ _id: id }, { projection: { _id: 1 } });
    if (!doc) return reply.code(404).send({ ok: false, error: 'account not found' });
    await cols.accounts.updateOne({ _id: id }, { $set: { 'flags.banned': true } });
    return reply.send({ ok: true });
  });

  // ── POST /internal/accounts/:id/unban (S4-4) ───────────────────────────────────
  // Admin unban: clears accounts.flags.banned + antiCheat.pveBanned (removes save-layer ban). Idempotent.
  app.post('/internal/accounts/:id/unban', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { id } = req.params as { id: string };
    const doc = await cols.accounts.findOne({ _id: id }, { projection: { _id: 1 } });
    if (!doc) return reply.code(404).send({ ok: false, error: 'account not found' });
    await cols.accounts.updateOne({ _id: id }, { $unset: { 'flags.banned': '' } });
    // Also clear the save-layer pveBanned flag to prevent the account from being blocked by pveClear after unbanning.
    await cols.saves.updateOne({ _id: id }, { $unset: { 'save.antiCheat.pveBanned': '' } });
    return reply.send({ ok: true });
  });
}
