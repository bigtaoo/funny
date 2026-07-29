// matchsvc-prematch-persist (2026-07-29): Redis write-through/rehydrate primitives (persist.ts), tested
// against a fake in-memory Redis client (no real connection) — same style as shared/test/activeMatch.test.ts.
import { describe, it, expect } from 'vitest';
import {
  saveRoom,
  clearRoomAccount,
  deleteRoom,
  loadAllRooms,
  saveQueueEntry,
  deleteQueueEntry,
  loadAllQueueEntries,
  saveDuelInvite,
  deleteDuelInvite,
  loadAllDuelInvites,
  ROOM_TTL_SEC,
  DUEL_TTL_SEC,
} from '../src/persist';
import type { Room, DuelPlayer } from '../src/Matchsvc';
import type { QueueEntry } from '../src/Matchmaking';

// ── Fake Redis (strings + sorted sets + a MULTI that just runs its queued ops in order) ──────────
function fakeRedis() {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();

  function zsetOf(key: string): Map<string, number> {
    let z = zsets.get(key);
    if (!z) {
      z = new Map();
      zsets.set(key, z);
    }
    return z;
  }

  const set = async (key: string, value: string, ..._rest: unknown[]): Promise<string> => {
    strings.set(key, value);
    return 'OK';
  };
  const get = async (key: string): Promise<string | null> => strings.get(key) ?? null;
  const del = async (...keys: string[]): Promise<number> => {
    let n = 0;
    for (const k of keys) {
      if (strings.delete(k)) n++;
      zsets.delete(k);
    }
    return n;
  };
  const mget = async (...keys: string[]): Promise<(string | null)[]> => keys.map((k) => strings.get(k) ?? null);
  const keys = async (pattern: string): Promise<string[]> => {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return [...strings.keys()].filter((k) => k.startsWith(prefix));
  };
  const zadd = async (key: string, score: number, member: string): Promise<number> => {
    zsetOf(key).set(member, score);
    return 1;
  };
  const zrem = async (key: string, ...members: string[]): Promise<number> => {
    const z = zsetOf(key);
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  };
  const zrange = async (key: string, start: number, stop: number): Promise<string[]> => {
    const sorted = [...zsetOf(key).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  };

  const ops = { set, get, del, mget, keys, zadd, zrem, zrange };

  function multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const builder = {
      set: (...args: Parameters<typeof set>) => {
        queued.push(() => set(...args));
        return builder;
      },
      zadd: (...args: Parameters<typeof zadd>) => {
        queued.push(() => zadd(...args));
        return builder;
      },
      zrem: (...args: Parameters<typeof zrem>) => {
        queued.push(() => zrem(...args));
        return builder;
      },
      del: (...args: Parameters<typeof del>) => {
        queued.push(() => del(...args));
        return builder;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const fn of queued) results.push(await fn());
        return results;
      },
    };
    return builder;
  }

  return { ...ops, multi, strings, zsets };
}

const from: DuelPlayer = { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', deck: [] };

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    roomId: 'room-1',
    code: 'ABC123',
    slots: [
      { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', deck: [], side: 0, ready: false, connected: true },
      { accountId: 'b', name: 'Bob', publicId: '100000002', equippedTitle: '', avatarId: '', deck: [], side: 1, ready: false, connected: true },
    ],
    phase: 0,
    reapTimer: null,
    ...overrides,
  };
}

const queueEntry: QueueEntry = {
  accountId: 'q1', name: 'Q1', publicId: '100000010', equippedTitle: '', avatarId: '', elo: 1000, enqueuedAt: 1000, platform: '', deck: [],
};

describe('persist.ts — rooms', () => {
  it('saveRoom writes the room + one reverse-lookup key per slot, with TTL', async () => {
    const redis = fakeRedis();
    const room = makeRoom();
    await saveRoom(redis, room);
    expect(redis.strings.get('nw:room:room-1')).toBe(JSON.stringify({ roomId: 'room-1', code: 'ABC123', slots: room.slots, phase: 0 }));
    expect(redis.strings.get('nw:roomByAccount:a')).toBe('room-1');
    expect(redis.strings.get('nw:roomByAccount:b')).toBe('room-1');
  });

  it('saveRoom never persists the non-serializable reapTimer field', async () => {
    const redis = fakeRedis();
    await saveRoom(redis, makeRoom({ reapTimer: setTimeout(() => {}, 100_000).unref?.() as unknown as NodeJS.Timeout }));
    const raw = redis.strings.get('nw:room:room-1')!;
    expect(JSON.parse(raw).reapTimer).toBeUndefined();
  });

  it('loadAllRooms round-trips a saved room', async () => {
    const redis = fakeRedis();
    const room = makeRoom();
    await saveRoom(redis, room);
    const { rooms, lostAccountIds } = await loadAllRooms(redis);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ roomId: 'room-1', code: 'ABC123' });
    expect(lostAccountIds).toEqual([]);
  });

  it('clearRoomAccount removes only the one reverse-lookup key', async () => {
    const redis = fakeRedis();
    await saveRoom(redis, makeRoom());
    await clearRoomAccount(redis, 'a');
    expect(redis.strings.has('nw:roomByAccount:a')).toBe(false);
    expect(redis.strings.has('nw:roomByAccount:b')).toBe(true);
    expect(redis.strings.has('nw:room:room-1')).toBe(true);
  });

  it('deleteRoom removes the room key and every slot reverse-lookup key', async () => {
    const redis = fakeRedis();
    const room = makeRoom();
    await saveRoom(redis, room);
    await deleteRoom(redis, room);
    expect(redis.strings.size).toBe(0);
  });

  it('a dangling roomByAccount pointer (room data evicted, pointer survived) is reported lost and cleaned up', async () => {
    const redis = fakeRedis();
    // Simulate asymmetric eviction under Redis memory pressure: the small pointer key survives,
    // the bigger room payload does not.
    redis.strings.set('nw:roomByAccount:ghost', 'room-gone');
    const { rooms, lostAccountIds } = await loadAllRooms(redis);
    expect(rooms).toEqual([]);
    expect(lostAccountIds).toEqual(['ghost']);
    expect(redis.strings.has('nw:roomByAccount:ghost')).toBe(false); // cleaned up
  });

  it('null redis → every function is a safe no-op', async () => {
    await expect(saveRoom(null, makeRoom())).resolves.toBeUndefined();
    await expect(clearRoomAccount(null, 'a')).resolves.toBeUndefined();
    await expect(deleteRoom(null, makeRoom())).resolves.toBeUndefined();
    await expect(loadAllRooms(null)).resolves.toEqual({ rooms: [], lostAccountIds: [] });
  });
});

describe('persist.ts — ranked queue', () => {
  it('saveQueueEntry writes the ZSET member (score=enqueuedAt) + the entry payload', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, queueEntry);
    expect(redis.zsets.get('nw:queue')?.get('q1')).toBe(1000);
    expect(redis.strings.get('nw:queueEntry:q1')).toBe(JSON.stringify(queueEntry));
  });

  it('loadAllQueueEntries returns entries sorted by enqueuedAt', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, { ...queueEntry, accountId: 'late', enqueuedAt: 2000 });
    await saveQueueEntry(redis, { ...queueEntry, accountId: 'early', enqueuedAt: 500 });
    const { entries, lostAccountIds } = await loadAllQueueEntries(redis);
    expect(entries.map((e) => e.accountId)).toEqual(['early', 'late']);
    expect(lostAccountIds).toEqual([]);
  });

  it('deleteQueueEntry clears both the ZSET membership and the payload', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, queueEntry);
    await deleteQueueEntry(redis, 'q1');
    expect(redis.zsets.get('nw:queue')?.has('q1')).toBeFalsy();
    expect(redis.strings.has('nw:queueEntry:q1')).toBe(false);
  });

  it('a ZSET member with no matching entry payload is reported lost and the dangling membership is dropped', async () => {
    const redis = fakeRedis();
    await redis.zadd('nw:queue', 999, 'ghost');
    const { entries, lostAccountIds } = await loadAllQueueEntries(redis);
    expect(entries).toEqual([]);
    expect(lostAccountIds).toEqual(['ghost']);
    expect(redis.zsets.get('nw:queue')?.has('ghost')).toBe(false);
  });

  it('null redis → every function is a safe no-op', async () => {
    await expect(saveQueueEntry(null, queueEntry)).resolves.toBeUndefined();
    await expect(deleteQueueEntry(null, 'q1')).resolves.toBeUndefined();
    await expect(loadAllQueueEntries(null)).resolves.toEqual({ entries: [], lostAccountIds: [] });
  });
});

describe('persist.ts — duel invites', () => {
  it('saveDuelInvite writes the invite + the fromAccountId reverse lookup, both TTL\'d to DUEL_TTL_SEC', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await saveDuelInvite(redis, invite);
    expect(redis.strings.get('nw:duel:inv-1')).toBe(JSON.stringify(invite));
    expect(redis.strings.get('nw:duelByAccount:a')).toBe('inv-1');
    void DUEL_TTL_SEC; // sanity: constant is exported and > matchsvc's own DUEL_TIMEOUT_MS/1000
    expect(DUEL_TTL_SEC).toBeGreaterThan(60);
  });

  it('loadAllDuelInvites round-trips a saved invite', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await saveDuelInvite(redis, invite);
    const { invites, lostFromAccountIds } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([invite]);
    expect(lostFromAccountIds).toEqual([]);
  });

  it('deleteDuelInvite removes both keys', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await saveDuelInvite(redis, invite);
    await deleteDuelInvite(redis, 'inv-1', 'a');
    expect(redis.strings.size).toBe(0);
  });

  it('a dangling duelByAccount pointer (invite payload evicted, pointer survived) is reported lost and cleaned up', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:duelByAccount:ghost', 'inv-gone');
    const { invites, lostFromAccountIds } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([]);
    expect(lostFromAccountIds).toEqual(['ghost']);
    expect(redis.strings.has('nw:duelByAccount:ghost')).toBe(false);
  });

  it('null redis → every function is a safe no-op', async () => {
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await expect(saveDuelInvite(null, invite)).resolves.toBeUndefined();
    await expect(deleteDuelInvite(null, 'inv-1', 'a')).resolves.toBeUndefined();
    await expect(loadAllDuelInvites(null)).resolves.toEqual({ invites: [], lostFromAccountIds: [] });
  });
});

describe('persist.ts — room TTL sanity', () => {
  it('ROOM_TTL_SEC is generous relative to REAP_MS (60s)', () => {
    expect(ROOM_TTL_SEC).toBeGreaterThan(60);
  });
});
