// Reputation-decay daily sweep (CONTENT_MODERATION_DESIGN.md CM8/CM8.1): a penalized account (score < 100)
// recovers +10 every 30 days it goes without a new penalty, entirely server-driven — no player action
// required. Mirrors coinAnomalyAudit.ts's orchestration style (bounded batch, idempotent, safe to re-run).
import type { Collections } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:reputation-decay');

const DECAY_AMOUNT = 10;
const DECAY_INTERVAL_MS = 30 * 24 * 3600 * 1000;
const REV_RETRIES = 3;

/**
 * Heals a single account's reputationScore by DECAY_AMOUNT, guarded by the same `flags.moderationRev`
 * optimistic lock as moderation.ts's applyPenalty (audit-followup-fixes-0730): a fresh read on every
 * attempt means a penalty landing concurrently on this account is never silently overwritten by a decay
 * tick computed from stale data, and — since applyPenalty always resets reputationDecayAt on any fresh
 * penalty — a conflict here also re-checks whether decay is still actually due before retrying, since the
 * concurrent write may have just pushed the account's decay clock back out to 30 days from now.
 */
async function decayOneAccount(cols: Collections, accountId: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.accounts.findOne(
      { _id: accountId },
      { projection: { 'flags.reputationScore': 1, 'flags.reputationDecayAt': 1, 'flags.moderationRev': 1 } },
    );
    if (!doc) return false;
    const decayAt = doc.flags?.reputationDecayAt;
    if (decayAt === undefined || decayAt > now) return false; // no longer due — a concurrent write already reset/cleared it

    const current = doc.flags?.reputationScore ?? 100;
    const healed = Math.min(100, current + DECAY_AMOUNT);
    const moderationRev = doc.flags?.moderationRev ?? 0;
    const set: Record<string, unknown> = {
      'flags.reputationScore': healed,
      'flags.moderationRev': moderationRev + 1,
    };
    const update: Record<string, unknown> = healed >= 100
      ? { $set: set, $unset: { 'flags.reputationDecayAt': '' } }
      : { $set: { ...set, 'flags.reputationDecayAt': now + DECAY_INTERVAL_MS } };

    const res = await cols.accounts.updateOne(
      { _id: accountId, 'flags.moderationRev': doc.flags?.moderationRev ?? null },
      update,
    );
    if (res.matchedCount > 0) return true;
    // moderationRev conflict (concurrent penalty/decay against the same account) → re-read and retry
  }
  return false; // retries exhausted under extreme contention — still due, picked up on the next daily tick
}

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
    .find({ 'flags.reputationDecayAt': { $lte: now } }, { projection: { _id: 1 }, limit: batchLimit })
    .toArray();
  result.scanned = due.length;

  for (const doc of due) {
    try {
      if (await decayOneAccount(cols, doc._id, now)) result.healed++;
    } catch (e) {
      log.error('reputation decay write failed', { accountId: doc._id, err: (e as Error).message });
    }
  }
  return result;
}
