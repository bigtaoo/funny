// C7 RedisRoomRegistry unit tests (in-memory Redis mock; no real connection).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryRoomRegistry, RedisRoomRegistry, type RoomInfo } from '../src/roomRegistry';

const sample: RoomInfo = {
  roomId: 'room-1',
  code: 'ABCD',
  mode: 'friendly',
  instanceId: 'gs-1',
  createdAt: 1000,
};

// ── InMemoryRoomRegistry (verify it remains unbroken) ──────────────────────────────────────

describe('InMemoryRoomRegistry', () => {
  it('create + getById + getByCode', async () => {
    const reg = new InMemoryRoomRegistry();
    await reg.create(sample);
    expect(await reg.getById('room-1')).toEqual(sample);
    expect(await reg.getByCode('ABCD')).toEqual(sample);
  });

  it('remove clears both indexes', async () => {
    const reg = new InMemoryRoomRegistry();
    await reg.create(sample);
    await reg.remove('room-1');
    expect(await reg.getById('room-1')).toBeNull();
    expect(await reg.getByCode('ABCD')).toBeNull();
  });

  it('getById / getByCode miss → null', async () => {
    const reg = new InMemoryRoomRegistry();
    expect(await reg.getById('nope')).toBeNull();
    expect(await reg.getByCode('ZZZZ')).toBeNull();
  });
});

// ── RedisRoomRegistry（fake Redis client）──────────────────────────────────

function fakeRedisClient() {
  const store = new Map<string, { value: string; ex?: number }>();
  return {
    set: vi.fn(async (key: string, value: string, _mode?: string, ex?: number) => {
      store.set(key, { value, ex });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    store,
  };
}

describe('RedisRoomRegistry', () => {
  it('create stores room + code keys with TTL', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    await reg.create(sample);
    expect(client.set).toHaveBeenCalledWith('nw:rooms:room-1', JSON.stringify(sample), 'EX', 86400);
    expect(client.set).toHaveBeenCalledWith('nw:room-codes:ABCD', 'room-1', 'EX', 86400);
  });

  it('getById returns parsed RoomInfo', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    await reg.create(sample);
    const got = await reg.getById('room-1');
    expect(got).toEqual(sample);
  });

  it('getByCode resolves via code → roomId → info', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    await reg.create(sample);
    const got = await reg.getByCode('ABCD');
    expect(got).toEqual(sample);
  });

  it('getById miss → null', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    expect(await reg.getById('nope')).toBeNull();
  });

  it('getByCode miss → null', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    expect(await reg.getByCode('ZZZZ')).toBeNull();
  });

  it('remove deletes both keys', async () => {
    const client = fakeRedisClient();
    const reg = new RedisRoomRegistry(client);
    await reg.create(sample);
    await reg.remove('room-1');
    expect(await reg.getById('room-1')).toBeNull();
    expect(await reg.getByCode('ABCD')).toBeNull();
  });

  it('malformed JSON in Redis → null', async () => {
    const client = fakeRedisClient();
    client.store.set('nw:rooms:bad', { value: '{broken' });
    const reg = new RedisRoomRegistry(client);
    expect(await reg.getById('bad')).toBeNull();
  });
});
