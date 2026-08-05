// Unit tests for dailyCounter.ts (adsDaily/pveDaily/victoryDaily anti-abuse counters): capped-counter
// atomic increment + overshoot rollback, guarded-timestamp gate boundary, key format, and local-fallback
// vs real-Redis backend equivalence. Mirrors rateLimiter.test.ts's "fake in-process backend covered
// unconditionally + real-Redis path behind it.skipIf(!redis)" pattern, since dailyCounter.ts is the
// same shape of Redis-optional atomic-counter module.
import { describe, it, expect, afterAll } from 'vitest';
import { bumpCappedCounter, readCounterField, bumpGuardedTimestamp, dailyCounterKey } from '../src/dailyCounter';

describe('dailyCounterKey', () => {
  it('formats as nw:<ns>:<accountId>:<dayKey>', () => {
    expect(dailyCounterKey('adsDaily', 'acc-1', '2026-08-05')).toBe('nw:adsDaily:acc-1:2026-08-05');
  });
});

// ── bumpCappedCounter / readCounterField (local in-process fallback, redis=null) ──────────────────

describe('bumpCappedCounter (local in-process fallback, redis=null)', () => {
  it('allows increments up to the cap, denies the one that would exceed it', async () => {
    const ns = `test-cap-${Math.random()}`;
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 3)).toBe(true); // -> 1
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 3)).toBe(true); // -> 2
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 3)).toBe(true); // -> 3, at cap
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 3)).toBe(false); // would be 4 > cap 3
  });

  it('exact cap boundary: reaching the cap succeeds, and the denied overshoot attempt self-corrects (rolls back, not stuck above cap)', async () => {
    const ns = `test-cap-boundary-${Math.random()}`;
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 1)).toBe(true); // -> 1, exactly at cap
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(1);
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 1)).toBe(false); // would be 2 > cap 1
    // The header comment promises the overshoot increment "rolls its own increment back" — verify the
    // field is left at the cap (1), not at the transient overshoot value (2).
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(1);
    // A subsequent call still correctly denies (rollback didn't accidentally free up capacity either).
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 1)).toBe(false);
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(1);
  });

  it('cap=0 denies the very first increment and leaves the field at 0 (no phantom count)', async () => {
    const ns = `test-cap-zero-${Math.random()}`;
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 0)).toBe(false);
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(0);
  });

  it('different fields/dayKeys/accountIds are independent counters (no cross-talk)', async () => {
    const ns = `test-cap-independent-${Math.random()}`;
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f1', 1)).toBe(true);
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f2', 1)).toBe(true); // different field, same key otherwise
    expect(await bumpCappedCounter(null, ns, 'acc', 'day2', 'f1', 1)).toBe(true); // different dayKey
    expect(await bumpCappedCounter(null, ns, 'acc2', 'day1', 'f1', 1)).toBe(true); // different accountId
    // f1/day1/acc is already at its cap of 1; none of the above touched it.
    expect(await bumpCappedCounter(null, ns, 'acc', 'day1', 'f1', 1)).toBe(false);
  });
});

describe('readCounterField (local in-process fallback, redis=null)', () => {
  it('returns 0 for a key/field that has never been written (no throw)', async () => {
    const ns = `test-read-missing-${Math.random()}`;
    expect(await readCounterField(null, ns, 'acc', 'day1', 'never-written')).toBe(0);
  });

  it('does not mutate state (repeated reads are stable)', async () => {
    const ns = `test-read-pure-${Math.random()}`;
    await bumpCappedCounter(null, ns, 'acc', 'day1', 'f', 5);
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(1);
    expect(await readCounterField(null, ns, 'acc', 'day1', 'f')).toBe(1);
  });
});

// ── bumpGuardedTimestamp (local in-process fallback, redis=null) ──────────────────────────────────

describe('bumpGuardedTimestamp (local in-process fallback, redis=null)', () => {
  it('opens on first use, then gates until exactly minIntervalMs has elapsed', async () => {
    const ns = `test-guard-${Math.random()}`;
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'ad', 1000, 10_000)).toBe(true);
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'ad', 1000, 10_999)).toBe(false); // 999ms later, still gated
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'ad', 1000, 11_000)).toBe(true); // exactly 1000ms later, gate reopens
  });

  it('exact interval boundary: 1ms short is denied, exactly at the interval is allowed', async () => {
    // Base timestamps deliberately nonzero: the gate's "has this field been set before" check is
    // `last > 0`, so a first call at now=0 would be indistinguishable from "never written" and the
    // boundary math below would be measured from the wrong reference point.
    const ns = `test-guard-boundary-${Math.random()}`;
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 500, 1000)).toBe(true);
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 500, 1499)).toBe(false);
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 500, 1500)).toBe(true);
  });

  it('a denied attempt does not reset the gate\'s last-timestamp (interval keeps measuring from the last successful open)', async () => {
    const ns = `test-guard-denial-${Math.random()}`;
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 1000, 1000)).toBe(true);
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 1000, 1500)).toBe(false); // denied; last stays at t=1000
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 1000, 1999)).toBe(false); // still measured from t=1000, not t=1500
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f', 1000, 2000)).toBe(true); // 1000ms after t=1000
  });

  it('different fields/dayKeys/accountIds are independent gates', async () => {
    const ns = `test-guard-independent-${Math.random()}`;
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f1', 1000, 1000)).toBe(true);
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day1', 'f2', 1000, 1000)).toBe(true); // different field
    expect(await bumpGuardedTimestamp(null, ns, 'acc', 'day2', 'f1', 1000, 1000)).toBe(true); // different dayKey
    expect(await bumpGuardedTimestamp(null, ns, 'acc2', 'day1', 'f1', 1000, 1000)).toBe(true); // different accountId
  });
});

// ── Redis-vs-local-fallback equivalence (against a real local Redis, skipped if unreachable) ──────

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
if (!redis) console.warn(`[dailyCounter.test] Redis unreachable (${REDIS_URL}) — skipping real-backend tests.`);

describe('bumpCappedCounter / readCounterField (against a real local Redis)', () => {
  it.skipIf(!redis)('allows up to the cap, denies and rolls back the overshoot — same as the local fallback', async () => {
    const ns = `test-redis-cap-${Math.random()}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = redis as any;
    expect(await bumpCappedCounter(r, ns, 'acc', 'day1', 'f', 2)).toBe(true); // -> 1
    expect(await bumpCappedCounter(r, ns, 'acc', 'day1', 'f', 2)).toBe(true); // -> 2, at cap
    expect(await bumpCappedCounter(r, ns, 'acc', 'day1', 'f', 2)).toBe(false); // would be 3 > cap 2
    expect(await readCounterField(r, ns, 'acc', 'day1', 'f')).toBe(2); // rolled back to the cap, not left at 3
  });

  it.skipIf(!redis)('readCounterField returns 0 for an unwritten field on the real backend too', async () => {
    const ns = `test-redis-read-missing-${Math.random()}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = redis as any;
    expect(await readCounterField(r, ns, 'acc', 'day1', 'never-written')).toBe(0);
  });
});

describe('bumpGuardedTimestamp (against a real local Redis, via the atomic Lua script)', () => {
  it.skipIf(!redis)('gates exactly at minIntervalMs, same boundary as the local fallback', async () => {
    const ns = `test-redis-guard-${Math.random()}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = redis as any;
    expect(await bumpGuardedTimestamp(r, ns, 'acc', 'day1', 'f', 500, 1000)).toBe(true);
    expect(await bumpGuardedTimestamp(r, ns, 'acc', 'day1', 'f', 500, 1499)).toBe(false);
    expect(await bumpGuardedTimestamp(r, ns, 'acc', 'day1', 'f', 500, 1500)).toBe(true);
  });
});

afterAll(async () => {
  await (redis as { quit(): Promise<unknown> } | null)?.quit();
});
