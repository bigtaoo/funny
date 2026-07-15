// Save/sync + match history/replay + replay-share handlers.
// getSave reconciles the wallet mirror, runs lazy season migration, and injects the stamina snapshot;
// putSave is the optimistic-locked client sync (progress/materials/pveUpgrades are NOT accepted here —
// they are written only at PvE/PvP authoritative settlement, trust boundary §8.3).
import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SyncPatch } from '@nw/shared';
import { ErrorCode, err, ok } from '@nw/shared';
import { getOrCreateSave, putSave, writeMigratedSave } from '../save.js';
import { getCurrentSeason, migrateIfStale } from '../ladderSeason.js';
import { getDisplayName, ensurePublicId, hasFreeRename } from '../accounts.js';
import { mirrorWalletFrom, reconcileUndelivered } from '../economy.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

type SaveHandlers = Pick<
  MetaHandlers,
  | 'getSave' | 'putSave' | 'getMatchHistory' | 'getMatchReplay'
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

export function SaveMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<SaveHandlers> {
  return class extends Base {
    /**
     * State-stream share minting rate limit (REPLAY_SHARE_DESIGN §3.1): sliding window of mint counts per account within the last 1 hour.
     * In-process approximation (per-instance when meta scales out — sufficient to prevent flooding). Returns true = allowed and recorded.
     */
    private readonly stateShareRate = new Map<string, number[]>();
    private allowStateShare(accountId: string, now: number): boolean {
      const win = this.stateShareRate.get(accountId)?.filter((t) => now - t < 3_600_000) ?? [];
      if (win.length >= STATE_REPLAY_SHARE_PER_HOUR) {
        this.stateShareRate.set(accountId, win);
        return false;
      }
      win.push(now);
      this.stateShareRate.set(accountId, win);
      return true;
    }

    async getSave(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.deps;
      await getOrCreateSave(cols, accountId, now()); // ensure save document exists
      // Also reconcile + refresh wallet mirror (when commercial is available): re-deliver orders left from crashes + pull authoritative balance/pity into the mirror.
      if (commercial.available) {
        try {
          await reconcileUndelivered(cols, commercial, accountId, now());
          const w = await commercial.getWallet(accountId);
          if (w) await mirrorWalletFrom(cols, accountId, w, now());
        } catch (e) {
          req.log.warn({ err: e }, 'commercial reconcile/mirror failed (serving local save)');
        }
      }
      let save = await getOrCreateSave(cols, accountId, now());
      // Lazy season migration (S11): if pvp.seasonNo is behind, settle previous-season rewards + soft-reset + update battle pass.
      try {
        const socialsvc = this.deps.socialsvc ?? nullMetaSocialsvcClient;
        const currentSeason = await getCurrentSeason(cols, now());
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
      // Stamina snapshot injection (A4): stamina is stored in a separate collection and merged into the save mirror on response.
      const stamina = await this.readStaminaSnapshot(accountId, now());
      save = { ...save, stamina };
      const displayName = await getDisplayName(cols, accountId);
      const publicId = await ensurePublicId(cols, accountId);
      // freeRename: the player still holds their one-time free rename (current name is a system default).
      const freeRename = await hasFreeRename(cols, accountId);
      return ok({
        save,
        publicId,
        freeRename,
        ...(displayName ? { displayName } : {}),
        ...this.gatewayField,
        ...(await this.activeMatchFieldFor(accountId)),
      });
    }

    async putSave(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const ifMatch = req.headers['if-match'];
      const clientRev = Number(Array.isArray(ifMatch) ? ifMatch[0] : ifMatch);
      if (!Number.isFinite(clientRev)) {
        return reply
          .code(400)
          .send(err(ErrorCode.BAD_REQUEST, 'If-Match header must be a numeric rev'));
      }
      const { save: patch } = req.body as { save: SyncPatch };
      const result = await putSave(
        this.deps.cols,
        accountId,
        clientRev,
        patch,
        this.deps.now(),
      );
      if (result.kind === 'conflict') {
        return reply.code(409).send({
          ok: false,
          error: { code: ErrorCode.REV_CONFLICT, message: 'rev conflict' },
          save: result.save,
        });
      }
      return ok({ save: result.save });
    }

    /** Recent match history (ranked / friendly): retrieves a concise summary from archived matches from the current account's perspective. */
    async getMatchHistory(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols } = this.deps;
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

    /** Retrieve the replay for a specific match (only matches the current account participated in); inline replay takes priority, large matches fall back to replayBlobs (S1-RP). */
    async getMatchReplay(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols } = this.deps;
      const roomId = (req.params as { roomId?: string }).roomId;
      if (!roomId) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
      }
      const doc = await cols.matches.findOne({ roomId });
      // Only matches the current account participated in can be retrieved (prevents unauthorized access to other players' replays).
      if (!doc || !doc.players.some((p) => p.accountId === accountId)) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
      }
      let replay = doc.replay;
      if (!replay && doc.replayRef) {
        const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
        replay = blob?.replay;
      }
      if (!replay) {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay unavailable'));
      }
      return ok({ replay });
    }

    /** S1-RP: Create a 7-day share link (shareId) for an existing Mongo replayBlob. */
    async createReplayShare(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { roomId } = req.params as { roomId: string };
      const { cols, now } = this.deps;
      const blob = await cols.replayBlobs.findOne({ _id: roomId });
      if (!blob) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
      const shareId = randomUUID();
      const expiresAt = new Date(now() + 7 * 24 * 60 * 60 * 1000);
      await cols.replayShares.insertOne({ _id: shareId, roomId, accountId, expiresAt, ts: now() });
      return ok({ shareId });
    }

    /** S1-RP: Retrieve a replay by shareId (no login required; automatically expires when the TTL elapses). */
    async getReplayByShare(req: FastifyRequest, reply: FastifyReply) {
      const { shareId } = req.params as { shareId: string };
      const { cols } = this.deps;
      const share = await cols.replayShares.findOne({ _id: shareId });
      if (!share) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
      const blob = await cols.replayBlobs.findOne({ _id: share.roomId });
      if (!blob) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
      return ok({ replay: blob.replay });
    }

    /**
     * State-stream replay out-of-game share — mint a share code (REPLAY_SHARE_DESIGN §3.1). The sharer must be logged in; the client-generated
     * state-stream blob is uploaded with the request. The server **does not touch the engine or stat tables** — it acts purely as access-controlled object storage:
     * validate size limit + per-account rate limit → write to DB → return an unguessable shareCode. State streams are **untrusted** and must never enter anti-cheat/settlement.
     */
    async createStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, now } = this.deps;
      const ts = now();

      if (!this.allowStateShare(accountId, ts)) {
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
      const { cols } = this.deps;
      const doc = await cols.stateReplayShares.findOne({ _id: shareCode });
      if (!doc) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
      // Increment view count (non-blocking, does not delay response).
      void cols.stateReplayShares.updateOne({ _id: shareCode }, { $inc: { viewCount: 1 } });
      return ok({ blob: doc.blob });
    }
  };
}
