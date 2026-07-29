// matchsvc-prematch-persist (2026-07-29): Matchsvc write-through (mutation → Redis) and rehydrate
// (Redis → in-memory + active notification) integration tests, against a fake in-memory Redis client
// (no real connection needed — same style as shared/test/activeMatch.test.ts / test/persist.test.ts).
import { describe, it, expect } from 'vitest';
import { Matchsvc, type PushMsg } from '../src/Matchsvc';
import { GameRegistry } from '../src/GameRegistry';
import { saveRoom, saveQueueEntry, saveDuelInvite, loadAllRooms, loadAllQueueEntries, loadAllDuelInvites } from '../src/persist';
import type { Room, DuelPlayer } from '../src/Matchsvc';
import type { QueueEntry } from '../src/Matchmaking';

const KEY = 'test-internal-key';
const GAME_URL = 'ws://game:8081/ws';

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

function makeSvc(redis: ReturnType<typeof fakeRedis> | null, now?: () => number) {
  const pushed: { acc: string; msg: PushMsg }[] = [];
  const games = new GameRegistry(() => 0, GAME_URL);
  const svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, {
    autoTick: false,
    redis,
    ...(now ? { now } : {}),
  });
  const pushesTo = (acc: string): PushMsg[] => pushed.filter((p) => p.acc === acc).map((p) => p.msg);
  return { svc, pushed, pushesTo };
}

/** Write-through calls (saveRoom/saveQueueEntry/saveDuelInvite) are fire-and-forget (`void ...(...)`)
 *  chains of several sequential `await`s (multi().exec()'s per-op loop) — a single `await
 *  Promise.resolve()` doesn't reliably drain all of them. A macrotask boundary does: Node always
 *  drains the entire microtask queue (however deep) before running the next macrotask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Matchsvc write-through to Redis (matchsvc-prematch-persist)', () => {
  it('roomCreate/roomJoin/roomReady each mirror the room to Redis', async () => {
    const redis = fakeRedis();
    const { svc } = makeSvc(redis);
    svc.roomCreate('a', 'Alice', '100000001');
    await flush();
    expect(redis.strings.has('nw:room:' + [...redis.strings.keys()].find((k) => k.startsWith('nw:room:'))!.slice('nw:room:'.length))).toBe(true);
    const roomId = JSON.parse([...redis.strings.values()].find((v) => v.includes('"code"'))!).roomId as string;
    expect(redis.strings.get('nw:roomByAccount:a')).toBe(roomId);

    svc.roomJoin('b', 'Bob', '100000002', JSON.parse(redis.strings.get(`nw:room:${roomId}`)!).code);
    await flush();
    expect(redis.strings.get('nw:roomByAccount:b')).toBe(roomId);
    expect(JSON.parse(redis.strings.get(`nw:room:${roomId}`)!).slots).toHaveLength(2);

    svc.roomReady('a', true);
    await flush();
    expect(JSON.parse(redis.strings.get(`nw:room:${roomId}`)!).slots[0].ready).toBe(true);
  });

  it('roomLeave (one of two players) clears just that account, then the last leaver destroys the room', async () => {
    const redis = fakeRedis();
    const { svc, pushesTo } = makeSvc(redis);
    svc.roomCreate('a', 'Alice', '100000001');
    const code = (pushesTo('a')[0] as { code: string }).code;
    svc.roomJoin('b', 'Bob', '100000002', code);
    await flush();
    const roomId = redis.strings.get('nw:roomByAccount:a')!;

    svc.roomLeave('b');
    await flush();
    expect(redis.strings.has('nw:roomByAccount:b')).toBe(false);
    expect(redis.strings.has('nw:roomByAccount:a')).toBe(true); // room survives for the remaining player
    expect(JSON.parse(redis.strings.get(`nw:room:${roomId}`)!).slots).toHaveLength(1);

    svc.roomLeave('a'); // last player leaves -> room fully destroyed
    await flush();
    expect(redis.strings.has(`nw:room:${roomId}`)).toBe(false);
    expect(redis.strings.has('nw:roomByAccount:a')).toBe(false);
  });

  it('enqueue mirrors to the ZSET + entry payload; a successful pair clears both', async () => {
    const redis = fakeRedis();
    const { svc } = makeSvc(redis);
    svc.enqueue('a', 'Alice', '100000001', 1000);
    await flush();
    expect(redis.zsets.get('nw:queue')?.has('a')).toBe(true);
    expect(redis.strings.has('nw:queueEntry:a')).toBe(true);

    svc.enqueue('b', 'Bob', '100000002', 1010); // within ELO window -> pairs immediately
    await flush();
    expect(redis.zsets.get('nw:queue')?.size ?? 0).toBe(0);
    expect(redis.strings.has('nw:queueEntry:a')).toBe(false);
    expect(redis.strings.has('nw:queueEntry:b')).toBe(false);
  });

  it('roomLeave while only queued (cancel search) clears the Redis queue mirror', async () => {
    const redis = fakeRedis();
    const { svc } = makeSvc(redis);
    svc.enqueue('a', 'Alice', '100000001', 1000);
    await flush();
    svc.roomLeave('a'); // cancelQueue's server-side entry point
    await flush();
    expect(redis.zsets.get('nw:queue')?.has('a')).toBeFalsy();
    expect(redis.strings.has('nw:queueEntry:a')).toBe(false);
  });

  it('duelInvite/duelRespond(decline) mirror to and then clear Redis', async () => {
    const redis = fakeRedis();
    const { svc, pushesTo } = makeSvc(redis);
    svc.duelInvite({ accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', deck: [] }, 'b');
    await flush();
    const inviteId = (pushesTo('b')[0] as { inviteId: string }).inviteId;
    expect(redis.strings.has(`nw:duel:${inviteId}`)).toBe(true);
    expect(redis.strings.has('nw:duelByAccount:a')).toBe(true);

    svc.duelRespond('b', inviteId, false);
    await flush();
    expect(redis.strings.has(`nw:duel:${inviteId}`)).toBe(false);
    expect(redis.strings.has('nw:duelByAccount:a')).toBe(false);
  });
});

describe('Matchsvc.rehydrate() - no redis configured', () => {
  it('resolves immediately, no state, no pushes', async () => {
    const { svc, pushed } = makeSvc(null);
    await svc.rehydrate();
    expect(pushed).toEqual([]);
    expect(svc.stats()).toEqual({ queue: 0, rooms: 0, gameInstances: expect.any(Number), gameLoad: 0 });
  });
});

describe('Matchsvc.rehydrate() - rooms', () => {
  function seedRoom(): Room {
    return {
      roomId: 'room-1',
      code: 'ABC123',
      phase: 0,
      reapTimer: null,
      slots: [
        { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', deck: [], side: 0, ready: false, connected: true },
        { accountId: 'b', name: 'Bob', publicId: '100000002', equippedTitle: '', avatarId: '', deck: [], side: 1, ready: false, connected: true },
      ],
    };
  }

  it('rebuilds the room in memory and actively pushes room_state to every slot', async () => {
    const redis = fakeRedis();
    await saveRoom(redis, seedRoom());

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    expect(svc.stats().rooms).toBe(1);
    expect(pushesTo('a').some((m) => m.kind === 'room_state')).toBe(true);
    expect(pushesTo('b').some((m) => m.kind === 'room_state')).toBe(true);

    // In-memory Maps (accountRoom/byCode) were correctly rebuilt, not just the rooms Map -- roomLeave
    // must actually find and tear down the room for both players, proving accountRoom resolves for each.
    svc.roomLeave('a');
    await flush();
    svc.roomLeave('b');
    await flush();
    expect(await loadAllRooms(redis)).toMatchObject({ rooms: [], lostAccountIds: [] });
  });

  it('a dangling roomByAccount pointer (room data lost) pushes prematch_lost{context:room}', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:roomByAccount:ghost', 'room-gone');

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    const msgs = pushesTo('ghost');
    expect(msgs).toEqual([{ kind: 'prematch_lost', context: 'room' }]);
  });
});

describe('Matchsvc.rehydrate() - ranked queue', () => {
  const entry = (accountId: string, elo: number, enqueuedAt: number): QueueEntry => ({
    accountId, name: accountId, publicId: '1', equippedTitle: '', avatarId: '', elo, enqueuedAt, platform: '', deck: [],
  });

  it('a single rehydrated entry stays queued and gets a queue_state refresh push', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, entry('solo', 1000, 500));

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    expect(svc.stats().queue).toBe(1);
    expect(pushesTo('solo')).toEqual([{ kind: 'queue_state' }]);
  });

  it('two rehydrated entries within the ELO window pair immediately (match_found, not queue_state)', async () => {
    const redis = fakeRedis();
    await saveQueueEntry(redis, entry('a', 1000, 500));
    await saveQueueEntry(redis, entry('b', 1010, 600));

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    expect(svc.stats().queue).toBe(0);
    expect(pushesTo('a').some((m) => m.kind === 'match_found')).toBe(true);
    expect(pushesTo('b').some((m) => m.kind === 'match_found')).toBe(true);
    expect(pushesTo('a').some((m) => m.kind === 'queue_state')).toBe(false);
    // Redis mirror cleared for both, same as a normal live pairing would.
    expect((await loadAllQueueEntries(redis)).entries).toEqual([]);
  });

  it('a dangling ZSET member (entry data lost) pushes prematch_lost{context:queue}', async () => {
    const redis = fakeRedis();
    await redis.zadd('nw:queue', 999, 'ghost');

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    expect(pushesTo('ghost')).toEqual([{ kind: 'prematch_lost', context: 'queue' }]);
    expect(svc.stats().queue).toBe(0);
  });
});

describe('Matchsvc.rehydrate() - duel invites', () => {
  const from: DuelPlayer = { accountId: 'a', name: 'Alice', publicId: '100000001', equippedTitle: '', avatarId: '', deck: [] };

  it('a still-live invite is re-armed and re-pushed as duel_invited to the invitee, and remains respondable', async () => {
    const redis = fakeRedis();
    const NOW = 10_000;
    await saveDuelInvite(redis, { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: NOW + 30_000 });

    const { svc, pushesTo } = makeSvc(redis, () => NOW);
    await svc.rehydrate();

    expect(pushesTo('b')).toEqual([{ kind: 'duel_invited', inviteId: 'inv-1', fromPublicId: '100000001', fromName: 'Alice' }]);

    // In-memory duelInvites/pendingDuelByAccount were correctly rebuilt -- accepting must actually work.
    svc.duelRespond('b', 'inv-1', true, { accountId: 'b', name: 'Bob', publicId: '100000002', equippedTitle: '', avatarId: '', deck: [] });
    expect(pushesTo('a').some((m) => m.kind === 'match_found')).toBe(true);
    expect(pushesTo('b').some((m) => m.kind === 'match_found')).toBe(true);
  });

  it('an invite whose window already closed is resolved exactly like a normal timeout', async () => {
    const redis = fakeRedis();
    const NOW = 100_000;
    await saveDuelInvite(redis, { inviteId: 'inv-1', from, toAccountId: 'b', expiresAt: NOW - 1 }); // already past

    const { svc, pushesTo } = makeSvc(redis, () => NOW);
    await svc.rehydrate();

    expect(pushesTo('a')).toEqual([{ kind: 'duel_cancelled', inviteId: 'inv-1', reason: 'timeout' }]);
    expect(pushesTo('b')).toEqual([]); // invitee never had matchsvc-side state of their own to notify
    const { invites } = await loadAllDuelInvites(redis);
    expect(invites).toEqual([]); // Redis mirror cleared
  });

  it('a dangling duelByAccount pointer (invite data lost) pushes prematch_lost{context:duel} to the inviter', async () => {
    const redis = fakeRedis();
    redis.strings.set('nw:duelByAccount:ghost', 'inv-gone');

    const { svc, pushesTo } = makeSvc(redis);
    await svc.rehydrate();

    expect(pushesTo('ghost')).toEqual([{ kind: 'prematch_lost', context: 'duel' }]);
  });
});
