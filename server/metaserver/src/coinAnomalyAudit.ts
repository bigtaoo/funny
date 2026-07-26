// Coin-anomaly offline daily audit (COMMERCIAL_DESIGN §6.6, 2026-07-26): once a day, ask commercial which
// accounts gained more than COIN_ANOMALY_DAILY_THRESHOLD coins from non-recharge sources on the most recently
// completed UTC day, and file each into the OPS anti-cheat review queue (kind:'coin_anomaly') for human
// judgment — no automatic action. Mirrors anticheatAudit.ts's orchestration style (pure logic lives in
// @nw/shared where possible; this file only handles the DB/client plumbing).
import type { Collections, AntiCheatReviewDoc } from '@nw/shared';
import { makeDayKey, COIN_ANOMALY_DAILY_THRESHOLD } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:coin-anomaly-audit');

export interface CoinAnomalyAuditDeps {
  cols: Collections;
  commercial: CommercialClient;
  now: () => number;
  /** Coin gain threshold (default COIN_ANOMALY_DAILY_THRESHOLD); overridable for tests. */
  threshold?: number;
}

export interface CoinAnomalyAuditResult {
  dayKey: string;
  /** Accounts commercial reported as over threshold (before de-duplication against already-flagged accounts). */
  scanned: number;
  /** New review records actually filed (scanned minus accounts already flagged for this exact day). */
  flagged: number;
}

/**
 * Scans the most recently completed UTC day (yesterday relative to `now()`) for accounts whose non-recharge
 * coin gain crosses the threshold, filing a `coin_anomaly` review record for each. Idempotent: re-running
 * for a day already scanned skips accounts that already have an open-or-resolved record for that exact day
 * (`_id = coin:${accountId}:${dayKey}` is naturally unique).
 */
export async function auditCoinAnomaliesOnce(deps: CoinAnomalyAuditDeps): Promise<CoinAnomalyAuditResult> {
  const { cols, commercial, now } = deps;
  const threshold = deps.threshold ?? COIN_ANOMALY_DAILY_THRESHOLD;
  const dayKey = makeDayKey(now() - 24 * 3600 * 1000); // yesterday: the most recently fully-elapsed UTC day
  const result: CoinAnomalyAuditResult = { dayKey, scanned: 0, flagged: 0 };
  if (!commercial.available) return result;

  const accounts = await commercial.auditCoinGains(dayKey, threshold).catch((e) => {
    log.error('auditCoinGains failed', { dayKey, err: (e as Error).message });
    return [];
  });
  result.scanned = accounts.length;

  for (const a of accounts) {
    const publicId = await cols.accounts
      .findOne({ _id: a.accountId }, { projection: { publicId: 1 } })
      .then((d) => d?.publicId)
      .catch(() => undefined);
    const seed: AntiCheatReviewDoc = {
      _id: `coin:${a.accountId}:${dayKey}`,
      kind: 'coin_anomaly',
      accountId: a.accountId,
      ...(publicId ? { publicId } : {}),
      dayKey,
      nonRechargeGain: a.nonRechargeGain,
      threshold,
      status: 'open',
      ts: now(),
    };
    try {
      await cols.antiCheatReviews.insertOne(seed);
      result.flagged++;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) continue; // already flagged for this account+day
      log.error('coin anomaly review insert failed', { accountId: a.accountId, dayKey, err: (e as Error).message });
    }
  }
  return result;
}
