// login-reconnect-prompt: activeMatch Redis helpers (fake Redis client; no real connection).
import { describe, it, expect, vi } from 'vitest';
import {
  activeMatchKey,
  ACTIVE_MATCH_TTL_SEC,
  setActiveMatch,
  getActiveMatch,
  clearActiveMatch,
  connectActiveMatchRedis,
  type ActiveMatchRecord,
} from '../src/activeMatch';
import type { RedisLike } from '../src/redisClient';

const sample: ActiveMatchRecord = {
  roomId: 'room-1',
  gameUrl: 'ws://game:8081/ws',
  ticket: 'signed.jwt.ticket',
  mode: 'ranked',
};

// Implements only the three commands activeMatch.ts calls. The `& RedisLike` assertion widens it to the
// full client interface so it can be passed where one is expected, while the `typeof client` half keeps the
// vi.fn() mock types the assertions below rely on; the hand-written signatures still match real Redis, so a
// drift between them and activeMatch.ts's call sites shows up as a type error here.
function fakeRedisClient() {
  const store = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string, _mode?: string, _ex?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    store,
  };
  return client as typeof client & RedisLike;
}

describe('activeMatchKey', () => {
  it('namespaces by accountId', () => {
    expect(activeMatchKey('acc-1')).toBe('nw:activeMatch:acc-1');
  });
});

describe('setActiveMatch / getActiveMatch / clearActiveMatch (fake redis)', () => {
  it('set then get round-trips the record with the TTL', async () => {
    const client = fakeRedisClient();
    await setActiveMatch(client, 'a', sample);
    expect(client.set).toHaveBeenCalledWith('nw:activeMatch:a', JSON.stringify(sample), 'EX', ACTIVE_MATCH_TTL_SEC);
    expect(await getActiveMatch(client, 'a')).toEqual(sample);
  });

  it('get miss → null', async () => {
    const client = fakeRedisClient();
    expect(await getActiveMatch(client, 'nope')).toBeNull();
  });

  it('malformed JSON in redis → null (does not throw)', async () => {
    const client = fakeRedisClient();
    client.store.set('nw:activeMatch:bad', '{broken');
    expect(await getActiveMatch(client, 'bad')).toBeNull();
  });

  it('clearActiveMatch deletes one or more accountIds at once', async () => {
    const client = fakeRedisClient();
    await setActiveMatch(client, 'a', sample);
    await setActiveMatch(client, 'b', { ...sample, roomId: 'room-2' });
    await clearActiveMatch(client, 'a', 'b');
    expect(client.del).toHaveBeenCalledWith('nw:activeMatch:a', 'nw:activeMatch:b');
    expect(await getActiveMatch(client, 'a')).toBeNull();
    expect(await getActiveMatch(client, 'b')).toBeNull();
  });

  it('clearActiveMatch with no accountIds → no-op (does not call redis)', async () => {
    const client = fakeRedisClient();
    await clearActiveMatch(client);
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('null redis (feature unconfigured) degrades silently', () => {
  it('setActiveMatch / getActiveMatch / clearActiveMatch are all safe no-ops', async () => {
    await expect(setActiveMatch(null, 'a', sample)).resolves.toBeUndefined();
    await expect(getActiveMatch(null, 'a')).resolves.toBeNull();
    await expect(clearActiveMatch(null, 'a')).resolves.toBeUndefined();
  });
});

// ── connectActiveMatchRedis ──────────────────────────────────────────────────────────────────

describe('connectActiveMatchRedis', () => {
  it('returns null immediately when no url is provided (never attempts a connection)', async () => {
    expect(await connectActiveMatchRedis(null)).toBeNull();
  });

  // No real Redis is assumed to be running in the test environment; connecting to an unreachable
  // URL exercises the same catch/degrade path a real outage would (returns null, logs, never throws
  // — mirrors dailyCounter.test.ts / rateLimiter.test.ts's "unreachable → skip/degrade" convention).
  // If a real local Redis DOES happen to be reachable here, the connection succeeds instead — handle
  // both outcomes so this test is environment-independent, and always clean up any real connection.
  it('degrades to null (never throws) when Redis is unreachable, or connects when it is available', async () => {
    const REDIS_URL = process.env.NW_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const client = await connectActiveMatchRedis(REDIS_URL);
    if (client) {
      await client.quit();
    } else {
      expect(client).toBeNull();
    }
  }, 15000);
});
