// Cross-login match resume (login-reconnect-prompt, 2026-07-14). matchsvc writes one entry per
// player when a match starts (startMatch); metaserver deletes both entries when gameserver reports
// the match as finished (/internal/match/report) and reads an account's entry from getSave() so the
// client can offer "resume your match?" right after login — independent of the existing mid-session
// conn_resume/conn_resync grace-period reconnect, which only covers a live WS session.
//
// Redis is optional infrastructure here (mirrors gateway/worldsvc/roomRegistry.ts): no URL configured,
// or connection failure, degrades to "feature disabled" rather than breaking login/matchmaking.
import { createLogger } from './logger';

const log = createLogger('shared:activeMatch');

/** Enough to reconnect straight into the room: gameserver's initial handshake ignores ticket exp (M16),
 *  so the original ticket signed at match start remains usable for the lifetime of the match. */
export interface ActiveMatchRecord {
  roomId: string;
  gameUrl: string;
  ticket: string;
  mode: 'friendly' | 'ranked';
}

/** Safety-net TTL: normal cleanup happens explicitly on /internal/match/report; this only bounds
 *  leaks from crashes/report loss so a stale entry can't haunt a player forever. */
export const ACTIVE_MATCH_TTL_SEC = 3600;

export function activeMatchKey(accountId: string): string {
  return `nw:activeMatch:${accountId}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RedisLike = any;

/**
 * Connect to Redis for active-match tracking. Returns null when unconfigured or unreachable
 * (dynamic ioredis import — compiles even when ioredis isn't installed, same pattern as
 * gateway/src/redis.ts and roomRegistry.ts's createRedisRoomRegistry).
 */
export async function connectActiveMatchRedis(url: string | null): Promise<RedisLike | null> {
  if (!url) return null;
  try {
    const spec = 'ioredis';
    const mod: any = await import(spec); // eslint-disable-line @typescript-eslint/no-explicit-any
    const Redis = mod.default ?? mod;
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
    client.on('error', (e: Error) => log.error('redis error', { err: e.message }));
    return client;
  } catch (e) {
    log.error('connect failed; active-match tracking disabled', { url, err: (e as Error).message });
    return null;
  }
}

/** Write the active-match record for one accountId (no-op when redis is null). */
export async function setActiveMatch(redis: RedisLike | null, accountId: string, record: ActiveMatchRecord): Promise<void> {
  if (!redis) return;
  await redis.set(activeMatchKey(accountId), JSON.stringify(record), 'EX', ACTIVE_MATCH_TTL_SEC);
}

/** Read an accountId's active-match record, or null if none / redis unavailable. */
export async function getActiveMatch(redis: RedisLike | null, accountId: string): Promise<ActiveMatchRecord | null> {
  if (!redis) return null;
  const raw = await redis.get(activeMatchKey(accountId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveMatchRecord;
  } catch {
    return null;
  }
}

/** Clear one or more accountIds' active-match records (no-op when redis is null or list is empty). */
export async function clearActiveMatch(redis: RedisLike | null, ...accountIds: string[]): Promise<void> {
  if (!redis || accountIds.length === 0) return;
  await redis.del(...accountIds.map(activeMatchKey));
}
