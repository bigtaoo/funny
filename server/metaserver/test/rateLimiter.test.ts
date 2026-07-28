// Unit tests for the rate-limiter machinery in service/base.ts (2026-07-27 mid-term audit item 5/5).
// Three call sites (auth IP limit, anomaly-report IP limit, state-replay-share accountId limit) previously
// each had zero or only incidental coverage of their actual "deny after limit" behavior — this file covers
// the shared implementation directly instead of relying on triggering it indirectly through e2e request loops.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { SlidingRateLimiter, RedisSlidingRateLimiter, createRateLimiter } from '../src/service/base.js';

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

const REDIS_URL = process.env.NW_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function tryConnectRedis(): Promise<unknown | null> {
  try {
    const mod = await import('ioredis');
    const Redis = (mod as unknown as { default: new (url: string) => unknown }).default;
    const client = new Redis(REDIS_URL) as { ping(): Promise<string>; quit(): Promise<unknown> };
    await client.ping();
    return client;
  } catch {
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
