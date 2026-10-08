// Consent-free activity recording for the server retention report (retentionReport.ts, OPS analytics page
// "Server retention"). Legal basis: legitimate interest (GDPR Art 6(1)(f)) — the server already sees every
// authenticated request to run the game; all we keep is *which 24h windows since signup* the account was
// active in (`accounts.activeDays`, offsets 0..ACTIVITY_WINDOW_DAYS-1), nothing about what it did.
// The right to object is honoured: an account with `flags.gdprConsent === false` (player refused / turned
// analytics off) is never written to here, its activeDays are unset when it objects (accountLifecycle.ts),
// and the report never counts it.
//
// Hooked into bearerAuth (auth.ts makeSecurityHandlers' `onAuthenticated`), i.e. every authenticated
// metaserver request. Cost control:
//   · No prior read: one findOneAndUpdate whose filter carries every eligibility rule (age, consent,
//     not deleted/purged, not a bot) and whose pipeline $setUnion's the current offset into activeDays.
//     Its projected result hands back `createdAt`, so later requests compute the offset locally.
//   · In-memory dedupe: at most one write per account per offset per process. Entries are LRU-capped
//     (MAX_ENTRIES) — an evicted account just costs one extra idempotent write later.
//   · Fire-and-forget: never awaited by the request, never throws into it; failures log at debug.
//
// Known gap, accepted: if a player objects and then re-consents inside the same 24h window, this process
// still thinks that window was recorded and skips it until the next window.
import type { Collections } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:activity-days');

export const DAY_MS = 24 * 3600 * 1000;
/** activeDays holds offsets 0..ACTIVITY_WINDOW_DAYS-1 (D0..D30). Older accounts are no longer recorded. */
export const ACTIVITY_WINDOW_DAYS = 31;
/** botsvc's account pool logs in with deviceId `bot-0001`.. (botsvc/src/pool.ts); real clients use UUIDs. */
export const BOT_DEVICE_ID_PATTERN = /^bot-/;
const MAX_ENTRIES = 50_000;

/** Eligibility shared by the recorder's write filter and the retention report's $match. */
export function eligibleAccountFilter(): Record<string, unknown> {
  return {
    'flags.gdprConsent': { $ne: false },
    deletedAt: { $exists: false },
    purgedAt: { $exists: false },
    deviceId: { $not: BOT_DEVICE_ID_PATTERN },
  };
}

/** 24h-window index of `t` since `createdAt` (0 = the first 24h after signup). */
export function offsetOf(t: number, createdAt: number): number {
  return Math.max(0, Math.floor((t - createdAt) / DAY_MS));
}

type Entry =
  /** createdAt known: `offset` is the last window this process wrote (or skipped as too old). */
  | { createdAt: number; offset: number }
  /** The write matched nothing (ineligible / unknown account): don't retry before `retryAt`. */
  | { retryAt: number };

export class ActivityRecorder {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly cols: Pick<Collections, 'accounts'>,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  /** Number of accounts currently tracked (tests / diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Note one authenticated request. Synchronous and non-throwing; the Mongo write (if any) runs in the
   * background. Returns the in-flight write so tests can await it — production callers ignore it.
   */
  record(accountId: string): Promise<void> | undefined {
    const t = this.now();
    const e = this.entries.get(accountId);
    if (e) {
      if ('retryAt' in e) {
        if (t < e.retryAt) return undefined;
      } else {
        const offset = offsetOf(t, e.createdAt);
        if (offset === e.offset) return undefined;
        if (offset >= ACTIVITY_WINDOW_DAYS) {
          this.remember(accountId, { createdAt: e.createdAt, offset });
          return undefined;
        }
      }
    }
    // Claim the slot before the write so concurrent requests from the same account don't all write.
    // Real entry (with the actual offset) is filled in from the write's result.
    this.remember(accountId, { retryAt: t + DAY_MS });
    return this.write(accountId, t);
  }

  private async write(accountId: string, t: number): Promise<void> {
    try {
      const doc = await this.cols.accounts.findOneAndUpdate(
        { _id: accountId, createdAt: { $gt: t - ACTIVITY_WINDOW_DAYS * DAY_MS }, ...eligibleAccountFilter() },
        [
          {
            $set: {
              activeDays: {
                $setUnion: [
                  { $ifNull: ['$activeDays', []] },
                  // $max guards a createdAt written by a process whose clock runs slightly ahead of ours.
                  [{ $max: [0, { $floor: { $divide: [{ $subtract: [t, '$createdAt'] }, DAY_MS] } }] }],
                ],
              },
            },
          },
        ],
        { projection: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (doc && typeof doc.createdAt === 'number') {
        this.remember(accountId, { createdAt: doc.createdAt, offset: offsetOf(t, doc.createdAt) });
      }
      // No match (objected / too old / deleted / bot / unknown): the retryAt claim stays — one more try
      // tomorrow, in case the player re-consented. Too-old accounts cost one indexed miss per day.
    } catch (e) {
      // Leave the claim in place: a failing database is not retried per request.
      log.debug('activeDays write failed', { accountId, err: (e as Error).message });
    }
  }

  /** Insert/refresh as most-recently-used and evict the oldest entries past the cap. */
  private remember(accountId: string, entry: Entry): void {
    this.entries.delete(accountId);
    this.entries.set(accountId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
