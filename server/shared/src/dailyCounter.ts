// Daily anti-abuse counters (adsDaily/pveDaily/victoryDaily, 2026-07-27 mid-term audit item 3/5, see
// mongo-redis-audit-and-fixes-2026-07-27): moved off Mongo to cut the double round-trip write (upsert +
// guarded $inc, each a cross-WAN hop to Atlas M0) down to one, and to get free bounded storage — these 3
// collections had never had an index or TTL at all, unlike everything else the 2026-07-27 audit fixed.
//
// RedisLike is the structural client interface from redisClient.ts (hand-written rather than imported from
// ioredis, which @nw/shared must compile without — see that file's header for the full reasoning).
//
// Unlike activeMatch/worldsvc's Redis usage (all "optional infra, degrades to a lesser
// experience"), these counters gate real anti-abuse caps — losing them isn't a UX nicety, it's a farmable
// economy hole. So when `redis` is null (unconfigured, or the connection failed), a per-process in-memory
// fallback takes over instead of silently disabling the cap. This is exactly as correct as Mongo was for the
// cap's actual job: metaserver and commercial both run as a single fork instance today (ecosystem.config.cjs,
// "single instance ... horizontal scaling requires Redis sharding, deferred"), so a per-process counter IS a
// correct global counter right now — it just doesn't survive a process restart, unlike real Redis (which
// carries an explicit TTL as a storage safety net only, see DAILY_COUNTER_TTL_SEC below; it never gates the
// pass/fail decision, which is always plain arithmetic against the caller-supplied `now`, never Redis's own
// clock — otherwise tests driving a fake clock across an interval boundary would desync from real elapsed time).

import { loadIoRedisCtor, type RedisConnection, type RedisLike } from './redisClient';

/** Safety-net TTL for the real-Redis backend: bounds storage even though nothing currently cleans these up
 *  proactively. Sliding (refreshed on every write) — harmless since all writes for a given accountId:dayKey
 *  key cluster within one calendar day, so 48h from the last write always covers the full day + a buffer. */
const DAILY_COUNTER_TTL_SEC = 48 * 3600;

const GUARDED_TS_SCRIPT = `
local key = KEYS[1]
local field = ARGV[1]
local now = tonumber(ARGV[2])
local minInterval = tonumber(ARGV[3])
local last = tonumber(redis.call('HGET', key, field) or '0')
if last > 0 and (now - last) < minInterval then
  return 0
end
redis.call('HSET', key, field, now)
return 1
`;

export function dailyCounterKey(ns: string, accountId: string, dayKey: string): string {
  return `nw:${ns}:${accountId}:${dayKey}`;
}

/** Backend seam so both the real-Redis path and the in-memory fallback implement the exact same primitives. */
interface CounterBackend {
  hincrby(key: string, field: string, delta: number): Promise<number>;
  hgetNumber(key: string, field: string): Promise<number>;
  /** Atomic (single Redis round-trip via Lua on the real backend): sets `field` to `now` only if absent or at
   *  least `minIntervalMs` old. Returns whether the gate opened. */
  guardedTimestampSet(key: string, field: string, now: number, minIntervalMs: number): Promise<boolean>;
  /** Storage bound only — never affects a gating decision (see module doc comment). */
  expire(key: string, ttlSec: number): Promise<void>;
}

function redisBackend(redis: RedisLike): CounterBackend {
  return {
    async hincrby(key, field, delta) {
      return redis.hincrby(key, field, delta);
    },
    async hgetNumber(key, field) {
      const v = await redis.hget(key, field);
      return v == null ? 0 : Number(v);
    },
    async guardedTimestampSet(key, field, now, minIntervalMs) {
      const res = await redis.eval(GUARDED_TS_SCRIPT, 1, key, field, now, minIntervalMs);
      return res === 1;
    },
    async expire(key, ttlSec) {
      await redis.expire(key, ttlSec);
    },
  };
}

/** In-process fallback (see module doc comment for why this is correct, not just a degrade). A single
 *  module-level instance is reused across every call so counts persist for the life of the process,
 *  exactly like a real Redis connection would persist across requests. */
class LocalBackend implements CounterBackend {
  private hashes = new Map<string, Map<string, number>>();

  private hashOf(key: string): Map<string, number> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hincrby(key: string, field: string, delta: number): Promise<number> {
    const h = this.hashOf(key);
    const next = (h.get(field) ?? 0) + delta;
    h.set(field, next);
    return next;
  }

  async hgetNumber(key: string, field: string): Promise<number> {
    return this.hashOf(key).get(field) ?? 0;
  }

  async guardedTimestampSet(key: string, field: string, now: number, minIntervalMs: number): Promise<boolean> {
    const h = this.hashOf(key);
    const last = h.get(field) ?? 0;
    if (last > 0 && now - last < minIntervalMs) return false;
    h.set(field, now);
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async expire(_key: string, _ttlSec: number): Promise<void> {
    /* no-op: process memory already dies with the process, nothing to bound. */
  }
}

const localFallback = new LocalBackend();

function backendOf(redis: RedisLike | null): CounterBackend {
  return redis ? redisBackend(redis) : localFallback;
}

/**
 * Atomically increments `field` by `by` (default 1, e.g. a shop bulk-buy charging several units in one
 * call) and reports whether the increment landed within `cap` (rolls its own increment back on overshoot
 * — never a partial bump, so a rejected batch leaves the counter exactly where it started). Lock-free:
 * HINCRBY is itself atomic on the Redis server, so concurrent callers serialize there; whichever call's
 * post-increment value exceeds cap loses and self-corrects — no Lua needed for this one (contrast
 * bumpGuardedTimestamp below, which does need it).
 */
export async function bumpCappedCounter(
  redis: RedisLike | null,
  ns: string,
  accountId: string,
  dayKey: string,
  field: string,
  cap: number,
  by = 1,
): Promise<boolean> {
  const backend = backendOf(redis);
  const key = dailyCounterKey(ns, accountId, dayKey);
  const after = await backend.hincrby(key, field, by);
  await backend.expire(key, DAILY_COUNTER_TTL_SEC);
  if (after > cap) {
    await backend.hincrby(key, field, -by);
    return false;
  }
  return true;
}

/** Read-only snapshot of one counter field (0 if absent) — for status displays; never mutates. */
export async function readCounterField(
  redis: RedisLike | null,
  ns: string,
  accountId: string,
  dayKey: string,
  field: string,
): Promise<number> {
  return backendOf(redis).hgetNumber(dailyCounterKey(ns, accountId, dayKey), field);
}

/**
 * Guarded timestamp gate (e.g. the ad-watch cooldown): sets `field` to `now` only if absent or at least
 * `minIntervalMs` old, atomically. Correctness rests entirely on the caller-supplied `now` — never Redis's
 * own clock/TTL — so callers can drive it with a fake clock in tests exactly like the Mongo version did.
 */
export async function bumpGuardedTimestamp(
  redis: RedisLike | null,
  ns: string,
  accountId: string,
  dayKey: string,
  field: string,
  minIntervalMs: number,
  now: number,
): Promise<boolean> {
  const backend = backendOf(redis);
  const key = dailyCounterKey(ns, accountId, dayKey);
  const opened = await backend.guardedTimestampSet(key, field, now, minIntervalMs);
  if (opened) await backend.expire(key, DAILY_COUNTER_TTL_SEC);
  return opened;
}

/**
 * Connects to Redis for daily-counter tracking (commercial has no other Redis use yet, unlike metaserver
 * which already connects one via connectActiveMatchRedis in activeMatch.ts — reuse that same client there
 * instead of opening a second connection; call this only for a process that doesn't already have one).
 * Returns null when unconfigured or unreachable — see the module doc comment for what null actually means
 * here (in-process fallback, not "feature disabled").
 */
export async function connectDailyCounterRedis(url: string | null): Promise<RedisConnection | null> {
  if (!url) return null;
  try {
    const Redis = await loadIoRedisCtor();
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (e) => reject(e));
    });
    client.on('error', (e) => console.error('[daily-counter-redis] error:', e.message));
    return client;
  } catch (e) {
    console.error(
      `[daily-counter-redis] Failed to connect to Redis (url=${url}): ${(e as Error).message}. ` +
        `Falling back to the in-process counter (correct for a single-instance deployment, but resets on restart).`,
    );
    return null;
  }
}
