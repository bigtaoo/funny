// Redis persistence for matchsvc pre-match state (matchsvc-prematch-persist, 2026-07-29): matchsvc is
// otherwise a pure in-memory service (M17, no DB connections) — friendly rooms / ranked queue / "切磋"
// duel invites all lived only in the five Maps/array in Matchsvc.ts + Matchmaking.ts, so a matchsvc
// restart silently dropped every player currently in the pre-match flow (only *post*-pairing state had
// a Redis safety net, via shared/src/activeMatch.ts). This module writes the same state through to Redis
// at every existing in-memory mutation point (create/join/ready/leave/connect/disconnect/enqueue/dequeue/
// invite/respond/expire/cancel — see Matchsvc.ts/Matchmaking.ts call sites) so Matchsvc.rehydrate() can
// load it back into memory on the next startup, before internal HTTP traffic is accepted (index.ts).
//
// Same backend conventions as activeMatch.ts/dailyCounter.ts: reuses matchsvc's single existing Redis
// connection (connectActiveMatchRedis in index.ts — no second connection opened here), every function is
// a null-safe no-op when redis is unconfigured (pure in-memory behaviour, unchanged from before this
// module existed — NW_REDIS_URL remains fully optional for matchsvc; see MatchsvcOpts.redis doc comment
// in Matchsvc.ts), and network/serialization failures are caught and logged rather than thrown
// (best-effort persistence must never block or crash the in-memory mutation it shadows).
import { createLogger, type RedisLike } from '@nw/shared';
import type { Room, DuelPlayer } from './Matchsvc';
import type { QueueEntry } from './Matchmaking';

const log = createLogger('matchsvc:persist');

/** Sliding TTL for room state — generous relative to REAP_MS (60s) because a friendly lobby can sit
 *  waiting on a friend to type in the room code for a long time before anyone disconnects; this only
 *  bounds storage for abandoned rooms nobody ever tore down (crash / lost leave message), mirroring
 *  activeMatch.ts's ACTIVE_MATCH_TTL_SEC being much larger than any single mutation's own timeout. */
export const ROOM_TTL_SEC = 3600;
/** Duel TTL is sized to the invite's own DUEL_TIMEOUT_MS (60s, Matchsvc.ts) plus slack — the Redis key
 *  should expire at roughly the same time the in-memory invite would time out anyway, not longer. */
export const DUEL_TTL_SEC = 75;

/** Room minus its non-serializable live timer handle (reconstructed fresh on rehydrate). */
export type PersistedRoom = Omit<Room, 'reapTimer'>;
/** DuelInvite minus its non-serializable live timer handle, plus the wall-clock deadline the timer was
 *  counting down to (rehydrate re-arms a fresh setTimeout for whatever's left of this window). */
export interface PersistedDuelInvite {
  inviteId: string;
  from: DuelPlayer;
  toAccountId: string;
  expiresAt: number;
}

const roomKey = (roomId: string): string => `nw:room:${roomId}`;
const roomByAccountKey = (accountId: string): string => `nw:roomByAccount:${accountId}`;
const ROOM_KEY_PREFIX = 'nw:room:';
const ROOM_BY_ACCOUNT_PREFIX = 'nw:roomByAccount:';

const QUEUE_ZKEY = 'nw:queue';
const queueEntryKey = (accountId: string): string => `nw:queueEntry:${accountId}`;

const duelKey = (inviteId: string): string => `nw:duel:${inviteId}`;
const duelByAccountKey = (fromAccountId: string): string => `nw:duelByAccount:${fromAccountId}`;
const DUEL_KEY_PREFIX = 'nw:duel:';
const DUEL_BY_ACCOUNT_PREFIX = 'nw:duelByAccount:';

function warn(op: string, err: unknown, extra?: Record<string, unknown>): void {
  log.warn(`${op} failed (best-effort, in-memory state unaffected)`, { err: (err as Error).message, ...extra });
}

// ── Friendly rooms ──────────────────────────────────────────────────────────

/** Write-through on every room mutation that should survive a restart (create/join/ready/leave-that-keeps-
 *  the-room-alive/connect/disconnect). Slots are written under their own reverse-lookup key too so a
 *  rehydrate can resolve "which room was accountId in" without scanning every room. */
export async function saveRoom(redis: RedisLike | null, room: Room): Promise<void> {
  if (!redis) return;
  try {
    const { reapTimer: _reapTimer, ...persisted } = room;
    const json = JSON.stringify(persisted);
    const multi = redis.multi();
    multi.set(roomKey(room.roomId), json, 'EX', ROOM_TTL_SEC);
    for (const s of room.slots) multi.set(roomByAccountKey(s.accountId), room.roomId, 'EX', ROOM_TTL_SEC);
    await multi.exec();
  } catch (e) {
    warn('saveRoom', e, { roomId: room.roomId });
  }
}

/** One account left a room that stays alive for the other player (removeFromRoom's non-empty branch) —
 *  only its own reverse-lookup key needs clearing; the caller follows up with saveRoom(room) for the
 *  mutated remaining state (or deleteRoom via destroyRoom if that was the last slot). */
export async function clearRoomAccount(redis: RedisLike | null, accountId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(roomByAccountKey(accountId));
  } catch (e) {
    warn('clearRoomAccount', e, { accountId });
  }
}

/** Room fully destroyed (last player left / both-ready auto-start / reap timer). `slots` must be the
 *  pre-destroy member list — destroyRoom() reads room.slots before clearing it, same as its own
 *  accountRoom cleanup loop, so passing `room` straight through is always correct. */
export async function deleteRoom(redis: RedisLike | null, room: Pick<Room, 'roomId' | 'slots'>): Promise<void> {
  if (!redis) return;
  try {
    const keys = [roomKey(room.roomId), ...room.slots.map((s) => roomByAccountKey(s.accountId))];
    if (keys.length > 0) await redis.del(...keys);
  } catch (e) {
    warn('deleteRoom', e, { roomId: room.roomId });
  }
}

export interface RoomRehydrateResult {
  rooms: PersistedRoom[];
  /** accountIds whose roomByAccount pointer survived but the room record itself did not (partial write
   *  that never completed, or an eviction under Redis memory pressure hit one key but not the other —
   *  see docker-compose's allkeys-lru policy). matchsvc pushes prematch_lost(context:'room') to these. */
  lostAccountIds: string[];
}

/** Rehydrate: every room currently in Redis. A one-time KEYS scan at startup is simpler than cursor-SCAN
 *  bookkeeping and doesn't carry KEYS's usual "don't block a big shared keyspace" risk here — matchsvc
 *  never has more than a handful of concurrent lobby rooms (this is its own small, private namespace,
 *  not a multi-tenant collection). */
export async function loadAllRooms(redis: RedisLike | null): Promise<RoomRehydrateResult> {
  if (!redis) return { rooms: [], lostAccountIds: [] };
  try {
    const roomKeys: string[] = await redis.keys(`${ROOM_KEY_PREFIX}*`);
    const rooms: PersistedRoom[] = [];
    if (roomKeys.length > 0) {
      const jsons: (string | null)[] = await redis.mget(...roomKeys);
      for (const raw of jsons) {
        if (!raw) continue;
        try {
          rooms.push(JSON.parse(raw) as PersistedRoom);
        } catch (e) {
          warn('loadAllRooms parse', e);
        }
      }
    }
    const byAccountKeys: string[] = await redis.keys(`${ROOM_BY_ACCOUNT_PREFIX}*`);
    const lost: string[] = [];
    if (byAccountKeys.length > 0) {
      const roomIds: (string | null)[] = await redis.mget(...byAccountKeys);
      const liveRoomIds = new Set(rooms.map((r) => r.roomId));
      const staleKeys: string[] = [];
      for (let i = 0; i < byAccountKeys.length; i++) {
        const roomId = roomIds[i];
        const accountId = byAccountKeys[i]!.slice(ROOM_BY_ACCOUNT_PREFIX.length);
        if (!roomId || !liveRoomIds.has(roomId)) {
          lost.push(accountId);
          staleKeys.push(byAccountKeys[i]!);
        }
      }
      if (staleKeys.length > 0) {
        try {
          await redis.del(...staleKeys);
        } catch (e) {
          warn('loadAllRooms cleanup', e);
        }
      }
    }
    return { rooms, lostAccountIds: lost };
  } catch (e) {
    warn('loadAllRooms', e);
    return { rooms: [], lostAccountIds: [] };
  }
}

// ── Ranked queue ─────────────────────────────────────────────────────────────

/** Write-through on enqueue. No TTL — the in-memory queue has no natural expiry either (entries only
 *  leave on explicit dequeue: pairing / cancel / bot-fallback timeout), so the Redis mirror shouldn't
 *  either; a stuck entry is a bug to fix, not something a TTL should silently paper over. */
export async function saveQueueEntry(redis: RedisLike | null, entry: QueueEntry): Promise<void> {
  if (!redis) return;
  try {
    const multi = redis.multi();
    multi.zadd(QUEUE_ZKEY, entry.enqueuedAt, entry.accountId);
    multi.set(queueEntryKey(entry.accountId), JSON.stringify(entry));
    await multi.exec();
  } catch (e) {
    warn('saveQueueEntry', e, { accountId: entry.accountId });
  }
}

/** Write-through on dequeue (paired / cancelled / bot-fallback timeout). */
export async function deleteQueueEntry(redis: RedisLike | null, accountId: string): Promise<void> {
  if (!redis) return;
  try {
    const multi = redis.multi();
    multi.zrem(QUEUE_ZKEY, accountId);
    multi.del(queueEntryKey(accountId));
    await multi.exec();
  } catch (e) {
    warn('deleteQueueEntry', e, { accountId });
  }
}

export interface QueueRehydrateResult {
  /** Sorted by enqueuedAt (ZSET order), so re-admitting them preserves original wait order. */
  entries: QueueEntry[];
  /** accountIds whose ZSET membership survived but the paired entry data did not (same partial-write /
   *  eviction reasoning as RoomRehydrateResult.lostAccountIds). matchsvc pushes
   *  prematch_lost(context:'queue') to these and drops the dangling ZSET membership. */
  lostAccountIds: string[];
}

export async function loadAllQueueEntries(redis: RedisLike | null): Promise<QueueRehydrateResult> {
  if (!redis) return { entries: [], lostAccountIds: [] };
  try {
    const accountIds: string[] = await redis.zrange(QUEUE_ZKEY, 0, -1);
    if (accountIds.length === 0) return { entries: [], lostAccountIds: [] };
    const jsons: (string | null)[] = await redis.mget(...accountIds.map(queueEntryKey));
    const entries: QueueEntry[] = [];
    const lost: string[] = [];
    for (let i = 0; i < accountIds.length; i++) {
      const raw = jsons[i];
      const accountId = accountIds[i]!;
      if (!raw) {
        lost.push(accountId);
        continue;
      }
      try {
        entries.push(JSON.parse(raw) as QueueEntry);
      } catch (e) {
        warn('loadAllQueueEntries parse', e, { accountId });
        lost.push(accountId);
      }
    }
    if (lost.length > 0) {
      try {
        await redis.zrem(QUEUE_ZKEY, ...lost);
      } catch (e) {
        warn('loadAllQueueEntries cleanup', e);
      }
    }
    return { entries, lostAccountIds: lost };
  } catch (e) {
    warn('loadAllQueueEntries', e);
    return { entries: [], lostAccountIds: [] };
  }
}

// ── Friend-challenge ("切磋") duel invites ────────────────────────────────────

/** Write-through on invite creation. Fixed TTL (not derived from the in-memory timer's actual remaining
 *  time, since this is only ever called once, at creation) — always covers the DUEL_TIMEOUT_MS window
 *  plus slack. */
export async function saveDuelInvite(redis: RedisLike | null, invite: PersistedDuelInvite): Promise<void> {
  if (!redis) return;
  try {
    const json = JSON.stringify(invite);
    const multi = redis.multi();
    multi.set(duelKey(invite.inviteId), json, 'EX', DUEL_TTL_SEC);
    multi.set(duelByAccountKey(invite.from.accountId), invite.inviteId, 'EX', DUEL_TTL_SEC);
    await multi.exec();
  } catch (e) {
    warn('saveDuelInvite', e, { inviteId: invite.inviteId });
  }
}

/** Write-through on invite resolution (accepted / declined / expired / replaced by a re-invite). */
export async function deleteDuelInvite(redis: RedisLike | null, inviteId: string, fromAccountId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(duelKey(inviteId), duelByAccountKey(fromAccountId));
  } catch (e) {
    warn('deleteDuelInvite', e, { inviteId });
  }
}

export interface DuelRehydrateResult {
  invites: PersistedDuelInvite[];
  /** fromAccountIds whose duelByAccount pointer survived but the invite record itself did not (same
   *  partial-write / eviction reasoning as the room/queue variants). matchsvc pushes
   *  prematch_lost(context:'duel') to these (the *inviter* — the invitee never had matchsvc-side state
   *  of their own to lose; a live incoming-invite banner on their client just silently expires, same as
   *  a normal unanswered invite). */
  lostFromAccountIds: string[];
}

export async function loadAllDuelInvites(redis: RedisLike | null): Promise<DuelRehydrateResult> {
  if (!redis) return { invites: [], lostFromAccountIds: [] };
  try {
    const inviteKeys: string[] = await redis.keys(`${DUEL_KEY_PREFIX}*`);
    const invites: PersistedDuelInvite[] = [];
    if (inviteKeys.length > 0) {
      const jsons: (string | null)[] = await redis.mget(...inviteKeys);
      for (const raw of jsons) {
        if (!raw) continue;
        try {
          invites.push(JSON.parse(raw) as PersistedDuelInvite);
        } catch (e) {
          warn('loadAllDuelInvites parse', e);
        }
      }
    }
    const byAccountKeys: string[] = await redis.keys(`${DUEL_BY_ACCOUNT_PREFIX}*`);
    const lost: string[] = [];
    if (byAccountKeys.length > 0) {
      const inviteIds: (string | null)[] = await redis.mget(...byAccountKeys);
      const liveInviteIds = new Set(invites.map((i) => i.inviteId));
      const staleKeys: string[] = [];
      for (let i = 0; i < byAccountKeys.length; i++) {
        const inviteId = inviteIds[i];
        const fromAccountId = byAccountKeys[i]!.slice(DUEL_BY_ACCOUNT_PREFIX.length);
        if (!inviteId || !liveInviteIds.has(inviteId)) {
          lost.push(fromAccountId);
          staleKeys.push(byAccountKeys[i]!);
        }
      }
      if (staleKeys.length > 0) {
        try {
          await redis.del(...staleKeys);
        } catch (e) {
          warn('loadAllDuelInvites cleanup', e);
        }
      }
    }
    return { invites, lostFromAccountIds: lost };
  } catch (e) {
    warn('loadAllDuelInvites', e);
    return { invites: [], lostFromAccountIds: [] };
  }
}
