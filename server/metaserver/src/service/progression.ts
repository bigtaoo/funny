// S11 season ladder leaderboard + battle pass.
// getLeaderboard serves the Top-100 from a 60s process cache (per-caller `me` standing recomputed live);
// buy/claim battle pass are optimistic-locked writes with commercial coin delivery.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  err,
  ok,
  BATTLEPASS_BUY_COST,
  makeFreshBattlePass,
  claimBpReward,
  BOT_ELO_K,
  BOT_ELO_THRESHOLD,
  ELO_FLOOR,
  computeEloDelta,
  eloToRank,
  accrueRetentionTask,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { getCurrentSeason } from '../ladderSeason.js';
import { mirrorCoins } from '../economy.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

/** Minimum gap between two accepted bot-result reports per account — backstops the 30s bot-fallback queue timeout against scripted spam. */
const BOT_RESULT_MIN_GAP_MS = 15_000;

type ProgressionHandlers = Pick<MetaHandlers, 'getLeaderboard' | 'buyBattlePass' | 'claimBattlePass' | 'submitBotResult'>;

/** One row of the season Top-100 leaderboard (SE-5). */
interface LeaderboardEntry {
  rank: number;
  displayName: string;
  publicId: string;
  elo: number;
  pvpRank: string;
  equippedTitle?: string;
}

const LEADERBOARD_CACHE_MS = 60 * 1000;

export function ProgressionMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<ProgressionHandlers> {
  return class extends Base {
    /**
     * SE-5: 60s in-process cache of the season Top-100 (the `entries` array only — the per-caller `me`
     * standing is always recomputed live). Keyed by seasonNo so a season roll implicitly invalidates it.
     * When meta scales out this becomes a per-instance approximation; readers tolerate a leaderboard up to
     * 60s stale, so cache incoherence across instances is acceptable. SEASON_DESIGN §5. */
    private leaderboardCache: { seasonNo: number; expiresAt: number; entries: LeaderboardEntry[] } | null = null;

    /**
     * Build the season Top-100 (ELO descending) with display name + equipped title joined.
     * Pure read — no per-caller state — so the result is safely shared across callers via the 60s cache.
     */
    private async buildLeaderboardTop100(seasonNo: number): Promise<LeaderboardEntry[]> {
      const { cols } = this.deps;
      const top = await cols.saves
        .find({ 'save.pvp.seasonNo': seasonNo })
        .sort({ 'save.pvp.elo': -1 })
        .limit(100)
        .project({ _id: 1, 'save.pvp': 1, 'save.equipped': 1 })
        .toArray();
      const accountIds = top.map((d) => d._id);
      const accounts = await cols.accounts
        .find({ _id: { $in: accountIds } }, { projection: { _id: 1, displayName: 1, publicId: 1 } })
        .toArray();
      const byId = new Map(accounts.map((a) => [a._id, a]));
      return top.map((d, i) => {
        const a = byId.get(d._id);
        const pvp = (d as unknown as { save: { pvp: { elo: number; rank: string }; equipped?: Record<string, string> } }).save.pvp;
        const equipped = (d as unknown as { save: { equipped?: Record<string, string> } }).save.equipped;
        const equippedTitle = equipped?.['title'];
        return {
          rank: i + 1,
          displayName: a?.displayName ?? '',
          publicId: a?.publicId ?? '',
          elo: pvp.elo,
          pvpRank: pvp.rank,
          ...(equippedTitle ? { equippedTitle } : {}),
        };
      });
    }

    /** Top-100 ladder leaderboard (current season ELO descending, S11 §5). Top-100 is served from a 60s process cache; the caller's own `me` standing is always recomputed live. */
    async getLeaderboard(req: FastifyRequest) {
      const { cols, now } = this.deps;
      const season = await getCurrentSeason(cols, now());

      // SE-5: reuse the cached Top-100 when it is for this season and still fresh; otherwise rebuild + cache.
      const t = now();
      const cached = this.leaderboardCache;
      let entries: LeaderboardEntry[];
      if (cached && cached.seasonNo === season.seasonNo && cached.expiresAt > t) {
        entries = cached.entries;
      } else {
        entries = await this.buildLeaderboardTop100(season.seasonNo);
        this.leaderboardCache = { seasonNo: season.seasonNo, expiresAt: t + LEADERBOARD_CACHE_MS, entries };
      }

      // Caller's own standing (may be outside the Top-100). Rank = # of players with strictly
      // higher ELO this season + 1. Absent when the caller has not played this season.
      let me: { rank: number; elo: number; pvpRank: string } | undefined;
      const accountId = accountIdOf(req);
      const mine = await cols.saves.findOne(
        { _id: accountId, 'save.pvp.seasonNo': season.seasonNo },
        { projection: { 'save.pvp': 1 } },
      );
      const myPvp = (mine as unknown as { save?: { pvp?: { elo: number; rank: string } } } | null)?.save?.pvp;
      if (myPvp) {
        const higher = await cols.saves.countDocuments({
          'save.pvp.seasonNo': season.seasonNo,
          'save.pvp.elo': { $gt: myPvp.elo },
        });
        me = { rank: higher + 1, elo: myPvp.elo, pvpRank: myPvp.rank };
      }

      return ok({ seasonNo: season.seasonNo, entries, ...(me ? { me } : {}) });
    }

    /** Purchase the current season's battle pass (600 coins, S11 §9). */
    async buyBattlePass(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.deps;

      // Confirm/create battle pass data first (lazy creation: initialized on first purchase this season).
      const save = await getOrCreateSave(cols, accountId, now());
      const currentSeason = await getCurrentSeason(cols, now());
      let bp = save.battlePass?.seasonNo === currentSeason.seasonNo
        ? save.battlePass
        : makeFreshBattlePass(currentSeason.seasonNo);
      if (bp.hasPass) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'battle pass already purchased'));
      }

      const orderId = randomUUID();
      const charge = await commercial.spend({ accountId, amount: BATTLEPASS_BUY_COST, reason: 'battlepass', orderId });
      if (!charge.ok) {
        if (charge.error === 'INSUFFICIENT_FUNDS') {
          return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
      }

      // Atomically write hasPass=true (optimistic lock).
      const out = await this.mutateSave(accountId, (s) => {
        const curBp = s.battlePass?.seasonNo === currentSeason.seasonNo
          ? s.battlePass
          : makeFreshBattlePass(currentSeason.seasonNo);
        if (curBp.hasPass) return 'ALREADY_PURCHASED';
        return { ...s, battlePass: { ...curBp, hasPass: true } };
      });
      if ('error' in out) {
        if (out.error === 'ALREADY_PURCHASED') {
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'battle pass already purchased'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      bp = out.save.battlePass!;
      const finalSave = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
      return ok({ battlePass: { ...bp, ...finalSave.battlePass } });
    }

    /** Claim a battle pass reward (free track or paid track, S11 §9). */
    async claimBattlePass(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { track, level } = req.body as { track: 'free' | 'paid'; level: number };
      const { cols, commercial, now } = this.deps;

      // Atomic validate + record claim (optimistic lock prevents double-tap). Material rewards are written to save.materials in the same transaction.
      let claimedReward: { kind: string; count: number } | null = null;
      const out = await this.mutateSave(accountId, (s) => {
        const bp = s.battlePass;
        if (!bp) return 'NO_BATTLEPASS';
        const r = claimBpReward(bp, track, level);
        if (!r.ok) return r.error;
        claimedReward = r.reward;
        const next = { ...s, battlePass: r.bp };
        if (r.reward.kind === 'material' && r.reward.id && r.reward.count > 0) {
          next.materials = { ...s.materials, [r.reward.id]: (s.materials[r.reward.id] ?? 0) + r.reward.count };
        }
        return next;
      });
      if ('error' in out) {
        switch (out.error) {
          case 'NO_BATTLEPASS':
          case 'BAD_REQUEST':
            return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'bad request'));
          case 'NOT_REACHED':
            return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level not reached'));
          case 'PASS_REQUIRED':
            return reply.code(403).send(err(ErrorCode.NOT_FOUND, 'battle pass not purchased'));
          case 'ALREADY_CLAIMED':
            return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
          default:
            return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
        }
      }
      const reward = claimedReward!;
      let finalSave = out.save;
      // If the reward includes coins, mirror the wallet after delivery via commercial.
      if (reward.kind === 'coins' && reward.count > 0 && commercial.available) {
        try {
          const orderId = `bp.claim.${accountId}.${track}.${level}`;
          const g = await commercial.grant({ accountId, amount: reward.count, reason: 'battlepass_claim', orderId });
          if (g.ok) finalSave = await mirrorCoins(cols, accountId, g.coinsAfter, now());
        } catch (e) {
          req.log.warn({ err: e }, 'battlepass claim coin grant failed (coins may be delayed)');
        }
      }
      return ok({ battlePass: finalSave.battlePass!, reward });
    }

    /**
     * Report the outcome of a client-local AI-fallback (bot) match (MATCHSVC_DESIGN §match_bot_fallback:
     * matchmaking timed out with no human opponent, so no gameserver session / room_id exists to settle
     * through /internal/match/report). Always credits the 'pvp.match' daily task; ELO only moves while
     * the caller is below BOT_ELO_THRESHOLD, at a quarter of ranked K (BOT_ELO_K), throttled to one
     * accepted result per BOT_RESULT_MIN_GAP_MS so scripted spam can't out-pace the real 30s queue timeout.
     */
    async submitBotResult(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { won } = req.body as { won: boolean };
      const { now } = this.deps;

      let appliedDelta = 0;
      let resultElo = 0;
      let resultRank = '';
      const out = await this.mutateSave(accountId, (s) => {
        const pvp = s.pvp;
        const tsNow = now();
        const nextRetention = accrueRetentionTask(s.retention, 'pvp.match', tsNow);
        const onCooldown = pvp.lastBotResultAt !== undefined && tsNow - pvp.lastBotResultAt < BOT_RESULT_MIN_GAP_MS;
        let elo = pvp.elo;
        let rank = pvp.rank;
        let lastBotResultAt = pvp.lastBotResultAt;
        if (!onCooldown && pvp.elo < BOT_ELO_THRESHOLD) {
          const { winner, loser } = computeEloDelta(pvp.elo, pvp.elo, { winnerK: BOT_ELO_K, loserK: BOT_ELO_K });
          const after = Math.max(ELO_FLOOR, pvp.elo + (won ? winner : loser));
          appliedDelta = after - pvp.elo;
          elo = after;
          rank = eloToRank(after);
          lastBotResultAt = tsNow;
        }
        resultElo = elo;
        resultRank = rank;
        return {
          ...s,
          ...(nextRetention !== s.retention ? { retention: nextRetention } : {}),
          pvp: { ...pvp, elo, rank, lastBotResultAt },
        };
      });
      if ('error' in out) {
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ elo: resultElo, rank: resultRank, delta: appliedDelta });
    }
  };
}
