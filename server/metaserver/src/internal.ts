// meta internal routes (M17/M19, S1-M3) — not visible to players, authenticated via X-Internal-Key, bypasses openapi glue.
//   GET  /internal/elo            gateway fetches ELO before queuing (matchsvc stays DB-free, §8.5)
//   POST /internal/match/report   gameserver end-of-match report: reconcile + compute ELO, write saves.pvp + archive matches (§8.3)
//
// ELO settlement / archive logic migrated from gameserver (M19): ladder authority consolidated into meta. room_id is idempotent (matches unique).
import type { FastifyInstance } from 'fastify';
import type { Collections, SaveDoc, SaveData } from '@nw/shared';
import {
  INITIAL_ELO,
  ELO_FLOOR,
  computeEloDelta,
  eloToRank,
  nextStreak,
  victoryCoinsForRank,
  createLogger,
  createInternalAuth,
  sanitizePvpReportedStats,
  accrueStats,
  computeFirstReachGrant,
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  xpToLevel,
  accrueRetentionTask,
  type StatKey,
  type RankId,
  type EventInput,
} from '@nw/shared';
import {
  getCurrentSeason,
  migrateIfStale,
  rollSeason,
} from './ladderSeason.js';
import { writeMigratedSave } from './save.js';
import type { GatewayClient } from './gatewayClient.js';
import type { CommercialClient } from './commercialClient.js';
import { adsDayKey } from './economy.js';
import { getProfile, resolveByPublicId, searchAccounts } from './accounts.js';
import { grantTitleToPlayer } from './titles.js';
import { accrueEventTask, adminListEvents, adminCreateEvent, adminUpdateEvent, adminDeleteEvent } from './events.js';
import { profileOf } from './social.js';
import { insertSystemMail, bulkInsertSystemMail } from './mail.js';
import { escrowEquipment, grantEquipment } from './equipment.js';
import type { CompTarget, EquipmentInstance, MailAttachmentDoc } from '@nw/shared';
import { ERROR_HTTP_STATUS } from '@nw/shared';

const log = createLogger('meta:internal');

/** Maximum byte size for inline replay frames; if exceeded, frames are stored externally in replayBlobs + replayRef (keeps matches documents compact). */
const REPLAY_INLINE_MAX_BYTES = 256 * 1024;

/** Number of accounts per batch in the server-wide system mail fan-out (ops per bulkWrite). MongoDB single-batch limit is 1000; leaving headroom. */
const MAIL_FANOUT_BATCH = 500;

interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}

interface ReportBody {
  room_id: string;
  seed: string;
  mode: string; // friendly | ranked
  reason: string; // base | disconnect | mismatch
  winner_side: number;
  hash_ok: boolean;
  players: { side: number; accountId: string }[];
  results: { side: number; state_hash: string; winner_side: number; stats?: Record<string, number> }[];
  replay: {
    engineVersion: number;
    mode: string;
    seed: string;
    endFrame: number;
    frames: { frame: number; cmds: { side: number; commands: string }[] }[];
    meta: { recordedAt: number; winner: number };
  };
}

export interface InternalDeps {
  cols: Collections;
  /** Single shared secret key (legacy fallback + ticket HMAC). */
  internalKey: string;
  /** Optional per-caller key registry (parsed from NW_INTERNAL_KEYS); if non-empty, enables strict per-caller authentication. */
  internalKeys?: Record<string, string>;
  now: () => number;
  /** Peer-judge client (Phase C). If unconfigured, available=false and ranked mismatches are voided directly. */
  gateway: GatewayClient;
  /** commercial client: sends ranked-victory coins by tier to the winner (§2.3b). If unconfigured, no coins are sent. */
  commercial: CommercialClient;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  const { cols, internalKey, internalKeys, now, gateway, commercial } = deps;

  // Centralized verifier: timing-safe + strict per-caller (NW_INTERNAL_KEYS) + single shared-key fallback.
  const auth = createInternalAuth({ keys: internalKeys, legacyKey: internalKey });
  const authed = (key: unknown): boolean =>
    auth.verify({ 'x-internal-key': typeof key === 'string' ? key : undefined }).ok;

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

  // ── System mail (S6-3, OPS_DESIGN §3.3): admin compensation tickets go through HttpMailDispatcher. ──
  // Funds are credited via commercial/inventory only when the player claims the mail (admin never writes to the wallet directly). dispatchKey is idempotent.
  interface SystemMailBody {
    dispatchKey: string;
    scope?: 'single' | 'global';
    /** Direct-delivery accountId for internal callers (§17.5, e.g. worldsvc) that have no publicId; mutually exclusive with target. */
    accountId?: string;
    target?: CompTarget;
    subject: string;
    body: string;
    // MailAttachmentDoc (not CompAttachment): in addition to OPS compensation coins/item/skin, it also includes worldsvc season-reward
    // 'material' (→ SaveData.materials unified progression pool, SLG8). CompAttachment is a subset of this.
    attachments: MailAttachmentDoc[];
    expireDays: number;
  }

  // POST /internal/mail/system/preview → { ok, recipientCount }
  app.post('/internal/mail/system/preview', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as Pick<SystemMailBody, 'scope' | 'target'>;
    if (b.scope === 'global') {
      const recipientCount = await cols.accounts.countDocuments({});
      return reply.send({ ok: true, recipientCount });
    }
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = await resolveByPublicId(cols, publicId);
    return reply.send({ ok: true, recipientCount: accountId ? 1 : 0 });
  });

  // POST /internal/mail/system/send → { ok, recipientCount }
  app.post('/internal/mail/system/send', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as SystemMailBody;
    if (!b?.dispatchKey || !b.subject) {
      return reply.code(400).send({ ok: false, error: 'dispatchKey + subject required' });
    }
    const content = {
      subject: b.subject,
      body: b.body ?? '',
      attachments: b.attachments ?? [],
      expireDays: b.expireDays ?? 0,
    };

    if (b.scope === 'global') {
      // Server-wide fan-out in batches: each batch of MAIL_FANOUT_BATCH accounts performs one bulkWrite (unordered upsert),
      // reducing O(N) round-trips to O(N/batch). Only newly inserted recipients in this batch receive a badge push (dispatchKey is idempotent; retries do not duplicate pushes).
      let recipientCount = 0;
      let insertedCount = 0;
      let batch: string[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const ids = batch;
        batch = [];
        const r = await bulkInsertSystemMail(cols, b.dispatchKey, ids, content, now());
        recipientCount += ids.length;
        insertedCount += r.insertedAccountIds.length;
        for (const accountId of r.insertedAccountIds) {
          // Offline gateway discards on its own; push is fire-and-forget and does not block the batch.
          void gateway.push(accountId, {
            kind: 'mail_new',
            mailId: `${b.dispatchKey}:${accountId}`,
            hasAttachment: r.hasAttachment,
          });
        }
      };
      const cursor = cols.accounts.find({}, { projection: { _id: 1 } });
      for await (const doc of cursor) {
        batch.push(doc._id);
        if (batch.length >= MAIL_FANOUT_BATCH) await flush();
      }
      await flush();
      log.info('POST /internal/mail/system/send (global)', {
        dispatchKey: b.dispatchKey,
        recipientCount,
        insertedCount,
      });
      return reply.send({ ok: true, recipientCount });
    }

    // Internal direct-delivery path (§17.5): internal callers like worldsvc deliver by accountId (no publicId), bypassing resolution.
    const directAccountId =
      typeof (b as { accountId?: unknown }).accountId === 'string'
        ? (b as { accountId: string }).accountId
        : null;
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = directAccountId ?? (await resolveByPublicId(cols, publicId));
    if (!accountId) return reply.send({ ok: false, recipientCount: 0, error: 'recipient not found' });
    const r = await insertSystemMail(cols, b.dispatchKey, accountId, content, now());
    if (r.inserted) {
      void gateway.push(accountId, { kind: 'mail_new', mailId: r.mailId, hasAttachment: r.hasAttachment });
    }
    log.info('POST /internal/mail/system/send (single)', { dispatchKey: b.dispatchKey, publicId });
    return reply.send({ ok: true, recipientCount: 1 });
  });

  // ── POST /internal/match/report ───────────────────────────────────────
  app.post('/internal/match/report', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as ReportBody;
    if (!body?.room_id) return reply.code(400).send({ ok: false, error: 'room_id required' });
    log.info('POST /internal/match/report', {
      roomId: body.room_id,
      mode: body.mode,
      reason: body.reason,
      winner: body.winner_side,
      hashOk: body.hash_ok,
    });

    // Idempotent: if the same room_id has already been archived, return ok immediately (resends do not re-settle).
    const existing = await cols.matches.findOne({ roomId: body.room_id });
    if (existing) return reply.send({ ok: true });

    // ranked + has a winner + not voided (base/disconnect) → server-authoritative ELO settlement.
    const settleRanked =
      body.mode === 'ranked' && body.winner_side >= 0 && body.reason !== 'mismatch';
    let eloBySide: Record<number, EloResult> | null = null;
    let cheat: { side: number; accountId: string; judgeAccountId?: string } | undefined;
    // S9-7: archive the credited per-side reported values as the baseline for offline sampling comparison (only for normally settled ranked matches; mismatch matches are intentionally not fed and remain empty).
    let reportedStats: Record<string, Partial<Record<StatKey, number>>> | undefined;
    if (settleRanked) {
      const winner = body.players.find((p) => p.side === body.winner_side);
      const loser = body.players.find((p) => p.side !== body.winner_side);
      if (winner && loser) {
        // S9-6: sanitize each side's reported in-match achievement counts (L1 anomaly re-check, §4.4). Out-of-bounds/invalid → null rejects that side's kill/cast
        // (pvp.wins/ELO proceed normally); suspicion escalation (statSuspicion) belongs to S9-7 (offline sampling anticheatAudit.ts).
        const wStats = statDeltaForSide(body, winner.side);
        const lStats = statDeltaForSide(body, loser.side);
        reportedStats = { [String(winner.side)]: wStats, [String(loser.side)]: lStats };
        try {
          eloBySide = await settleElo(cols, now, commercial, winner, loser, wStats, lStats);
        } catch (e) {
          log.error('ranked ELO settle failed', { err: (e as Error).message });
        }
      }
    } else if (body.mode === 'ranked' && body.reason === 'mismatch' && gateway.available) {
      // Phase C peer judge: the two sides' hashes disagree → pick a third-party headless re-computation to adjudicate (rather than voiding directly).
      try {
        const verdict = await judgeMismatch(gateway, body);
        if (verdict) {
          // A hash-mismatched match is already suspicious: do not accumulate either side's self-reported kill/cast (pvp.wins still counts for the honest side's win).
          eloBySide = await settleElo(cols, now, commercial, verdict.honest, verdict.cheater, {}, {});
          cheat = {
            side: verdict.cheater.side,
            accountId: verdict.cheater.accountId,
            ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
          };
        }
      } catch (e) {
        log.error('peer judge failed', { err: (e as Error).message });
      }
    }

    // Before archiving, enrich each side's identity snapshot (display name / publicId) + ELO settlement result (ranked only).
    // The snapshot is frozen at the moment of archiving; subsequent name changes are not back-filled — match history shows the name at the time.
    const enrichedPlayers = await Promise.all(
      body.players.map(async (p) => {
        const profile = await getProfile(cols, p.accountId).catch(() => ({ publicId: undefined as string | undefined }));
        const elo = eloBySide?.[p.side];
        return {
          side: p.side,
          accountId: p.accountId,
          ...((profile as { displayName?: string }).displayName
            ? { displayName: (profile as { displayName?: string }).displayName }
            : {}),
          ...(profile.publicId ? { publicId: profile.publicId } : {}),
          ...(elo ? { eloDelta: elo.delta, eloAfter: elo.after } : {}),
        };
      }),
    );

    // Archive to matches. winner -1 = unknown (friendly match ended normally).
    // Replay: small matches inline as `replay`; large matches that exceed the threshold are stored externally in `replayBlobs` + `replayRef` (keeps matches documents compact).
    const replayDoc = {
      engineVersion: body.replay.engineVersion,
      mode: body.replay.mode,
      seed: body.replay.seed,
      endFrame: body.replay.endFrame,
      frames: body.replay.frames, // cmds[].commands are base64 opaque (not decoded — M12)
      meta: body.replay.meta,
    };
    const replayBytes = JSON.stringify(replayDoc.frames).length;
    const inline = replayBytes <= REPLAY_INLINE_MAX_BYTES;
    if (!inline) {
      // Write the blob first (roomId upsert is idempotent); matches only stores the replayRef pointer.
      await cols.replayBlobs
        .updateOne(
          { _id: body.room_id },
          { $set: { _id: body.room_id, replay: replayDoc, ts: now() } },
          { upsert: true },
        )
        .catch((e) => log.error('archive replay blob failed', { err: (e as Error).message }));
    }
    await cols.matches
      .insertOne({
        roomId: body.room_id,
        mode: body.mode,
        seed: body.seed,
        players: enrichedPlayers,
        winner: cheat ? body.players.find((p) => p.side !== cheat!.side)!.side : body.winner_side,
        reason: body.reason,
        hashOk: body.hash_ok,
        // C3: hash mismatch and peer judge did not intervene (no cheat verdict) → flag for admin review.
        ...(!body.hash_ok && !cheat ? { hashMismatch: true } : {}),
        ...(inline ? { replay: replayDoc } : { replayRef: body.room_id }),
        ...(cheat ? { cheat } : {}),
        ...(reportedStats ? { reportedStats } : {}),
        ts: now(),
      })
      .catch((e) => {
        // Idempotency race: a unique-index conflict means a concurrent request already archived the match; ignore.
        if ((e as { code?: number }).code !== 11000) log.error('archive match failed', { err: (e as Error).message });
      });

    // C3: hash mismatch and not adjudicated by the peer judge → warning log (visible to admin via /admin/mismatches).
    if (!body.hash_ok && !cheat) {
      log.warn('hash mismatch unresolved', {
        roomId: body.room_id,
        mode: body.mode,
        accountIds: body.players.map((p) => p.accountId),
      });
    }

    // B6: accrue event task 'pvp.win' for the winner (best-effort).
    if (body.winner_side >= 0) {
      const winner = body.players.find((p) => p.side === body.winner_side);
      if (winner) {
        accrueEventTask(cols, winner.accountId, 'pvp.win', now()).catch(() => {});
      }
    }

    return reply.send({ ok: true, ...(eloBySide ? { elo: eloBySide } : {}) });
  });

  // ── GET /internal/mismatches (C3) ─────────────────────────────────────────
  // Returns the list of matches with hashMismatch=true within the last 24h (admin call).
  app.get('/internal/mismatches', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
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

  // ── Material deduction / grant (S8-5, called by worldsvc auction) ─────────────────────────────────
  // Bypasses openapi glue, authenticated via X-Internal-Key.
  // POST /internal/materials/deduct  { accountId, material, qty, orderId }
  //   → deduct the specified material; insufficient balance → 402; optimistic-lock conflict retried 3 times, then 409.
  app.post('/internal/materials/deduct', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      if (cur < qty) return reply.code(402).send({ ok: false, error: 'insufficient materials' });
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur - qty },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) return reply.send({ ok: true, remaining: cur - qty });
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // POST /internal/materials/grant  { accountId, material, qty, orderId }
  //   → grant the specified material; idempotent (orderId is currently logged only, no dedup collection, best-effort).
  app.post('/internal/materials/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty, orderId } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
      orderId?: string;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur + qty },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) {
        log.info('materials granted', { accountId, material, qty, orderId, after: cur + qty });
        return reply.send({ ok: true, after: cur + qty });
      }
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // ── Equipment escrow / transfer (E2, called by worldsvc auction equipment transactions) ─────────────────────────────
  // POST /internal/equipment/escrow  { accountId, instanceId, orderId } → { instance }
  //   Listing escrow: verify not equipped/locked → remove from seller's inventory → return snapshot (worldsvc stores it in the listing doc). orderId is idempotent.
  app.post('/internal/equipment/escrow', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instanceId, orderId } = req.body as {
      accountId?: string;
      instanceId?: string;
      orderId?: string;
    };
    if (!accountId || !instanceId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + instanceId + orderId required' });
    }
    const r = await escrowEquipment(cols, now, accountId, instanceId, orderId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment escrowed', { accountId, instanceId, orderId });
    return reply.send({ ok: true, instance: r.instance });
  });

  // POST /internal/equipment/grant  { accountId, instance, orderId } → { ok }
  //   Sale transfer (to buyer) / cancellation·expiry·season-end return (to seller): writes the instance snapshot into inventory (upsert by id makes it idempotent).
  app.post('/internal/equipment/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: EquipmentInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    const r = await grantEquipment(cols, now, accountId, instance);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // ── Progression snapshot (E8, called by worldsvc siege engine authoritative computation) ────────────────────────────────
  // GET /internal/save-fields?accountId=  → { pveUpgrades, unitLevels, gear, equipmentInv }
  //   Returns the attacker's progression-related fields for worldsvc to pass into buildSiegeBlueprints for authoritative blueprint computation.
  //   If the account does not exist, treats it as a new account (returns empty defaults); does not return 404 to avoid freezing a march.
  app.get('/internal/save-fields', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const accountId = (req.query as Record<string, string>).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    const s = doc?.save;
    return reply.send({
      pveUpgrades: s?.pveUpgrades ?? {},
      unitLevels: s?.unitLevels ?? {},
      gear: s?.gear ?? {},
      equipmentInv: s?.equipmentInv ?? {},
    });
  });

  // ── POST /admin/ladder/season/roll ────────────────────────────────────────
  // admin (ops backend) manually closes the current season and opens a new one (S11-SE-3, SEASON_DESIGN §3.1; closed-loop L2-1).
  // Before rolling, eagerly settles all participants from the previous season (rank reward mail + season title + snapshot, idempotent).
  // CAS idempotent: concurrent or accidental re-entry returns the current season without advancing again.
  app.post('/admin/ladder/season/roll', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    try {
      const season = await rollSeason(cols, commercial, now());
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
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const season = await getCurrentSeason(cols, now());
    return reply.send({ ok: true, season });
  });

  // ── POST /admin/grant-title ───────────────────────────────────────────────────────
  // admin manually grants a title (S10, TITLE_DESIGN §8 admin grant). Idempotent: no-op if already owned.
  app.post('/admin/grant-title', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { accountId, titleId } = req.body as { accountId?: string; titleId?: string };
    if (!accountId || !titleId) {
      return reply.code(400).send({ ok: false, error: 'accountId and titleId required' });
    }
    try {
      await grantTitleToPlayer(cols, accountId, titleId, now());
      log.info('POST /admin/grant-title', { accountId, titleId });
      return reply.send({ ok: true });
    } catch (e) {
      log.error('grant-title failed', { accountId, titleId, err: (e as Error).message });
      return reply.code(500).send({ ok: false, error: 'grant failed' });
    }
  });

  // ── GET /internal/leaderboard ─────────────────────────────────────────────────────
  // Server-wide Top100 (S11-SE-5, SEASON_DESIGN §5). Authenticated via X-Internal-Key for admin queries; player-facing equivalent is service.ts getLeaderboard.
  app.get('/internal/leaderboard', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const season = await getCurrentSeason(cols, now());
    const top = await cols.saves
      .find({ 'save.pvp.seasonNo': season.seasonNo })
      .sort({ 'save.pvp.elo': -1 })
      .limit(100)
      .project({ _id: 1, 'save.pvp': 1, 'save.equipped': 1 })
      .toArray();
    const accounts = await Promise.all(
      top.map((d) => cols.accounts.findOne({ _id: d._id }, { projection: { displayName: 1, publicId: 1 } })),
    );
    const entries = top.map((d, i) => ({
      rank: i + 1,
      accountId: d._id,
      displayName: accounts[i]?.displayName,
      publicId: accounts[i]?.publicId,
      elo: (d as unknown as { save: { pvp: { elo: number; rank: string } } }).save.pvp.elo,
      rankId: (d as unknown as { save: { pvp: { rank: string } } }).save.pvp.rank,
    }));
    return reply.send({ season, top: entries });
  });

  // ── Time-limited event management (B6, admin events.manage; ADR-014) ─────────────────────────
  // Player-facing GET /events only returns events within the active window; the following endpoints let the ops backend list/create/edit/delete all events.
  // GET /admin/events — all events (including not-yet-started and ended).
  app.get('/admin/events', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const events = await adminListEvents(cols);
    return reply.send({ ok: true, events });
  });
  // POST /admin/events — create an event. body = EventInput.
  app.post('/admin/events', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const r = await adminCreateEvent(cols, req.body as EventInput, now());
    if (!r.ok) {
      const code = r.error === 'DUPLICATE_ID' ? 409 : 400;
      return reply.code(code).send({ ok: false, error: r.error, detail: r.detail });
    }
    log.info('POST /admin/events', { eventId: r.event._id });
    return reply.send({ ok: true, event: r.event });
  });
  // PATCH /admin/events/:id — full replacement of event definition. body = EventInput.
  app.patch('/admin/events/:id', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const r = await adminUpdateEvent(cols, id, req.body as EventInput);
    if (!r.ok) {
      const code = r.error === 'NOT_FOUND' ? 404 : 400;
      return reply.code(code).send({ ok: false, error: r.error, detail: r.detail });
    }
    log.info('PATCH /admin/events/:id', { eventId: id });
    return reply.send({ ok: true, event: r.event });
  });
  // DELETE /admin/events/:id — delete event definition (participation history is retained).
  app.delete('/admin/events/:id', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const r = await adminDeleteEvent(cols, id);
    if (!r.ok) return reply.code(404).send({ ok: false, error: r.error });
    log.info('DELETE /admin/events/:id', { eventId: id });
    return reply.send({ ok: true });
  });

  // POST /internal/title/grant  { accountId, titleId }
  //   → Grant title (idempotent, called from SLG/worldsvc season settlement). Authenticated via X-Internal-Key.
  app.post('/internal/title/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
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

  // ── Promo code management (B-PROMO, admin promo.manage; stored via commercial) ──────────────
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
}

/**
 * Peer judge (Phase C): sends the full match replay to gateway to pick a third-party headless re-computation, and determines which side is honest based on the judge's hash.
 * Returns { honest side, cheating side, judge accountId }; if the judge cannot adjudicate (no candidates / timeout / re-computation failure / result does not match either side) → null.
 */
async function judgeMismatch(
  gateway: GatewayClient,
  body: ReportBody,
): Promise<{
  honest: { side: number; accountId: string };
  cheater: { side: number; accountId: string };
  judgeAccountId?: string;
} | null> {
  if (body.results.length !== 2) return null;
  const verdict = await gateway.judge({
    seed: Number(body.seed),
    mode: 1, // RANKED (judge client re-computes as netplay; mode is audit-semantic only)
    endFrame: body.replay.endFrame,
    frames: body.replay.frames, // command bytes are already base64; passed through as-is
    exclude: body.players.map((p) => p.accountId),
  });
  if (!verdict.ok || !verdict.stateHash) return null;

  // Whichever side matches the judge's hash is honest; the other side (hash mismatch) is the cheater. The two sides' hashes are different from each other,
  // so at most one side can match; if neither matches (judge result does not correspond to either side), adjudication fails → void.
  const honestRes = body.results.find((r) => r.state_hash === verdict.stateHash);
  const cheaterRes = body.results.find((r) => r.state_hash !== verdict.stateHash);
  if (!honestRes || !cheaterRes) return null;
  const honest = body.players.find((p) => p.side === honestRes.side);
  const cheater = body.players.find((p) => p.side === cheaterRes.side);
  if (!honest || !cheater) return null;
  return {
    honest,
    cheater,
    ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
  };
}

/**
 * S9-6: Fetch one side's reported in-match achievement counts and run them through L1 sanitization (§4.4).
 * Returns the sanitized statKey deltas; out-of-bounds/invalid → logs a warning and returns `{}` (rejects that side's kill/cast, pvp.wins proceed normally).
 */
function statDeltaForSide(body: ReportBody, side: number): Partial<Record<StatKey, number>> {
  const reported = body.results.find((r) => r.side === side)?.stats;
  const clean = sanitizePvpReportedStats(reported);
  if (clean === null) {
    log.warn('PvP stat L1 reject (out-of-bounds reported stats)', { roomId: body.room_id, side });
    return {};
  }
  return clean;
}

/** Two-sided ELO settlement: read scores → compute delta → atomically write saves.pvp for each player (optimistic-lock rev guard + retry). */
async function settleElo(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  winner: { side: number; accountId: string },
  loser: { side: number; accountId: string },
  // S9-6: L1-sanitized in-match kill/cast deltas (only fed for ranked). pvp.wins is computed internally in applyPvp from the `won` flag.
  winnerStats: Partial<Record<StatKey, number>> = {},
  loserStats: Partial<Record<StatKey, number>> = {},
): Promise<Record<number, EloResult>> {
  const [wDoc, lDoc] = await Promise.all([
    cols.saves.findOne({ _id: winner.accountId }),
    cols.saves.findOne({ _id: loser.accountId }),
  ]);
  const wElo = wDoc?.save.pvp.elo ?? INITIAL_ELO;
  const lElo = lDoc?.save.pvp.elo ?? INITIAL_ELO;
  const { winner: wDelta, loser: lDelta } = computeEloDelta(wElo, lElo);
  const out: Record<number, EloResult> = {};
  const [wRes, lRes] = await Promise.all([
    applyPvp(cols, now, commercial, winner.accountId, wDoc, wDelta, true, winnerStats),
    applyPvp(cols, now, commercial, loser.accountId, lDoc, lDelta, false, loserStats),
  ]);
  if (wRes) out[winner.side] = wRes;
  if (lRes) out[loser.side] = lRes;

  // Ranked-victory coins (§2.3b): winner only, awarded at the post-settlement rank; commercial enforces the daily cap authoritatively.
  // best-effort — a failed coin credit does not affect ELO settlement (wallet is commercial-authoritative; reconciled on the next GET /save).
  if (wRes && commercial.available) {
    const amount = victoryCoinsForRank(wRes.rankAfter);
    try {
      await commercial.victoryCredit({
        accountId: winner.accountId,
        amount,
        dayKey: adsDayKey(now()),
      });
    } catch (e) {
      log.error('victory coin credit failed', {
        accountId: winner.accountId,
        err: (e as Error).message,
      });
    }
  }
  return out;
}

/** Single-side pvp atomic update (full save replacement, following the putSave convention, to avoid clobbering concurrent client PUT /save writes). */
async function applyPvp(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  accountId: string,
  doc: SaveDoc | null,
  delta: number,
  won: boolean,
  statDelta: Partial<Record<StatKey, number>> = {},
): Promise<EloResult | null> {
  // S9-6: in-match achievement count delta = L1-sanitized kill/cast + server-computed pvp.wins (winner +1 only; client value not trusted).
  const fullStatDelta: Partial<Record<StatKey, number>> = { ...statDelta, ...(won ? { 'pvp.wins': 1 } : {}) };
  // S11: run lazy migration before ranked settlement (only triggers at season end; normally a no-op).
  const currentSeason = await getCurrentSeason(cols, now()).catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    let cur = attempt === 0 && doc ? doc : await cols.saves.findOne({ _id: accountId });
    if (!cur) return null; // ranked players should already have a save doc
    // Lazy migration: if the save is behind the current season, settle the previous season and soft-reset first (rarely triggered; normally a no-op).
    if (currentSeason) {
      const mr = await migrateIfStale(cols, commercial, cur.save, currentSeason, now());
      if (mr.migrated) {
        // The migrated save must be persisted before the ELO update; otherwise the migration result is lost.
        const migrated = await writeMigratedSave(
          cols,
          mr.save,
          now(),
          (s) => migrateIfStale(cols, commercial, s, currentSeason, now()),
        );
        cur = { _id: cur._id, save: migrated, rev: migrated.rev };
      }
    }
    const pvp = cur.save.pvp;
    const after = Math.max(ELO_FLOOR, pvp.elo + delta);
    const appliedDelta = after - pvp.elo;
    const rank = eloToRank(after) as RankId;

    // S11: first-reach rank coins + peak tracking (§4.3)
    const reachedRanks: RankId[] = pvp.reachedRanks ?? [];
    const { coins: firstReachAmt, newly } = computeFirstReachGrant(rank, reachedRanks);

    const nextStats = accrueStats(cur.save.stats, fullStatDelta); // lazy-create: returns the original if there are no deltas
    const newPeakElo = Math.max(pvp.seasonPeakElo ?? after, after);
    const newPeakRank = eloToRank(newPeakElo) as RankId;
    // S11: each ranked match awards season XP (battle pass progress, §C).
    const bpXpGain = won ? BP_XP_PER_RANKED_WIN : BP_XP_PER_RANKED_LOSS;
    const prevBp = cur.save.battlePass;
    const newBp = prevBp ? { ...prevBp, xp: prevBp.xp + bpXpGain, level: xpToLevel(prevBp.xp + bpXpGain) } : null;
    // B5: accrue daily task 'participate in a PvP match' (idempotent).
    const nextRetention = accrueRetentionTask(cur.save.retention, 'pvp.match', now());
    const next: SaveData = {
      ...cur.save,
      rev: cur.save.rev + 1,
      updatedAt: now(),
      ...(nextStats ? { stats: nextStats } : {}),
      ...(newBp ? { battlePass: newBp } : {}),
      ...(nextRetention !== cur.save.retention ? { retention: nextRetention } : {}),
      pvp: {
        ...pvp,
        elo: after,
        rank,
        streak: nextStreak(pvp.streak, won),
        wins: pvp.wins + (won ? 1 : 0),
        losses: pvp.losses + (won ? 0 : 1),
        seasonNo: pvp.seasonNo ?? (currentSeason?.seasonNo ?? 1),
        seasonPeakElo: newPeakElo,
        seasonPeakRank: newPeakRank,
        reachedRanks: newly.length > 0 ? [...reachedRanks, ...newly] : reachedRanks,
      },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: cur.save.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) {
      // First-reach coins: player is online; credit immediately (same path as achievement/title grants, instant feedback).
      if (firstReachAmt > 0 && commercial.available) {
        try {
          await commercial.grant({
            accountId,
            amount: firstReachAmt,
            reason: 'rank_first_reach',
            orderId: `rank.first.${accountId}.${newly.join('.')}`,
          });
        } catch (e) {
          log.error('firstReach coin grant failed', { accountId, err: (e as Error).message });
        }
      }
      return { delta: appliedDelta, after, rankAfter: rank };
    }
    // rev conflict (concurrent client PUT /save) → re-read and retry
  }
  return null;
}
