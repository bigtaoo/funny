// Sliding-window rate limiting (originally metaserver-only, 2026-07-27; extracted to @nw/shared 2026-07-29
// so gateway's per-connection control-message limiting — SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4 — can
// reuse the exact same in-process/Redis-backed duo instead of growing a second implementation).
import type { RedisLike } from './redisClient';

/** Sliding-window rate limiter keyed by an arbitrary string (IP, accountId, ...). Implementations may be
 *  in-process (single instance) or Redis-backed (precise across instances); see createRateLimiter below. */
export interface RateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

/**
 * In-process sliding-window rate limiter (fallback when Redis is unconfigured, and the sole implementation
 * before 2026-07-27). `allow` is async purely so callers don't need to branch on which implementation they
 * got back from createRateLimiter — the work itself is synchronous.
 *
 * Self-cleaning (2026-07-27 fix): the original version only ever filtered STALE TIMESTAMPS out of a key's
 * array on read — it never removed a key whose array had gone fully empty, so `windows` grew by one entry
 * per distinct key (IP for auth/anomaly limiters, accountId for the share limiter) ever seen, for the life
 * of the process — a real memory leak, independent of horizontal scaling (found during the 2026-07-27 audit
 * alongside the Redis migration, not the original reason Redis was flagged). `maybeSweep` piggybacks a full
 * cleanup pass onto normal traffic (at most once per windowMs) instead of a background timer — a timer would
 * leak across the many short-lived MetaService instances the test suite constructs per `buildApp()` call.
 */
export class SlidingRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private lastSweepAt = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [k, timestamps] of this.windows) {
      const fresh = timestamps.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.windows.delete(k);
      else if (fresh.length !== timestamps.length) this.windows.set(k, fresh);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async allow(key: string, now: number): Promise<boolean> {
    this.maybeSweep(now);
    const win = this.windows.get(key)?.filter((t) => now - t < this.windowMs) ?? [];
    if (win.length >= this.limit) {
      if (win.length > 0) this.windows.set(key, win);
      else this.windows.delete(key);
      return false;
    }
    win.push(now);
    this.windows.set(key, win);
    return true;
  }
}

/** Atomic sliding-window check via a single Lua script (prune-then-count-then-conditionally-add) — a plain
 *  ZCARD-then-ZADD would race two concurrent callers both passing the check before either records itself. */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local ttlSec = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  redis.call('EXPIRE', key, ttlSec)
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttlSec)
return 1
`;

/**
 * Redis-backed sliding-window rate limiter (2026-07-27): precise across instances (the original in-process
 * limiter's own doc comment already called this out as the thing Redis would fix — "in-process approximation
 * ... precise global limiting requires Redis"), unlike SlidingRateLimiter above which only ever sees traffic
 * that landed on the same process. One sorted set per key (`nw:ratelimit:{ns}:{key}`, score=timestamp);
 * TTL is a storage safety net only, refreshed on every call — the pass/fail decision is always the
 * ZREMRANGEBYSCORE prune against the caller-supplied `now`, never Redis's own clock.
 */
export class RedisSlidingRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly ns: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async allow(key: string, now: number): Promise<boolean> {
    const ttlSec = Math.ceil(this.windowMs / 1000) + 5;
    const member = `${now}-${Math.random()}`; // uniqueness only (avoids same-millisecond ZADD collisions), not a security token
    const res = await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      `nw:ratelimit:${this.ns}:${key}`,
      now,
      this.windowMs,
      this.limit,
      member,
      ttlSec,
    );
    return res === 1;
  }
}

/** Picks the Redis-backed limiter when configured, else the self-cleaning in-process fallback — same
 *  redis-or-fallback shape as shared/src/dailyCounter.ts, but here the fallback was always correct for a
 *  single instance (this is a genuine precision upgrade under future scale-out, not a correctness fix). */
export function createRateLimiter(redis: RedisLike | null, ns: string, limit: number, windowMs: number): RateLimiter {
  return redis ? new RedisSlidingRateLimiter(redis, ns, limit, windowMs) : new SlidingRateLimiter(limit, windowMs);
}
