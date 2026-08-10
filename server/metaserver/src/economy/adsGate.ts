// Rewarded-ad gating (C2): daily cap, replay-token dedup, and cooldown interval. Split out of
// economy.ts (2026-08-10, 独立函数模块 form — see economy.ts's facade comment). Not to be confused
// with the top-level `ads.ts` (ad-platform signature verification) — these are the account-side
// counters, independent of which ad platform issued the token.
import { createHash } from 'node:crypto';
import type { Collections, RedisLike } from '@nw/shared';
import { bumpCappedCounter, readCounterField, bumpGuardedTimestamp } from '@nw/shared';

/** UTC calendar-day key (for ad cap resets). `now` is injected for testability. */
export function adsDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Ad cap: atomically increment today's count; returns false (deny delivery) if the count exceeds cap.
 * Redis-backed (2026-07-27, moved off Mongo's adsDaily — see shared/src/dailyCounter.ts for the design).
 */
export async function bumpAdsCap(
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  cap: number,
): Promise<boolean> {
  return bumpCappedCounter(redis, 'adsDaily', accountId, dayKey, 'count', cap);
}

/** SHA-256 hash of an ad token (hex). Used for deduplication in adsTokens. */
export function hashAdToken(adToken: string): string {
  return createHash('sha256').update(adToken).digest('hex');
}

/**
 * Ad-token uniqueness check (C2): writes the hash to adsTokens; returns false on replay.
 * MongoDB unique _id conflict → natural deduplication; TTL 48h for automatic cleanup.
 */
export async function recordAdToken(
  cols: Collections,
  tokenHash: string,
  accountId: string,
  now: number,
): Promise<boolean> {
  try {
    await cols.adsTokens.insertOne({
      _id: tokenHash,
      accountId,
      ts: now,
      expireAt: new Date(now + 48 * 3600 * 1000),
    });
    return true;
  } catch {
    // Unique _id conflict = replay; other errors propagate up.
    return false;
  }
}

/** 30-minute interval gate (C2): atomically updates lastAdAt; returns false if less than minIntervalMs has elapsed since the last ad. */
export async function checkAdInterval(
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  now: number,
  minIntervalMs: number,
): Promise<boolean> {
  return bumpGuardedTimestamp(redis, 'adsDaily', accountId, dayKey, 'lastAdAt', minIntervalMs, now);
}

/** Read-only snapshot of today's ad-watch state, for GET /retention (DailyScene "Ads" tab). Does not mutate. */
export async function peekAdsStatus(
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  minIntervalMs: number,
  now: number,
): Promise<{ watchedToday: number; nextAvailableAt: number }> {
  const [watchedToday, lastAdAt] = await Promise.all([
    readCounterField(redis, 'adsDaily', accountId, dayKey, 'count'),
    readCounterField(redis, 'adsDaily', accountId, dayKey, 'lastAdAt'),
  ]);
  const nextAvailableAt = lastAdAt ? lastAdAt + minIntervalMs : 0;
  return { watchedToday, nextAvailableAt: nextAvailableAt > now ? nextAvailableAt : 0 };
}
