// Reputation-decay daily sweep (CONTENT_MODERATION_DESIGN.md CM8/CM8.1): a penalized account (score < 100)
// recovers +10 every 30 days it goes without a new penalty, entirely server-driven — no player action
// required. Mirrors coinAnomalyAudit.ts's orchestration style (bounded batch, idempotent, safe to re-run).
import type { Collections } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:reputation-decay');

const DECAY_AMOUNT = 10;
const DECAY_INTERVAL_MS = 30 * 24 * 3600 * 1000;

export interface ReputationDecayDeps {
  cols: Collections;
  now: () => number;
  /** Max accounts processed per tick (default 1000) — bounds a single sweep's write volume; a batch
   *  larger than this is picked up on the next daily tick, it isn't dropped. */
  batchLimit?: number;
}

export interface ReputationDecayResult {
  /** Accounts whose flags.reputationDecayAt was due (<= now) this tick. */
  scanned: number;
  /** Accounts actually healed (+10, capped at 100). */
  healed: number;
}

/**
 * Scans accounts due for a decay tick (flags.reputationDecayAt <= now, via the partial index on that
 * field — see shared/src/mongo.ts ensureIndexes) and applies +10 (capped at 100) to each. An account
 * that reaches 100 has reputationDecayAt cleared (fully healed, nothing left to scan for); one still
 * below 100 gets reputationDecayAt pushed to now + 30d for its next tick.
 */
export async function decayReputationOnce(deps: ReputationDecayDeps): Promise<ReputationDecayResult> {
  const { cols } = deps;
  const now = deps.now();
  const batchLimit = deps.batchLimit ?? 1000;
  const result: ReputationDecayResult = { scanned: 0, healed: 0 };

  const due = await cols.accounts
    .find(
      { 'flags.reputationDecayAt': { $lte: now } },
      { projection: { 'flags.reputationScore': 1, 'flags.reputationDecayAt': 1 }, limit: batchLimit },
    )
    .toArray();
  result.scanned = due.length;

  for (const doc of due) {
    const current = doc.flags?.reputationScore ?? 100;
    const healed = Math.min(100, current + DECAY_AMOUNT);
    try {
      if (healed >= 100) {
        await cols.accounts.updateOne(
          { _id: doc._id },
          { $set: { 'flags.reputationScore': 100 }, $unset: { 'flags.reputationDecayAt': '' } },
        );
      } else {
        await cols.accounts.updateOne(
          { _id: doc._id },
          { $set: { 'flags.reputationScore': healed, 'flags.reputationDecayAt': now + DECAY_INTERVAL_MS } },
        );
      }
      result.healed++;
    } catch (e) {
      log.error('reputation decay write failed', { accountId: doc._id, err: (e as Error).message });
    }
  }
  return result;
}
