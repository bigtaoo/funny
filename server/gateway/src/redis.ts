// gateway Redis subscriber (S8-4b + B7, §8.4 horizontal fan-out push). gateway subscribes to GW_PUSH_REDIS_CHANNEL;
// worldsvc/matchsvc publish either {recipients, msg} (deliver a message to online recipients on this instance)
// or {kick} (evict a stale same-account connection this instance might be holding — 2026-07-18, closes the
// account-kick-only-works-on-one-instance gap). Multiple gateway instances each subscribe independently,
// providing natural cross-instance routing (SOC9) without a separate "which instance holds this account" registry.
//
// Reconnect: ioredis sets autoResubscribe=true (also the default), so after reconnection it re-subscribes to the same channel automatically;
// any push messages missed during the gap are recovered by the client via REST history fetch on next request (REST is authoritative; push is an accelerator).
//
// No Redis URL configured → returns null, real-time channel push AND cross-instance kick are both disabled
// (single-instance deployments don't need either — the local onConnection() eviction already covers it).
// Dynamic ioredis import: compiles even when ioredis is not installed (mirrors worldsvc/redis.ts).
//
// Presence tracking (2026-07-27 mid-term audit item 5/5): Gateway.presenceOf answers "is this account
// online" purely from its own in-process `conns` map, which is correct today (single gateway instance,
// ecosystem.config.cjs) but would under-report for accounts connected to a sibling instance if gateway is
// ever scaled out. Per-account presence keys (not a single SADD/SREM set — see markOnline below for why)
// let any instance answer the query for accounts connected elsewhere, reusing this same pub/sub connection
// rather than opening a third Redis client.
import { createLogger, GW_PUSH_REDIS_CHANNEL, type RedisLike } from '@nw/shared';
import type { PushMsg } from './matchsvcClient';

const log = createLogger('gateway:redis');

/** Fan-out envelope received from Redis: either a push (message + recipient list) or a kick (evict stale connection). */
type BroadcastEnvelope =
  | { recipients: string[]; msg: PushMsg; roomId?: string }
  | { kick: { accountId: string; originInstanceId: string; connSeq: number } };

/** TTL for a presence key: must be refreshed at least once per HEARTBEAT_MS (Gateway.ts, 30s) sweep to
 *  survive; if an instance crashes without closing its sockets cleanly, its accounts' presence self-heals
 *  (expires) within this window instead of staying "online" forever. */
const PRESENCE_TTL_MS = 60_000;

function presenceKey(accountId: string): string {
  return `nw:gw:online:${accountId}`;
}

export interface GatewaySubscriber {
  quit(): Promise<void>;
  /**
   * Tell every gateway instance (including this one — the caller must already have evicted any
   * LOCAL stale connection synchronously before calling this, so self-delivery is a harmless no-op
   * via originInstanceId) to close its own connection for accountId, if it holds one. Best-effort;
   * swallows publish failures (evicting a same-account session on another instance is not worth
   * failing the new login over — worst case a stale connection lingers until its own heartbeat times out).
   * connSeq (2026-08-04 fix): the originating connection's monotonic sequence (Gateway.nextConnSeq) — lets
   * a receiving instance tell a genuinely stale connection from one that actually won a simultaneous-
   * reconnect race, instead of evicting unconditionally (see Gateway.routeKick).
   */
  publishKick(accountId: string, originInstanceId: string, connSeq: number): Promise<void>;
  /** Call on connect: marks accountId online, visible to every gateway instance's presenceOf. */
  markOnline(accountId: string): Promise<void>;
  /** Call on disconnect: immediate cleanup (TTL would also catch it, but no reason to wait). */
  markOffline(accountId: string): Promise<void>;
  /** Call from the heartbeat sweep for every still-alive local connection, to keep its presence key from expiring. */
  refreshOnline(accountId: string): Promise<void>;
  /** Cross-instance batch presence check — Gateway.presenceOf calls this only for accountIds not found in
   *  its own local `conns` (so a single-instance deployment never touches Redis for this at all). */
  onlineAccountIds(accountIds: string[]): Promise<Set<string>>;
  /** Dedicated ioredis client for Gateway's per-connection control-message rate limiter (SERVER_LOGIC_AUDIT_
   *  2026-07-29 known-gap #4). A separate connection from subClient (subscriber mode, can't issue other
   *  commands) and pubClient (already used for kick/presence pub-sub traffic) — reused via createRateLimiter
   *  from @nw/shared, same as metaserver's auth/telemetry/save limiters. */
  readonly rateLimitClient: RedisLike;
}

/**
 * Connect and subscribe to GW_PUSH_REDIS_CHANNEL. Push envelopes are consumed by Gateway.routeBroadcast
 * (pushes only to locally-online recipients); kick envelopes by onKick (closes a locally-held stale
 * connection for the given accountId, skipping ones this same instance just originated).
 * On connection failure → returns null (real-time push + cross-instance kick both degraded).
 * autoResubscribe=true ensures Redis re-subscription after reconnection (B7 acceptance criterion).
 */
export async function connectGatewaySubscriber(
  url: string | undefined,
  onBroadcast: (recipients: string[], msg: PushMsg, roomId?: string) => void,
  onKick: (accountId: string, originInstanceId: string, connSeq: number) => void,
): Promise<GatewaySubscriber | null> {
  if (!url) return null;
  try {
    const spec = 'ioredis';
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const subClient = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      autoResubscribe: true, // re-subscribe automatically after reconnection (ioredis default is already true; explicit for auditability)
    });
    subClient.on('error', (e: Error) => log.error('redis error', { err: e.message }));
    subClient.on('ready', () => log.info('redis ready / resubscribed', { channel: GW_PUSH_REDIS_CHANNEL }));
    subClient.on('message', (_channel: string, payload: string) => {
      try {
        const env = JSON.parse(payload) as BroadcastEnvelope;
        if ('kick' in env && env.kick) onKick(env.kick.accountId, env.kick.originInstanceId, env.kick.connSeq);
        else if ('recipients' in env && Array.isArray(env.recipients) && env.msg) onBroadcast(env.recipients, env.msg, env.roomId);
      } catch (e) {
        log.warn('bad broadcast payload', { err: (e as Error).message });
      }
    });
    await subClient.subscribe(GW_PUSH_REDIS_CHANNEL);
    log.info('subscribed', { channel: GW_PUSH_REDIS_CHANNEL });

    // Publishing requires a connection not in subscriber mode — duplicate() shares connection
    // options but opens its own socket (an ioredis client can't issue non-pubsub commands once subscribed).
    const pubClient = subClient.duplicate();
    pubClient.on('error', (e: Error) => log.error('redis publish-connection error', { err: e.message }));

    // Dedicated connection for the rate limiter's EVAL calls — kept separate from pubClient so a bursty
    // rate-limit workload can't head-of-line block presence/kick publishes (or vice versa) on the same socket.
    const rateLimitClient = subClient.duplicate();
    rateLimitClient.on('error', (e: Error) => log.error('redis rate-limit-connection error', { err: e.message }));

    return {
      quit: async () => {
        await Promise.allSettled([subClient.quit(), pubClient.quit(), rateLimitClient.quit()]);
      },
      rateLimitClient,
      publishKick: async (accountId, originInstanceId, connSeq) => {
        try {
          await pubClient.publish(GW_PUSH_REDIS_CHANNEL, JSON.stringify({ kick: { accountId, originInstanceId, connSeq } }));
        } catch (e) {
          log.warn('kick publish failed', { accountId, err: (e as Error).message });
        }
      },
      markOnline: async (accountId) => {
        try {
          await pubClient.set(presenceKey(accountId), '1', 'PX', PRESENCE_TTL_MS);
        } catch (e) {
          log.warn('presence markOnline failed', { accountId, err: (e as Error).message });
        }
      },
      markOffline: async (accountId) => {
        try {
          await pubClient.del(presenceKey(accountId));
        } catch (e) {
          log.warn('presence markOffline failed', { accountId, err: (e as Error).message });
        }
      },
      refreshOnline: async (accountId) => {
        try {
          await pubClient.pexpire(presenceKey(accountId), PRESENCE_TTL_MS);
        } catch (e) {
          log.warn('presence refresh failed', { accountId, err: (e as Error).message });
        }
      },
      onlineAccountIds: async (accountIds) => {
        if (accountIds.length === 0) return new Set();
        try {
          const pipeline = pubClient.pipeline();
          for (const id of accountIds) pipeline.exists(presenceKey(id));
          const results = await pipeline.exec();
          const online = new Set<string>();
          accountIds.forEach((id, i) => {
            if (results?.[i]?.[1] === 1) online.add(id);
          });
          return online;
        } catch (e) {
          log.warn('presence batch query failed', { count: accountIds.length, err: (e as Error).message });
          return new Set(); // fail closed: an unreachable Redis reports these accounts offline, not online
        }
      },
    };
  } catch (e) {
    log.error('subscribe failed; channel real-time push disabled', { url, err: (e as Error).message });
    return null;
  }
}
