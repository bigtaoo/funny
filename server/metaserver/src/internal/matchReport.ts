// End-of-match settlement (M19): gameserver reports the result here; meta reconciles, settles ranked ELO
// (including Phase C peer-judge adjudication on hash mismatch), and archives the match + replay.
import type { FastifyInstance } from 'fastify';
import type { Collections, SaveDoc, SaveData, MatchDoc, MatchReplayDoc } from '@nw/shared';
import {
  INITIAL_ELO,
  ELO_FLOOR,
  ELO_K,
  computeEloDelta,
  streakMultiplier,
  eloToRank,
  nextStreak,
  victoryCoinsForRank,
  createLogger,
  sanitizePvpReportedStats,
  accrueStats,
  computeFirstReachGrant,
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  xpToLevel,
  accrueRetentionTask,
  clearActiveMatch,
  decompressReplayDoc,
  type StatKey,
  type RankId,
} from '@nw/shared';
import { archiveMatch } from '../replayArchive.js';
import { getCurrentSeason, migrateIfStale } from '../ladderSeason.js';
import { writeMigratedSave } from '../save.js';
import type { GatewayClient } from '../gatewayClient.js';
import type { CommercialClient } from '../commercialClient.js';
import { adsDayKey } from '../economy.js';
import { getProfile } from '../accounts.js';
import { accrueEventTask } from '../events.js';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';
import type { InternalCtx } from './context.js';

const log = createLogger('meta:internal');

/**
 * Maximum byte size for the inline (already gzip-compressed) replay; if exceeded, it is stored
 * externally in replayBlobs + replayRef (keeps matches documents compact). Measured post-compression
 * (2026-07-20) — the constant value is unchanged (256KB) but it now bounds compressed bytes, not the
 * raw JSON frame log, so effectively far more raw replay content fits inline than before.
 */
const REPLAY_INLINE_MAX_BYTES = 256 * 1024;

/** Storage cleanup TTL for non-disputed matches (7 days — bots have only been live a week, so 30d bought no headroom; see MatchDoc.expireAt). */
const MATCH_RETENTION_MS = 7 * 24 * 3600 * 1000;

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
  /** base64(gzip(JSON.stringify(replayDoc))) — see @nw/shared replayCodec. Never decoded on the hot per-match path (M12); only judgeMismatch/anticheatAudit decompress it. */
  replay_gz: string;
}

export function registerMatchReportRoutes(app: FastifyInstance, ctx: InternalCtx): void {
  const { cols, authed, now, gateway, commercial, socialsvc, redis } = ctx;

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
    await cols.matches
      .insertOne(matchDoc)
      .catch((e) => {
        // Idempotency race: a unique-index conflict means a concurrent request already archived the match; ignore.
        if ((e as { code?: number }).code !== 11000) log.error('archive match failed', { err: (e as Error).message });
      });

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

  // ── GET /internal/pvp-card-stats (BALANCE P1) ──────────────────────────────
  // Aggregates pvpCardStats across days into per-card totals (optionally filtered by mode/since); admin call.
  app.get('/internal/pvp-card-stats', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
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

/** UTC day key (YYYYMMDD) for `PvpCardStatDoc.day` bucketing. */
function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * BALANCE data pipeline (P1): credit games/wins to every card in each side's deck. A card appearing multiple
 * times in a deck (shouldn't happen per PVP_LOADOUT_DESIGN's "each card at most once" rule, but de-duped
 * defensively) is only counted once per match per side.
 */
async function accruePvpCardStats(
  cols: Collections,
  ts: number,
  mode: string,
  winnerSide: number,
  replayGzBuf: Buffer,
): Promise<void> {
  const decks = decompressReplayDoc(replayGzBuf).decks;
  if (!decks) return;
  const day = utcDayKey(ts);
  const sides: { side: number; deck: string[] }[] = [
    { side: 0, deck: decks.top },
    { side: 1, deck: decks.bottom },
  ];
  const ops = [];
  for (const { side, deck } of sides) {
    const won = side === winnerSide;
    for (const cardId of new Set(deck)) {
      ops.push({
        updateOne: {
          filter: { _id: `${day}:${cardId}:${mode}` },
          update: {
            $setOnInsert: { day, cardId, mode },
            $inc: { games: 1, ...(won ? { wins: 1 } : {}) },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await cols.pvpCardStats.bulkWrite(ops);
}

/**
 * Peer judge (Phase C): sends the full match replay to gateway to pick a third-party headless re-computation, and determines which side is honest based on the judge's hash.
 * Returns { honest side, cheating side, judge accountId }; if the judge cannot adjudicate (no candidates / timeout / re-computation failure / result does not match either side) → null.
 */
async function judgeMismatch(
  gateway: GatewayClient,
  body: ReportBody,
  replayDoc: MatchReplayDoc,
): Promise<{
  honest: { side: number; accountId: string };
  cheater: { side: number; accountId: string };
  judgeAccountId?: string;
} | null> {
  if (body.results.length !== 2) return null;
  const verdict = await gateway.judge({
    seed: Number(body.seed),
    mode: 1, // RANKED (judge client re-computes as netplay; mode is audit-semantic only)
    endFrame: replayDoc.endFrame,
    // command bytes are already base64 (stored as `unknown` in MatchReplayDoc — BSON binary shape); coerce to string, passed through as-is otherwise.
    frames: replayDoc.frames.map((f) => ({
      frame: f.frame,
      cmds: f.cmds.map((c) => ({ side: c.side, commands: String(c.commands) })),
    })),
    exclude: body.players.map((p) => p.accountId),
    ...(replayDoc.decks ? { decks: replayDoc.decks } : {}),
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
  socialsvc: MetaSocialsvcClient,
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
  // Streak acceleration (ECONOMY_BALANCE.md §2.3): a player's own incoming win/loss streak scales
  // their side of the swing only — a hot winner rides their streak to a real bracket faster, a player
  // on a losing skid falls back to theirs faster, independent of the opponent's streak. Not zero-sum
  // by design (see computeEloDelta docstring).
  const wStreak = wDoc?.save.pvp.streak ?? 0;
  const lStreak = lDoc?.save.pvp.streak ?? 0;
  const winnerK = ELO_K * streakMultiplier(wStreak > 0 ? wStreak : 0);
  const loserK = ELO_K * streakMultiplier(lStreak < 0 ? -lStreak : 0);
  const { winner: wDelta, loser: lDelta } = computeEloDelta(wElo, lElo, { winnerK, loserK });
  const out: Record<number, EloResult> = {};
  const [wRes, lRes] = await Promise.all([
    applyPvp(cols, now, commercial, socialsvc, winner.accountId, wDoc, wDelta, true, winnerStats),
    applyPvp(cols, now, commercial, socialsvc, loser.accountId, lDoc, lDelta, false, loserStats),
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
  socialsvc: MetaSocialsvcClient,
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
      const mr = await migrateIfStale(cols, commercial, socialsvc, cur.save, currentSeason, now());
      if (mr.migrated) {
        // The migrated save must be persisted before the ELO update; otherwise the migration result is lost.
        const migrated = await writeMigratedSave(
          cols,
          mr.save,
          now(),
          (s) => migrateIfStale(cols, commercial, socialsvc, s, currentSeason, now()),
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
