// login-reconnect-prompt: activeMatch Redis helpers (fake Redis client; no real connection).
import { describe, it, expect, vi } from 'vitest';
import {
  activeMatchKey,
  ACTIVE_MATCH_TTL_SEC,
  setActiveMatch,
  getActiveMatch,
  clearActiveMatch,
  type ActiveMatchRecord,
} from '../src/activeMatch';

const sample: ActiveMatchRecord = {
  roomId: 'room-1',
  gameUrl: 'ws://game:8081/ws',
  ticket: 'signed.jwt.ticket',
  mode: 'ranked',
};

function fakeRedisClient() {
  const store = new Map<string, string>();
  return {
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
