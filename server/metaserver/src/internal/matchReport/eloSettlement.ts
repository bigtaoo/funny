// Split from matchReport.ts (2026-08-10, independent function module range 6, part 5/6).
// Two-sided ELO settlement (server-authoritative) — the heaviest piece of the original file.
import type { Collections, SaveDoc, SaveData } from '@nw/shared';
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
  accrueStats,
  computeFirstReachGrant,
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  xpToLevel,
  accrueRetentionTask,
  type StatKey,
  type RankId,
} from '@nw/shared';
import { getCurrentSeason, migrateIfStale } from '../../ladderSeason.js';
import { writeMigratedSave } from '../../save.js';
import type { CommercialClient } from '../../commercialClient.js';
import { adsDayKey } from '../../economy.js';
import type { MetaSocialsvcClient } from '../../socialsvcClient.js';
import type { EloResult } from './types.js';

const log = createLogger('meta:internal');

/** Two-sided ELO settlement: read scores → compute delta → atomically write saves.pvp for each player (optimistic-lock rev guard + retry). */
export async function settleElo(
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
