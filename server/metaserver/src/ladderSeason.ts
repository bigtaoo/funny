// Ladder season service (S11, SEASON_DESIGN.md §3-4).
// Lazy season clock creation, lazy migration (migrateIfStale), and season settlement (settleSeasonForPlayer).
import type { Collections, SaveData, SaveDoc } from '@nw/shared';
import {
  SEASON_DURATION_MS,
  SEASON_RESET_BASELINE,
  softReset,
  seasonPeakCoins,
  makePvpSeasonDefaults,
  eloToRank,
  pendingBpRewards,
  makeFreshBattlePass,
  ladderTitleId,
  type LadderSeasonDoc,
  type RankId,
  createLogger,
} from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { insertSystemMail } from './mail.js';
import { grantTitleToPlayer } from './titles.js';
import type { MetaSocialsvcClient } from './socialsvcClient.js';

const log = createLogger('meta:ladderSeason');

/** Retention days for season settlement reward mail. */
const SETTLE_MAIL_EXPIRE_DAYS = 30;

// ── Season clock ─────────────────────────────────────────────────────────────

/**
 * Read the current season document, lazily creating season #1 if it does not exist.
 * All season entry points go through this function to ensure the global singleton document exists.
 */
export async function getCurrentSeason(
  cols: Collections,
  now: number,
): Promise<LadderSeasonDoc> {
  const doc = await cols.ladderSeasons.findOne({ _id: 'current' });
  if (doc) return doc;
  // First boot: lazily create season #1
  const fresh: LadderSeasonDoc = {
    _id: 'current',
    seasonNo: 1,
    startAt: now,
    endAt: now + SEASON_DURATION_MS,
    state: 'active',
  };
  await cols.ladderSeasons.updateOne(
    { _id: 'current' },
    { $setOnInsert: fresh },
    { upsert: true },
  );
  return (await cols.ladderSeasons.findOne({ _id: 'current' })) ?? fresh;
}

/**
 * Close the current season and open the next one (triggered manually by admin, `POST /admin/ladder/season/roll`).
 * Closed-loop (L2-1): after CAS transitions to settling, proactively settle all participants of the previous season
 * (send rank reward mail + grant season titles + write settlement snapshots), then advance the season clock.
 * This eliminates the broken flow where players who never return miss their season rewards.
 *
 * CAS idempotency: only advances when state='active' (guards against concurrent double-clicks by ops).
 * Settlement itself is triple-idempotent via settleSeasonParticipants and is safe to run alongside lazy migration without double-issuing.
 * @returns The new season document; returns the current document if already settling or not found.
 */
export async function rollSeason(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  now: number,
): Promise<LadderSeasonDoc> {
  // CAS: only advance when state=active
  const res = await cols.ladderSeasons.findOneAndUpdate(
    { _id: 'current', state: 'active' },
    { $set: { state: 'settling' } },
    { returnDocument: 'before' },
  );
  if (!res) {
    // Already settling or not found → return current state directly
    return getCurrentSeason(cols, now);
  }
  const prev = res;

  // Closed-loop settlement: settle all participants of the previous season before advancing the clock
  // (idempotent; a single-player failure is logged internally and does not block the roll —
  // any missed players are lazily re-settled by migrateIfStale when they return, also idempotent).
  await settleSeasonParticipants(cols, commercial, socialsvc, prev.seasonNo, now).catch((e) =>
    log.error('rollSeason: settle participants failed', { seasonNo: prev.seasonNo, err: (e as Error).message }),
  );

  const newDoc: LadderSeasonDoc = {
    _id: 'current',
    seasonNo: prev.seasonNo + 1,
    startAt: now,
    endAt: now + SEASON_DURATION_MS,
    state: 'active',
  };
  await cols.ladderSeasons.replaceOne({ _id: 'current' }, newDoc);
  log.info('ladder season rolled', { from: prev.seasonNo, to: newDoc.seasonNo });
  return newDoc;
}

// ── Season settlement (lazy; issued at most once per migration) ───────────────

/**
 * Issue the "previous season peak reward" to a single player via system mail (async, ceremonial, auditable).
 * Idempotent: dispatchKey = `ladder.season.${prevSeasonNo}.${accountId}` deduplicates.
 * Rank title (S10): idempotently granted via grantTitleToPlayer (see call below, best-effort).
 * Also backfills unclaimed battle pass rewards (§9, S6 lenient).
 */
export async function settleSeasonForPlayer(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  accountId: string,
  save: SaveData,
  prevSeasonNo: number,
  now: number,
): Promise<SeasonSettleSummary> {
  const peakRank = (save.pvp.seasonPeakRank ?? eloToRank(save.pvp.seasonPeakElo ?? save.pvp.elo)) as RankId;
  const peakElo = save.pvp.seasonPeakElo ?? save.pvp.elo;
  const coins = seasonPeakCoins(peakRank);
  const titleId = ladderTitleId(prevSeasonNo, peakRank);

  // Battle pass backfill (lenient, S6: earned but unclaimed rewards are not forfeited)
  const bpPending = save.battlePass ? pendingBpRewards(save.battlePass) : [];
  const bpCoins = bpPending
    .filter((r) => r.reward.kind === 'coins')
    .reduce((s, r) => s + r.reward.count, 0);
  const totalCoins = coins + bpCoins;

  // Grant the season rank title (S10, idempotent, best-effort)
  await grantTitleToPlayer(cols, accountId, titleId, now).catch((e) =>
    log.error('settleSeasonForPlayer: grantTitle failed', { accountId, prevSeasonNo, peakRank, err: (e as Error).message }),
  );

  if (totalCoins <= 0) {
    log.info('settleSeasonForPlayer: no coin reward', { accountId, prevSeasonNo, peakRank });
    return { peakRank, peakElo, coins: 0, titleId };
  }

  // Via mail: async delivery; player receives a notification with ceremony on next login
  const dispatchKey = `ladder.season.${prevSeasonNo}.${accountId}`;
  await insertSystemMail(
    socialsvc,
    dispatchKey,
    accountId,
    {
      subject: `mail.season.settle.subject`,
      body: `mail.season.settle.body`,
      attachments: [{ kind: 'coins', count: totalCoins }],
      expireDays: SETTLE_MAIL_EXPIRE_DAYS,
    },
  );
  log.info('settleSeasonForPlayer: mail sent', {
    accountId,
    prevSeasonNo,
    peakRank,
    coins,
    bpCoins,
    totalCoins,
  });
  return { peakRank, peakElo, coins: totalCoins, titleId };
}

/** Per-player season settlement summary (used for snapshot writes + statistics). */
export interface SeasonSettleSummary {
  peakRank: RankId;
  peakElo: number;
  /** Actual coins granted (peak reward + battle pass backfill; 0 = title granted only, no coins). */
  coins: number;
  titleId: string;
}

/**
 * Season close closed-loop (L2-1): proactively settle all participants of the just-closed season `seasonNo`.
 * Shares settleSeasonForPlayer with lazy migration (migrateIfStale), ensuring the "proactive batch" and
 * "settle on player return" paths are fully idempotent (triple dedup: settlement mail dispatchKey +
 * title $addToSet + snapshot _id; closing the same season twice never double-issues rewards).
 * Fixes the broken flow: rewards are no longer contingent on players logging in; all participants are settled at season end.
 *
 * **No soft reset here**: soft ELO reset and battle pass reset are still lazily executed by migrateIfStale
 * on the player's next pvp read/write (batch-rewriting the entire saves collection at season end is high-risk
 * and unnecessary — settlement is read-only + writes mail/title/snapshot; player ELO is migrated on return, idempotent).
 */
export async function settleSeasonParticipants(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  seasonNo: number,
  now: number,
): Promise<{ settled: number; rewarded: number }> {
  let settled = 0;
  let rewarded = 0;
  const cursor = cols.saves.find({ 'save.pvp.seasonNo': seasonNo });
  for await (const doc of cursor) {
    try {
      const summary = await settleSeasonForPlayer(cols, commercial, socialsvc, doc._id, doc.save, seasonNo, now);
      settled++;
      if (summary.coins > 0) rewarded++;
      // Snapshot doubles as idempotency ledger: composite _id key; $setOnInsert ensures closing the same season twice never overwrites an existing settlement record.
      await cols.ladderSeasonSnapshots.updateOne(
        { _id: `${seasonNo}:${doc._id}` },
        {
          $setOnInsert: {
            _id: `${seasonNo}:${doc._id}`,
            seasonNo,
            accountId: doc._id,
            peakElo: summary.peakElo,
            peakRank: summary.peakRank,
            coins: summary.coins,
            titleId: summary.titleId,
            ts: now,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      log.error('settleSeasonParticipants: player settle failed', {
        accountId: doc._id,
        seasonNo,
        err: (e as Error).message,
      });
    }
  }
  log.info('settleSeasonParticipants done', { seasonNo, settled, rewarded });
  return { settled, rewarded };
}

// ── Lazy migration (core; called before every pvp read/write) ─────────────────

/**
 * Check whether save.pvp.seasonNo is behind currentSeason; if so:
 * 1. Settle previous season rewards (settleSeasonForPlayer)
 * 2. Soft-reset ELO
 * 3. Advance pvp.seasonNo
 * 4. Reset battle pass
 *
 * Returns whether a migration occurred and the updated save.
 * The **caller** is responsible for atomically persisting the next save (optimistic lock rev guard).
 */
export async function migrateIfStale(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  save: SaveData,
  currentSeason: LadderSeasonDoc,
  now: number,
): Promise<{ migrated: boolean; save: SaveData }> {
  const pvpSeasonNo = save.pvp.seasonNo ?? 1;
  if (pvpSeasonNo >= currentSeason.seasonNo) {
    return { migrated: false, save };
  }

  // Issue previous season rewards (best-effort; failure does not block migration; idempotent mail key guards on re-entry)
  try {
    await settleSeasonForPlayer(cols, commercial, socialsvc, save.accountId, save, pvpSeasonNo, now);
  } catch (e) {
    log.error('settleSeasonForPlayer failed', {
      accountId: save.accountId,
      err: (e as Error).message,
    });
  }

  const newElo = softReset(save.pvp.elo, SEASON_RESET_BASELINE);
  const newRank = eloToRank(newElo) as RankId;
  const defaults = makePvpSeasonDefaults(currentSeason.seasonNo, newElo);

  // Reset battle pass (backfill was already handled in settleSeasonForPlayer)
  const newBp = makeFreshBattlePass(currentSeason.seasonNo);

  const next: SaveData = {
    ...save,
    pvp: {
      ...save.pvp,
      elo: newElo,
      rank: newRank,
      streak: 0,          // Win streak resets across seasons
      ...defaults,
    },
    battlePass: newBp,
  };

  log.info('pvp migrated', {
    accountId: save.accountId,
    from: pvpSeasonNo,
    to: currentSeason.seasonNo,
    eloFrom: save.pvp.elo,
    eloAfter: newElo,
  });
  return { migrated: true, save: next };
}
