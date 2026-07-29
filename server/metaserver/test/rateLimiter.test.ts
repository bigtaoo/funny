// Thin smoke test (2026-07-29): the full behavioral suite for SlidingRateLimiter/RedisSlidingRateLimiter/
// createRateLimiter moved to server/shared/test/rateLimiter.test.ts when the implementation itself moved to
// @nw/shared (gateway now reuses it for per-connection control-message limiting, SERVER_LOGIC_AUDIT_2026-07-29
// known-gap #4). This file only guards the metaserver-local re-export in service/base.ts — the three real
// call sites (auth.ts/save.ts/telemetry.ts) import createRateLimiter from './base.js' and must keep working
// unchanged post-migration.
import { describe, it, expect, vi } from 'vitest';
import { SlidingRateLimiter, RedisSlidingRateLimiter, createRateLimiter, type RateLimiter } from '../src/service/base.js';

describe('service/base.ts rate limiter re-export (logic lives in @nw/shared)', () => {
  it('createRateLimiter(null, ...) returns the in-process fallback and enforces the limit', async () => {
    const rl: RateLimiter = createRateLimiter(null, 'ns', 2, 1000);
    expect(rl).toBeInstanceOf(SlidingRateLimiter);
    expect(await rl.allow('k', 0)).toBe(true);
    expect(await rl.allow('k', 1)).toBe(true);
    expect(await rl.allow('k', 2)).toBe(false);
  });

  it('createRateLimiter(redis, ...) returns the Redis-backed implementation', () => {
    const fakeRedis = { eval: vi.fn() };
    expect(createRateLimiter(fakeRedis, 'ns', 5, 1000)).toBeInstanceOf(RedisSlidingRateLimiter);
  });
});
