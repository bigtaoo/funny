// Unit tests for the rate-limiter machinery (moved here 2026-07-29 from metaserver/test/rateLimiter.test.ts
// when SlidingRateLimiter/RedisSlidingRateLimiter/createRateLimiter were extracted to @nw/shared so gateway's
// per-connection control-message limiting — SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4 — could reuse them
// instead of growing a second implementation. Logic is unchanged from the 2026-07-27 mid-term audit version;
// metaserver/test/rateLimiter.test.ts now keeps a thin re-export smoke test only.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { SlidingRateLimiter, RedisSlidingRateLimiter, createRateLimiter } from '../src/rateLimiter.js';

describe('SlidingRateLimiter', () => {
  it('allows up to the limit, denies the next one', async () => {
    const rl = new SlidingRateLimiter(3, 1000);
    expect(await rl.allow('k', 0)).toBe(true);
    expect(await rl.allow('k', 1)).toBe(true);
    expect(await rl.allow('k', 2)).toBe(true);
    expect(await rl.allow('k', 3)).toBe(false);
  });

  it('different keys are independent', async () => {
    const rl = new SlidingRateLimiter(1, 1000);
    expect(await rl.allow('a', 0)).toBe(true);
    expect(await rl.allow('b', 0)).toBe(true);
    expect(await rl.allow('a', 1)).toBe(false);
    expect(await rl.allow('b', 1)).toBe(false);
  });

  it('the window slides: an attempt older than windowMs no longer counts against the limit', async () => {
    const rl = new SlidingRateLimiter(2, 1000);
    expect(await rl.allow('k', 0)).toBe(true);
    expect(await rl.allow('k', 500)).toBe(true);
    expect(await rl.allow('k', 999)).toBe(false); // both prior attempts (t=0,500) still within the window
    expect(await rl.allow('k', 1001)).toBe(true); // t=0 has aged out (1001-0 >= 1000); only t=500 counts
  });

  it('memory leak fix (2026-07-27): a key with no recent activity is evicted from the backing map, not kept forever', async () => {
    const rl = new SlidingRateLimiter(5, 1000);
    // 50 distinct one-off keys, each used exactly once and never touched again — the original
    // implementation only ever pruned STALE TIMESTAMPS on read, never removed a key whose array had
    // gone fully empty, so `windows` grew by one entry per distinct key forever.
    for (let i = 0; i < 50; i++) await rl.allow(`transient-${i}`, i);
    // A sweep only runs (at most once per windowMs) as a side effect of a later allow() call — advance
    // time past the window and make one more call to trigger it.
    await rl.allow('trigger-sweep', 5000);
    // Reaching into the private field is the only way to observe the fix directly; the leak is invisible
    // from allow()'s return value alone (a stale idle key's own filter-on-read already looks correct).
    const windows = (rl as unknown as { windows: Map<string, number[]> }).windows;
    expect(windows.size).toBeLessThan(10); // bounded to "keys active within the last windowMs", not 51
  });

  it('limit=0 denies immediately and never leaves a phantom key behind (the win.length===0 delete branch)', async () => {
    const rl = new SlidingRateLimiter(0, 1000);
    expect(await rl.allow('k', 0)).toBe(false);
    const windows = (rl as unknown as { windows: Map<string, number[]> }).windows;
    expect(windows.has('k')).toBe(false); // deleted, not left behind as an empty array
    // A second call for the same key hits the exact same "already absent, still denied" path.
    expect(await rl.allow('k', 1)).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('redis=null returns a SlidingRateLimiter (in-process fallback)', () => {
    expect(createRateLimiter(null, 'ns', 5, 1000)).toBeInstanceOf(SlidingRateLimiter);
  });

  it('a redis client returns a RedisSlidingRateLimiter', () => {
    const fakeRedis = { eval: vi.fn() };
    expect(createRateLimiter(fakeRedis, 'ns', 5, 1000)).toBeInstanceOf(RedisSlidingRateLimiter);
  });
});

// ── RedisSlidingRateLimiter.allow (fake redis client; exercises the eval-script plumbing without
// needing a real reachable Redis — mirrors dailyCounter.test.ts's fakeRedisClient() convention).
// The "against a real local Redis" suite below additionally validates the actual Lua script, but is
// skipped in environments (like this one) where Redis isn't reachable.
describe('RedisSlidingRateLimiter (fake redis client)', () => {
  it('calls eval with the namespaced key, args in order, and interprets 1/0 as allow/deny', async () => {
    const evalFn = vi.fn(async (..._args: unknown[]) => 1);
    const fakeRedis = { eval: evalFn };
    const rl = new RedisSlidingRateLimiter(fakeRedis, 'myns', 5, 60_000);
    expect(await rl.allow('user-1', 1000)).toBe(true);
    expect(evalFn).toHaveBeenCalledTimes(1);
    const args = evalFn.mock.calls[0]!;
    expect(args[1]).toBe(1); // numKeys
    expect(args[2]).toBe('nw:ratelimit:myns:user-1'); // KEYS[1]
    expect(args[3]).toBe(1000); // now
    expect(args[4]).toBe(60_000); // windowMs
    expect(args[5]).toBe(5); // limit
    expect(typeof args[6]).toBe('string'); // member (unique per call, not asserted verbatim)
    expect(args[7]).toBe(Math.ceil(60_000 / 1000) + 5); // ttlSec
  });

  it('res !== 1 (e.g. 0) denies', async () => {
    const fakeRedis = { eval: vi.fn(async (..._args: unknown[]) => 0) };
    const rl = new RedisSlidingRateLimiter(fakeRedis, 'myns', 5, 1000);
    expect(await rl.allow('user-1', 1000)).toBe(false);
  });

  it('the member argument is unique per call (avoids same-millisecond ZADD collisions)', async () => {
    const evalFn = vi.fn(async (..._args: unknown[]) => 1);
    const fakeRedis = { eval: evalFn };
    const rl = new RedisSlidingRateLimiter(fakeRedis, 'myns', 5, 1000);
    await rl.allow('user-1', 1000);
    await rl.allow('user-1', 1000); // same key, same timestamp
    const member1 = evalFn.mock.calls[0]![6];
    const member2 = evalFn.mock.calls[1]![6];
    expect(member1).not.toBe(member2);
  });
});

const REDIS_URL = process.env.NW_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function tryConnectRedis(): Promise<unknown | null> {
  try {
    const mod = await import('ioredis');
    const Redis = (mod as unknown as { default: new (url: string) => unknown }).default;
    const client = new Redis(REDIS_URL) as { ping(): Promise<string>; quit(): Promise<unknown> };
    await client.ping();
    return client;
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const redis = await tryConnectRedis();
if (!redis) console.warn(`[rateLimiter.test] Redis unreachable (${REDIS_URL}) — skipping.`);

describe('RedisSlidingRateLimiter (against a real local Redis)', () => {
  afterAll(async () => {
    await (redis as { quit(): Promise<unknown> } | null)?.quit();
  });

  it.skipIf(!redis)('allows up to the limit, denies the next one, atomically via the Lua script', async () => {
    const rl = new RedisSlidingRateLimiter(redis, `test-${Math.random()}`, 3, 60_000);
    const now = Date.now();
    expect(await rl.allow('k', now)).toBe(true);
    expect(await rl.allow('k', now + 1)).toBe(true);
    expect(await rl.allow('k', now + 2)).toBe(true);
    expect(await rl.allow('k', now + 3)).toBe(false);
  });

  it.skipIf(!redis)('the window slides on the real backend too', async () => {
    const rl = new RedisSlidingRateLimiter(redis, `test-${Math.random()}`, 1, 1000);
    const now = Date.now();
    expect(await rl.allow('k', now)).toBe(true);
    expect(await rl.allow('k', now + 500)).toBe(false);
    expect(await rl.allow('k', now + 1001)).toBe(true);
  });
});
