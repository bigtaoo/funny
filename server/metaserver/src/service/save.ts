// Save/sync + match history/replay + replay-share handlers.
// getSave reconciles the wallet mirror, runs lazy season migration, and injects the stamina snapshot.
// There is no generic client-sync write endpoint any more (PUT /save removed) — every writable field
// (equipped.*/flags.*/equipmentInv/cardInv/wallet/...) goes through its own validated endpoint; see
// DECISIONS.md "equipped/flags server-authoritative".
import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, STARTER_TITLE } from '@nw/shared';
import { getOrCreateSave, writeMigratedSave } from '../save.js';
import { readArchivedMeta, readArchivedReplayGz } from '../replayArchive.js';
import { grantTitleToPlayer } from '../titles.js';
import { getCurrentSeason, migrateIfStale } from '../ladderSeason.js';
import { getDisplayName, ensurePublicId, hasFreeRename, AccountGoneError } from '../accounts.js';
import { mirrorWalletFrom, reconcileUndelivered } from '../economy.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, clientPlatformOf, createRateLimiter, type RateLimiter, type MetaCore } from './base.js';

type SaveHandlers = Pick<
  MetaHandlers,
  | 'getSave' | 'getMatchHistory' | 'getMatchReplay'
  | 'createReplayShare' | 'getReplayByShare' | 'createStateReplayShare' | 'getStateReplayShare'
>;

/**
 * Maximum blob size for state-stream shares. The blob is a gzip+base64 **compressed string** produced by the client (§7),
 * with a compression ratio of ~10-20×, so a 2 MB compressed string is sufficient for a very long match.
 * Requests exceeding this limit are rejected (indicating the match is too long). Fastify bodyLimit is set to ≥ this value
 * (see app.ts) so that our graceful 400 fires before Fastify's 413.
 */
const STATE_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** Expiry duration in days for state-stream shares (initially 14 days; permanent vs. N-day policy to be decided at launch, §7). */
const STATE_REPLAY_EXPIRE_DAYS = 14;
/** Per-account share minting rate limit: maximum shares per hour. */
const STATE_REPLAY_SHARE_PER_HOUR = 20;

export class SaveService implements SaveHandlers {
  /**
   * State-stream share minting rate limit (REPLAY_SHARE_DESIGN §3.1): sliding window of mint counts per
   * account within the last 1 hour. Redis-backed when configured (2026-07-27, precise across instances);
   * in-process fallback otherwise — see createRateLimiter in base.ts (this used to be a hand-rolled
   * duplicate of that same sliding-window logic with the same never-evicts-idle-keys leak; consolidated).
   */
  private readonly stateShareRate: RateLimiter;

  constructor(private readonly core: MetaCore) {
    // Built in the constructor body, not as a field initializer — with `target: ES2022` this project
    // compiles class fields with real ECMAScript semantics (useDefineForClassFields), under which ALL
    // field initializers run before the constructor's own body (including the parameter-property
    // assignment `this.core = core`), so a field initializer reading `this.core` would see `undefined`
    // (tsc catches this as TS2729 "used before its initialization" — that's why this isn't a field init).
    this.stateShareRate = createRateLimiter(this.core.deps.redis, 'share', STATE_REPLAY_SHARE_PER_HOUR, 3_600_000);
  }

    private async allowStateShare(accountId: string, now: number): Promise<boolean> {
      return this.stateShareRate.allow(accountId, now);
    }

    async getSave(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.core.deps;
      // Kicked off now, awaited only where needed below (season migration check) — independent of the
      // save/wallet reconciliation chain that follows (different collection, no shared state), so there's
      // no reason to make it wait behind that chain instead of overlapping with it.
      const currentSeasonPromise = getCurrentSeason(cols, now());
      await getOrCreateSave(cols, accountId, now()); // ensure save document exists
      // Starter title backfill (TITLE_DESIGN §6): idempotent grant of the newbie title. New accounts already
      // have it from makeNewSave; this heals pre-existing accounts created before the starter grant was wired.
      // Runs before the authoritative read below so the granted title is reflected in this response.
      await grantTitleToPlayer(cols, accountId, STARTER_TITLE, now()).catch((e) => {
        req.log.warn({ err: e }, 'starter title grant failed (non-fatal)');
      });
      // Also reconcile + refresh wallet mirror (when commercial is available): re-deliver orders left from crashes + pull authoritative balance/pity into the mirror.
      if (commercial.available) {
        try {
          const w = await reconcileUndelivered(
            cols, commercial, this.core.deps.socialsvc ?? nullMetaSocialsvcClient, accountId, now(), clientPlatformOf(req),
          );
          if (w) await mirrorWalletFrom(cols, accountId, w, now());
        } catch (e) {
          req.log.warn({ err: e }, 'commercial reconcile/mirror failed (serving local save)');
        }
      }
      let save = await getOrCreateSave(cols, accountId, now());
      // Lazy season migration (S11): if pvp.seasonNo is behind, settle previous-season rewards + soft-reset + update battle pass.
      try {
        const socialsvc = this.core.deps.socialsvc ?? nullMetaSocialsvcClient;
        const currentSeason = await currentSeasonPromise;
        const r = await migrateIfStale(cols, commercial, socialsvc, save, currentSeason, now());
        if (r.migrated) {
          save = await writeMigratedSave(
            cols,
            r.save,
            now(),
            (s) => migrateIfStale(cols, commercial, socialsvc, s, currentSeason, now()),
          );
        }
      } catch (e) {
        req.log.warn({ err: e }, 'season migrate failed (serving pre-migration save)');
      }
      // Stamina snapshot injection (A4): stamina is stored in a separate collection and merged into the save
      // mirror on response. These four reads are mutually independent (different collections/fields, none
      // consumes another's result) — same Promise.all pattern as accounts.ts's getProfile.
      let stamina: { current: number; regenAt: number };
      let displayName: string | undefined;
      let publicId: string;
      let freeRename: boolean;
      try {
        [stamina, displayName, publicId, freeRename] = await Promise.all([
          this.core.readStaminaSnapshot(accountId, now()),
          getDisplayName(cols, accountId),
          ensurePublicId(cols, accountId),
          // freeRename: the player still holds their one-time free rename (current name is a system default).
          hasFreeRename(cols, accountId),
        ]);
      } catch (e) {
        // Hard-deleted account still holding a non-expired JWT: rejectIfBanned only catches the SOFT
        // delete (deletedAt on a row that still exists), so this request gets all the way here and used
        // to 500 out of ensurePublicId's exhausted retry loop. 410 is the same answer a soft delete
        // gets, which is what the client already knows how to handle.
        if (e instanceof AccountGoneError) return reply.code(410).send(err(ErrorCode.ACCOUNT_DELETED, 'account deleted'));
        throw e;
      }
      save = { ...save, stamina };
      return ok({
        save,
        publicId,
        freeRename,
        // Clock-offset sample (P1-1): lets the client correct its local clock against every SLG/
        // economy countdown it computes from a server-issued epoch timestamp (march ETA, build/train
        // queue, subscription expiry, speedup pricing, …) — see client/src/net/serverClock.ts.
        serverNow: now(),
        ...(displayName ? { displayName } : {}),
        ...this.core.gatewayField,
        ...(await this.core.activeMatchFieldFor(accountId)),
      });
    }

    /** Recent match history (ranked / friendly): retrieves a concise summary from archived matches from the current account's perspective. */
    async getMatchHistory(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols } = this.core.deps;
      const limitRaw = Number((req.query as { limit?: string | number }).limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
        : 20;
      const docs = await cols.matches
        .find({ 'players.accountId': accountId })
        .sort({ ts: -1 })
        .limit(limit)
        .toArray();
      const matches = docs.map((d) => {
        const me = d.players.find((p) => p.accountId === accountId);
        const opp = d.players.find((p) => p.accountId !== accountId);
        const result: 'win' | 'loss' | 'unknown' =
          !me || d.winner < 0 ? 'unknown' : d.winner === me.side ? 'win' : 'loss';
        return {
          roomId: d.roomId,
          mode: d.mode,
          result,
          ...(opp?.displayName ? { opponentName: opp.displayName } : {}),
          ...(opp?.publicId ? { opponentPublicId: opp.publicId } : {}),
          ...(me?.eloDelta !== undefined ? { eloDelta: me.eloDelta } : {}),
          ts: d.ts,
        };
      });
      return ok({ matches });
    }

    /**
     * Retrieve the replay for a specific match (only matches the current account participated in); inline
     * replay takes priority, large matches fall back to replayBlobs (S1-RP). Returns the still-gzip-compressed
     * bytes as base64 (`replayGz`) — decompression is pushed to the client (net/serverReplay.ts) to save
     * bandwidth, never done server-side for this hot fetch path.
     *
     * Cold-tier fallback (S1-RP, 2026-07-20): once Mongo's 7-day TTL purges the `matches` doc, `doc` is
     * null here — the participant-authorization check falls back to the archived `<roomId>.meta.json`
     * sidecar (kept 365 days) instead of 404ing immediately, so the archive is actually reachable for the
     * scenario it exists for.
     */
    async getMatchReplay(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols } = this.core.deps;
      const roomId = (req.params as { roomId?: string }).roomId;
      if (!roomId) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
      }
      const doc = await cols.matches.findOne({ roomId });
      const players = doc?.players ?? (await readArchivedMeta(roomId))?.players;
      // Only matches the current account participated in can be retrieved (prevents unauthorized access to other players' replays).
      if (!players || !players.some((p) => p.accountId === accountId)) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
      }
      let replayGz = doc?.replayGz;
      if (!replayGz && doc?.replayRef) {
        const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
        replayGz = blob?.replayGz;
      }
      if (!replayGz) {
        replayGz = (await readArchivedReplayGz(roomId)) ?? undefined;
      }
      if (!replayGz) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay unavailable'));
      }
      return ok({ replayGz: replayGz.toString('base64') });
    }

    /** S1-RP: Create a 7-day share link (shareId) for an existing Mongo replayBlob. */
    async createReplayShare(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { roomId } = req.params as { roomId: string };
      const { cols, now } = this.core.deps;
      const blob = await cols.replayBlobs.findOne({ _id: roomId });
      if (!blob) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
      const shareId = randomUUID();
      const expiresAt = new Date(now() + 7 * 24 * 60 * 60 * 1000);
      await cols.replayShares.insertOne({ _id: shareId, roomId, accountId, expiresAt, ts: now() });
      return ok({ shareId });
    }

    /** S1-RP: Retrieve a replay by shareId (no login required; automatically expires when the TTL elapses). Returns compressed `replayGz` (base64) — client decompresses. */
    async getReplayByShare(req: FastifyRequest, reply: FastifyReply) {
      const { shareId } = req.params as { shareId: string };
      const { cols } = this.core.deps;
      const share = await cols.replayShares.findOne({ _id: shareId });
      if (!share) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
      const blob = await cols.replayBlobs.findOne({ _id: share.roomId });
      let replayGz = blob?.replayGz;
      // Cold-tier fallback (S1-RP, 2026-07-20): same as getMatchReplay above.
      if (!replayGz) {
        replayGz = (await readArchivedReplayGz(share.roomId)) ?? undefined;
      }
      if (!replayGz) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
      return ok({ replayGz: replayGz.toString('base64') });
    }

    /**
     * State-stream replay out-of-game share — mint a share code (REPLAY_SHARE_DESIGN §3.1). The sharer must be logged in; the client-generated
     * state-stream blob is uploaded with the request. The server **does not touch the engine or stat tables** — it acts purely as access-controlled object storage:
     * validate size limit + per-account rate limit → write to DB → return an unguessable shareCode. State streams are **untrusted** and must never enter anti-cheat/settlement.
     */
    async createStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, now } = this.core.deps;
      const ts = now();

      if (!(await this.allowStateShare(accountId, ts))) {
        return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many shares, try later'));
      }

      // blob = gzip+base64 compressed string produced by the client (opaque; the server does not decompress or interpret it, §7).
      const blob = (req.body as { blob?: unknown }).blob;
      if (typeof blob !== 'string' || blob.length === 0) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing replay blob'));
      }
      const sizeBytes = Buffer.byteLength(blob);
      if (sizeBytes > STATE_REPLAY_MAX_BYTES) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'replay too large'));
      }

      // Unguessable random string (144-bit base64url) to prevent enumeration.
      const shareCode = randomBytes(18).toString('base64url');
      const expireAt = new Date(ts + STATE_REPLAY_EXPIRE_DAYS * 24 * 60 * 60 * 1000);
      await cols.stateReplayShares.insertOne({
        _id: shareCode,
        blob,
        createdBy: accountId,
        createdAt: ts,
        expireAt,
        viewCount: 0,
        sizeBytes,
      });
      return ok({ shareCode });
    }

    /**
     * State-stream replay — public retrieval (REPLAY_SHARE_DESIGN §3.2). **No login required**; returns the blob + increments viewCount;
     * not found / expired → 404 (client landing page shows a "Try the Game" CTA).
     */
    async getStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
      const { shareCode } = req.params as { shareCode: string };
      const { cols } = this.core.deps;
      const doc = await cols.stateReplayShares.findOne({ _id: shareCode });
      if (!doc) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
      // Increment view count (non-blocking, does not delay response).
      void cols.stateReplayShares.updateOne({ _id: shareCode }, { $inc: { viewCount: 1 } });
      return ok({ blob: doc.blob });
    }
}
