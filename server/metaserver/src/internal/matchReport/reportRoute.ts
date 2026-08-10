// Split from matchReport.ts (2026-08-10, independent function module range 6, part 6/6a).
// The heavyweight POST /internal/match/report handler — idempotent settlement reservation,
// ranked ELO settlement / Phase C peer-judge adjudication, then archive to matches/replayBlobs.
import type { FastifyInstance } from 'fastify';
import type { MatchDoc, StatKey } from '@nw/shared';
import { createLogger, clearActiveMatch, decompressReplayDoc } from '@nw/shared';
import { archiveMatch } from '../../replayArchive.js';
import { getProfile } from '../../accounts.js';
import { accrueEventTask } from '../../events.js';
import type { InternalCtx } from '../context.js';
import { REPLAY_INLINE_MAX_BYTES, MATCH_RETENTION_MS, MATCH_SETTLING_TAKEOVER_MS, type EloResult, type ReportBody } from './types.js';
import { statDeltaForSide } from './statSanitize.js';
import { judgeMismatch } from './peerJudge.js';
import { accruePvpCardStats } from './cardStats.js';
import { settleElo } from './eloSettlement.js';

const log = createLogger('meta:internal');

export function registerReportRoute(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now, gateway, commercial, socialsvc, redis } = ctx;

  app.post('/internal/match/report', async (req, reply) => {
    if (!authed(req.headers)) {
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

    // Idempotency + double-settlement guard (comm-audit-internal-2026-07-28 P0-1).
    // The old shape was read-check → settle → insertOne: a gameserver retry arriving while the
    // first request was still inside settleElo (guaranteed before the 10s→35s timeout fix on
    // every hash-mismatch report, since the judge round-trip alone is up to 20s) missed the
    // findOne and settled a second time — the unique roomId index only stopped the final
    // archive write, not the ELO/coin credits that had already happened. Now we RESERVE the
    // roomId atomically (upsert on the unique index) before settling:
    //   - fresh upsert → we own the settlement;
    //   - reservation exists & younger than the takeover window → a settlement is in flight,
    //     return ok (the retry queue's job is persistence, not response payload — the elo-less
    //     match_over already went out when the first attempt timed out);
    //   - reservation exists & stale → the previous owner presumably crashed mid-settle; take
    //     over and settle (retries stay safe: takeover is itself an atomic guarded update);
    //   - full archive doc (settling absent) → already settled, plain idempotent return.
    // The placeholder uses mode '__settling__' so mode-filtered queries (audit sampling,
    // balance pipeline) never see it, and carries expireAt as a last-resort TTL for orphans.
    const reservation = await cols.matches.updateOne(
      { roomId: body.room_id },
      {
        $setOnInsert: {
          roomId: body.room_id,
          mode: '__settling__',
          seed: body.seed,
          players: [],
          winner: -1,
          reason: 'settling',
          hashOk: body.hash_ok,
          settling: true,
          settlingAt: now(),
          ts: now(),
          expireAt: new Date(now() + 60 * 60_000),
        },
      },
      { upsert: true },
    );
    if (reservation.upsertedCount === 0) {
      const existing = await cols.matches.findOne({ roomId: body.room_id }, { projection: { settling: 1, settlingAt: 1 } });
      if (!existing || !existing.settling) return reply.send({ ok: true }); // already archived
      const takeover = await cols.matches.updateOne(
        { roomId: body.room_id, settling: true, settlingAt: { $lt: now() - MATCH_SETTLING_TAKEOVER_MS } },
        { $set: { settlingAt: now() } },
      );
      if (takeover.modifiedCount === 0) {
        log.info('duplicate report while settlement in flight — deduped', { roomId: body.room_id });
        return reply.send({ ok: true });
      }
      log.warn('taking over stale settlement reservation', { roomId: body.room_id });
    }

    // Login-reconnect-prompt: the match is over one way or another (base/disconnect/mismatch) — clear
    // the cached resume ticket for every side so a later re-login no longer offers to resume it.
    // Best-effort: a failed clear just means a stale (TTL-bounded) entry lingers, not a broken report.
    void clearActiveMatch(redis, ...body.players.map((p) => p.accountId)).catch((e) =>
      log.warn('clearActiveMatch failed', { roomId: body.room_id, err: (e as Error).message }),
    );

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
          eloBySide = await settleElo(cols, now, commercial, socialsvc, winner, loser, wStats, lStats);
        } catch (e) {
          log.error('ranked ELO settle failed', { err: (e as Error).message });
        }
      }
    } else if (body.mode === 'ranked' && body.reason === 'mismatch' && gateway.available) {
      // Phase C peer judge: the two sides' hashes disagree → pick a third-party headless re-computation to adjudicate (rather than voiding directly).
      try {
        // Rare/periodic path — decompressing here (unlike the per-match write path below) is fine.
        const replayDoc = decompressReplayDoc(Buffer.from(body.replay_gz, 'base64'));
        const verdict = await judgeMismatch(gateway, body, replayDoc);
        if (verdict) {
          // A hash-mismatched match is already suspicious: do not accumulate either side's self-reported kill/cast (pvp.wins still counts for the honest side's win).
          eloBySide = await settleElo(cols, now, commercial, socialsvc, verdict.honest, verdict.cheater, {}, {});
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
    // Replay: already gzip-compressed by gameserver (replay_gz, base64) — stored verbatim as a Buffer
    // (Mongo driver maps it to BSON Binary automatically, no further encoding needed). Small matches
    // inline as `replayGz`; large ones (post-compression!) are stored externally in `replayBlobs` +
    // `replayRef` (keeps matches documents compact). Never decoded here (M12) — see REPLAY_INLINE_MAX_BYTES.
    const replayGzBuf = Buffer.from(body.replay_gz, 'base64');
    const inline = replayGzBuf.byteLength <= REPLAY_INLINE_MAX_BYTES;
    const hashMismatch = !body.hash_ok && !cheat;
    // Storage cleanup TTL: keep disputed matches (unresolved hash mismatch / peer-judge conviction) indefinitely
    // for ops review + anti-cheat audit trail; everything else auto-expires after MATCH_RETENTION_MS.
    const disputed = hashMismatch || !!cheat;
    const expireAt = disputed ? undefined : new Date(now() + MATCH_RETENTION_MS);
    if (!inline) {
      // Write the blob first (roomId upsert is idempotent); matches only stores the replayRef pointer.
      await cols.replayBlobs
        .updateOne(
          { _id: body.room_id },
          { $set: { _id: body.room_id, replayGz: replayGzBuf, ts: now(), ...(expireAt ? { expireAt } : {}) } },
          { upsert: true },
        )
        .catch((e) => log.error('archive replay blob failed', { err: (e as Error).message }));
    }
    const matchDoc: MatchDoc = {
      roomId: body.room_id,
      mode: body.mode,
      seed: body.seed,
      players: enrichedPlayers,
      winner: cheat ? body.players.find((p) => p.side !== cheat!.side)!.side : body.winner_side,
      reason: body.reason,
      hashOk: body.hash_ok,
      // C3: hash mismatch and peer judge did not intervene (no cheat verdict) → flag for admin review.
      ...(hashMismatch ? { hashMismatch: true } : {}),
      ...(inline ? { replayGz: replayGzBuf } : { replayRef: body.room_id }),
      ...(cheat ? { cheat } : {}),
      ...(reportedStats ? { reportedStats } : {}),
      ts: now(),
      ...(expireAt ? { expireAt } : {}),
    };
    // replaceOne (not insertOne): the reservation placeholder we upserted before settling is
    // sitting on this roomId — replacing it atomically clears `settling` and lands the real
    // archive doc in one step. upsert:true covers the takeover edge where the placeholder's
    // last-resort TTL fired mid-settlement.
    await cols.matches
      .replaceOne({ roomId: body.room_id }, matchDoc, { upsert: true })
      .catch((e) => log.error('archive match failed', { roomId: body.room_id, err: (e as Error).message }));

    // Cold-tier disk archive (2026-07-20, S1-RP): fire-and-forget, never awaited/blocking the response;
    // skips disputed matches (already kept indefinitely in Mongo). No-op if NW_REPLAY_ARCHIVE_DIR is unset.
    archiveMatch(matchDoc, replayGzBuf);

    // BALANCE data pipeline (P1): deck-composition win-rate counters, best-effort. Disputed matches (hashMismatch/cheat)
    // are excluded so they don't pollute the signal; only restricted-deck-pool matches carry decks. Decompressing
    // replayGzBuf here is the one exception to "never decode replay_gz on the hot path" (see ReportBody doc comment)
    // — safe because this whole block is fire-and-forget (unawaited), so it runs after the response is already sent.
    if (!disputed && body.winner_side >= 0) {
      accruePvpCardStats(cols, now(), body.mode, body.winner_side, replayGzBuf).catch((e) =>
        log.error('pvp card stats accrue failed', { roomId: body.room_id, err: (e as Error).message }),
      );
    }

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
}
