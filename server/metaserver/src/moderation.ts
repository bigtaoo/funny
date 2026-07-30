// Content-moderation enforcement (CONTENT_MODERATION_DESIGN.md CM6-CM8): the single execution path for
// reputation-score changes and their resulting mute/temp-ban/ban actions (extends the existing OPS
// principle "one ban execution path" — see internal/accountRoutes.ts's /internal/accounts/:id/ban).
// admin is the only caller (report resolution, future anti-cheat/other governance sources), never the
// reverse — this module owns the read-modify-write against `accounts`, admin just supplies a delta.
import type { Collections } from '@nw/shared';

export type PenaltyAction = 'none' | 'warn' | 'mute' | 'tempban' | 'ban';

const MUTE_DURATION_MS = 24 * 3600 * 1000;
const TEMP_BAN_DURATION_MS = 7 * 24 * 3600 * 1000;
const REPUTATION_DECAY_INTERVAL_MS = 30 * 24 * 3600 * 1000;

/** §4.2 threshold table (user-confirmed 2026-07-29): the action for a given post-delta reputationScore. */
export function actionForScore(score: number): PenaltyAction {
  if (score <= 20) return 'ban';
  if (score <= 40) return 'tempban';
  if (score <= 60) return 'mute';
  if (score <= 80) return 'warn';
  return 'none';
}

export interface PenaltyResult {
  reputationScore: number;
  action: PenaltyAction;
  mutedUntil?: number;
  bannedUntil?: number;
  banned?: boolean;
}

/** Thrown when the optimistic-lock retry loop below is exhausted (extreme contention on one account's
 *  moderation flags). Callers should surface this as a retryable error, not "account not found". */
export class ModerationConflictError extends Error {
  constructor() {
    super('moderation write conflict, retry');
  }
}

// Higher than the REV_RETRIES=3 convention used by equipment.ts/cards.ts: those guard a single player's own
// action against at most one realistic concurrent racer (their own double-tap/retry). Here every one of N
// concurrent writers (multiple reports resolving at once, a decay tick landing mid-burst) is expected to
// eventually succeed rather than one winner + N-1 well-defined losers, so a writer can legitimately need up
// to N-1 retries in the worst ordering. Retries are cheap same-document reads; 8 comfortably covers a burst
// of several simultaneous penalties against one account without masking genuine, sustained contention.
const REV_RETRIES = 8;

/**
 * Apply a reputation delta (negative for a confirmed report) and return the resulting enforcement
 * state. Read-modify-write against `accounts` + accountCache invalidation happen here so every caller
 * (report resolution today, any future governance source) goes through the exact same path.
 *
 * "Only ever escalates, never downgrades" (CM6): an existing harsher mutedUntil/bannedUntil is never
 * shortened by a later, milder-tier penalty — we always keep the max of existing vs. newly-computed
 * expiry. A permanent ban, once set, is never cleared by this function (only admin unban / an approved
 * appeal clears it).
 *
 * Guarded by `flags.moderationRev` (optimistic lock, same technique as SaveDoc.rev elsewhere in this
 * file's siblings): two concurrent penalties against the same account (or a penalty racing the daily
 * decay sweep) both read a consistent snapshot, but only one write wins per rev; the loser re-reads the
 * post-write state and recomputes on top of it instead of clobbering it with a stale computation.
 */
export async function applyPenalty(
  cols: Collections,
  accountId: string,
  delta: number,
  now: number,
): Promise<PenaltyResult | null> {
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1 } });
    if (!doc) return null;

    const moderationRev = doc.flags?.moderationRev ?? 0;
    const currentScore = doc.flags?.reputationScore ?? 100;
    const reputationScore = Math.max(0, Math.min(100, currentScore + delta));
    const action = actionForScore(reputationScore);

    const set: Record<string, unknown> = {
      'flags.reputationScore': reputationScore,
      'flags.moderationRev': moderationRev + 1,
    };
    const result: PenaltyResult = { reputationScore, action };

    if (doc.flags?.banned) {
      // Already permanently banned — stays banned regardless of this penalty's own tier (never downgraded).
      result.banned = true;
    } else if (action === 'ban') {
      set['flags.banned'] = true;
      result.banned = true;
    } else if (action === 'tempban') {
      const bannedUntil = Math.max(doc.flags?.bannedUntil ?? 0, now + TEMP_BAN_DURATION_MS);
      set['flags.bannedUntil'] = bannedUntil;
      result.bannedUntil = bannedUntil;
    } else if (action === 'mute') {
      const mutedUntil = Math.max(doc.flags?.mutedUntil ?? 0, now + MUTE_DURATION_MS);
      set['flags.mutedUntil'] = mutedUntil;
      result.mutedUntil = mutedUntil;
    }
    // 'warn' and 'none' add no restriction fields — but an existing restriction from a prior, harsher
    // penalty is untouched (we never $unset here), matching the "never downgrade" rule.

    // Reputation heals over time (CM8/CM8.1): a fresh penalty always restarts the 30-day decay clock,
    // since decay is "time since last penalty", not "time since account creation".
    if (reputationScore < 100) {
      set['flags.reputationDecayAt'] = now + REPUTATION_DECAY_INTERVAL_MS;
    }

    const res = await cols.accounts.updateOne(
      { _id: accountId, 'flags.moderationRev': doc.flags?.moderationRev ?? null },
      { $set: set },
    );
    if (res.matchedCount > 0) return result;
    // moderationRev conflict (concurrent penalty/decay against the same account) → re-read and retry
  }
  throw new ModerationConflictError();
}
