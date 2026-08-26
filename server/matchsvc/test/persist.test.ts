// matchsvc-prematch-persist (2026-07-29): Redis write-through/rehydrate primitives (persist.ts), tested
// against a fake in-memory Redis client (no real connection) — same style as shared/test/activeMatch.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { RedisLike } from '@nw/shared';
import type { Room, DuelPlayer } from '../src/Matchsvc';
import type { QueueEntry } from '../src/Matchmaking';

// ── Fake Redis (strings + sorted sets + a MULTI that just runs its queued ops in order) ──────────
// `fail` lets individual tests flip on/off per-method rejection to exercise persist.ts's catch branches
// (best-effort persistence swallowing a real Redis failure) without a real Redis connection.
function fakeRedis() {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const fail: Partial<Record<'set' | 'del' | 'mget' | 'keys' | 'zadd' | 'zrem' | 'zrange' | 'multiExec', boolean>> = {};

  function zsetOf(key: string): Map<string, number> {
    let z = zsets.get(key);
    if (!z) {
      z = new Map();
      zsets.set(key, z);
    }
    return z;
  }

  const set = async (key: string, value: string, ..._rest: unknown[]): Promise<string> => {
    if (fail.set) throw new Error('fake redis: set failed');
    strings.set(key, value);
    return 'OK';
  };
  const get = async (key: string): Promise<string | null> => strings.get(key) ?? null;
  const del = async (...keys: string[]): Promise<number> => {
    if (fail.del) throw new Error('fake redis: del failed');
    let n = 0;
    for (const k of keys) {
      if (strings.delete(k)) n++;
      zsets.delete(k);
    }
    return n;
  };
  const mget = async (...keys: string[]): Promise<(string | null)[]> => {
    if (fail.mget) throw new Error('fake redis: mget failed');
    return keys.map((k) => strings.get(k) ?? null);
  };
  const keys = async (pattern: string): Promise<string[]> => {
    if (fail.keys) throw new Error('fake redis: keys failed');
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return [...strings.keys()].filter((k) => k.startsWith(prefix));
  };
  const zadd = async (key: string, score: number, member: string): Promise<number> => {
    if (fail.zadd) throw new Error('fake redis: zadd failed');
    zsetOf(key).set(member, score);
    return 1;
  };
  const zrem = async (key: string, ...members: string[]): Promise<number> => {
    if (fail.zrem) throw new Error('fake redis: zrem failed');
    const z = zsetOf(key);
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  };
  const zrange = async (key: string, start: number, stop: number): Promise<string[]> => {
    if (fail.zrange) throw new Error('fake redis: zrange failed');
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
        if (fail.multiExec) throw new Error('fake redis: multi.exec failed');
        const results: unknown[] = [];
        for (const fn of queued) results.push(await fn());
        return results;
      },
    };
    return builder;
  }

  // persist.ts only ever issues these nine commands plus MULTI, so the fake stops there; the assertion
  // widens it to the full client interface while keeping `strings`/`zsets`/`fail` reachable for the
  // assertions and failure-injection below. The per-command signatures above are still hand-written to
  // match real Redis, so any drift between them and persist.ts's call sites is a type error here.
  const fake = { ...ops, multi, strings, zsets, fail };
  return fake as typeof fake & RedisLike;
}

const from: DuelPlayer = { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [] };

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    roomId: 'room-1',
    code: 'ABC123',
    slots: [
      { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [], side: 0, ready: false, connected: true },
      { accountId: 'b', name: 'Bob', publicId: '100000002', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [], side: 1, ready: false, connected: true },
    ],
    phase: 0,
    reapTimer: null,
    ...overrides,
  };
}

const queueEntry: QueueEntry = {
  accountId: 'q1', name: 'Q1', publicId: '100000010', equippedTitle: '', avatarId: '', equippedSkins: [], elo: 1000, enqueuedAt: 1000, platform: '', deck: [],
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

  it('a room key listed by keys() but gone by the time mget() runs (eviction race) is silently skipped', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:room:ghost2', JSON.stringify(makeRoom({ roomId: 'ghost2' })));
    const origMget = redis.mget;
    // Simulate the key vanishing between the keys() scan and the mget() read (Redis eviction race).
    redis.mget = (async (...keys: string[]) => (await origMget(...keys)).map(() => null)) as typeof redis.mget;
    const { rooms, lostAccountIds } = await loadAllRooms(redis);
    expect(rooms).toEqual([]);
    expect(lostAccountIds).toEqual([]);
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

  it('an invite key listed by keys() but gone by the time mget() runs (eviction race) is silently skipped', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:duel:ghost2', JSON.stringify({ inviteId: 'ghost2', from, toAccountId: 'b', expiresAt: 1 }));
    const origMget = redis.mget;
    redis.mget = (async (...keys: string[]) => (await origMget(...keys)).map(() => null)) as typeof redis.mget;
    const { invites, lostFromAccountIds } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([]);
    expect(lostFromAccountIds).toEqual([]);
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

// ── Redis-failure branches: every catch site swallows the error and logs via warn(), leaving the
// caller's in-memory state untouched (best-effort persistence must never throw). warn() logs through
// createLogger -> console.warn, so we spy on console.warn rather than reaching into the logger module.
describe('persist.ts — Redis failure branches (catch sites never throw)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('saveRoom: multi.exec() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    redis.fail.multiExec = true;
    await expect(saveRoom(redis, makeRoom())).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('saveRoom failed'));
    expect(redis.strings.size).toBe(0); // nothing committed
  });

  it('clearRoomAccount: redis.del() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    redis.fail.del = true;
    await expect(clearRoomAccount(redis, 'a')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clearRoomAccount failed'));
  });

  it('deleteRoom: redis.del() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    const room = makeRoom();
    await saveRoom(redis, room);
    redis.fail.del = true;
    await expect(deleteRoom(redis, room)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deleteRoom failed'));
    // best-effort failure means the previously-saved keys are still there (delete never landed)
    expect(redis.strings.has('nw:room:room-1')).toBe(true);
  });

  it('loadAllRooms: a malformed JSON room payload is skipped, parse-catch logs, other rooms still load', async () => {
    const redis = fakeRedis();
    await saveRoom(redis, makeRoom());
    redis.strings.set('nw:room:bad', '{not json');
    const { rooms, lostAccountIds } = await loadAllRooms(redis);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ roomId: 'room-1' });
    expect(lostAccountIds).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllRooms parse failed'));
  });

  it('loadAllRooms: stale-pointer cleanup del() rejecting is swallowed and logged, lost list still returned', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:roomByAccount:ghost', 'room-gone');
    redis.fail.del = true;
    const { rooms, lostAccountIds } = await loadAllRooms(redis);
    expect(rooms).toEqual([]);
    expect(lostAccountIds).toEqual(['ghost']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllRooms cleanup failed'));
    // cleanup del() failed, so the dangling pointer is still there (unlike the happy-path test above)
    expect(redis.strings.has('nw:roomByAccount:ghost')).toBe(true);
  });

  it('loadAllRooms: redis.keys() rejecting hits the outer catch and returns the empty default', async () => {
    const redis = fakeRedis();
    redis.fail.keys = true;
    const result = await loadAllRooms(redis);
    expect(result).toEqual({ rooms: [], lostAccountIds: [] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllRooms failed'));
  });

  it('saveQueueEntry: multi.exec() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    redis.fail.multiExec = true;
    await expect(saveQueueEntry(redis, queueEntry)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('saveQueueEntry failed'));
    expect(redis.strings.size).toBe(0);
  });

  it('deleteQueueEntry: multi.exec() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, queueEntry);
    redis.fail.multiExec = true;
    await expect(deleteQueueEntry(redis, 'q1')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deleteQueueEntry failed'));
    // best-effort failure means the previously-saved entry is still there
    expect(redis.strings.has('nw:queueEntry:q1')).toBe(true);
  });

  it('loadAllQueueEntries: a malformed JSON entry payload is skipped+reported lost, parse-catch logs', async () => {
    const redis = fakeRedis();
    await redis.zadd('nw:queue', 500, 'bad');
    redis.strings.set('nw:queueEntry:bad', '{not json');
    const { entries, lostAccountIds } = await loadAllQueueEntries(redis);
    expect(entries).toEqual([]);
    expect(lostAccountIds).toEqual(['bad']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllQueueEntries parse failed'));
  });

  it('loadAllQueueEntries: cleanup zrem() rejecting is swallowed and logged, lost list still returned', async () => {
    const redis = fakeRedis();
    await redis.zadd('nw:queue', 999, 'ghost');
    redis.fail.zrem = true;
    const { entries, lostAccountIds } = await loadAllQueueEntries(redis);
    expect(entries).toEqual([]);
    expect(lostAccountIds).toEqual(['ghost']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllQueueEntries cleanup failed'));
    // cleanup zrem() failed, so the dangling ZSET membership is still there
    expect(redis.zsets.get('nw:queue')?.has('ghost')).toBe(true);
  });

  it('loadAllQueueEntries: redis.zrange() rejecting hits the outer catch and returns the empty default', async () => {
    const redis = fakeRedis();
    redis.fail.zrange = true;
    const result = await loadAllQueueEntries(redis);
    expect(result).toEqual({ entries: [], lostAccountIds: [] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllQueueEntries failed'));
  });

  it('saveDuelInvite: multi.exec() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    redis.fail.multiExec = true;
    await expect(saveDuelInvite(redis, invite)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('saveDuelInvite failed'));
    expect(redis.strings.size).toBe(0);
  });

  it('deleteDuelInvite: redis.del() rejecting is swallowed and logged', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await saveDuelInvite(redis, invite);
    redis.fail.del = true;
    await expect(deleteDuelInvite(redis, 'inv-1', 'a')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deleteDuelInvite failed'));
    expect(redis.strings.has('nw:duel:inv-1')).toBe(true);
  });

  it('loadAllDuelInvites: a malformed JSON invite payload is skipped, parse-catch logs, other invites still load', async () => {
    const redis = fakeRedis();
    const invite = { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: 61_000 };
    await saveDuelInvite(redis, invite);
    redis.strings.set('nw:duel:bad', '{not json');
    const { invites, lostFromAccountIds } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([invite]);
    expect(lostFromAccountIds).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllDuelInvites parse failed'));
  });

  it('loadAllDuelInvites: stale-pointer cleanup del() rejecting is swallowed and logged, lost list still returned', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:duelByAccount:ghost', 'inv-gone');
    redis.fail.del = true;
    const { invites, lostFromAccountIds } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([]);
    expect(lostFromAccountIds).toEqual(['ghost']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllDuelInvites cleanup failed'));
    expect(redis.strings.has('nw:duelByAccount:ghost')).toBe(true);
  });

  it('loadAllDuelInvites: redis.keys() rejecting hits the outer catch and returns the empty default', async () => {
    const redis = fakeRedis();
    redis.fail.keys = true;
    const result = await loadAllDuelInvites(redis);
    expect(result).toEqual({ invites: [], lostFromAccountIds: [] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadAllDuelInvites failed'));
  });
});
