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
import { createLogger, GW_PUSH_REDIS_CHANNEL } from '@nw/shared';
import type { PushMsg } from './matchsvcClient';

const log = createLogger('gateway:redis');

/** Fan-out envelope received from Redis: either a push (message + recipient list) or a kick (evict stale connection). */
type BroadcastEnvelope =
  | { recipients: string[]; msg: PushMsg }
  | { kick: { accountId: string; originInstanceId: string } };

export interface GatewaySubscriber {
  quit(): Promise<void>;
  /**
   * Tell every gateway instance (including this one — the caller must already have evicted any
   * LOCAL stale connection synchronously before calling this, so self-delivery is a harmless no-op
   * via originInstanceId) to close its own connection for accountId, if it holds one. Best-effort;
   * swallows publish failures (evicting a same-account session on another instance is not worth
   * failing the new login over — worst case a stale connection lingers until its own heartbeat times out).
   */
  publishKick(accountId: string, originInstanceId: string): Promise<void>;
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
  onBroadcast: (recipients: string[], msg: PushMsg) => void,
  onKick: (accountId: string, originInstanceId: string) => void,
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
        if ('kick' in env && env.kick) onKick(env.kick.accountId, env.kick.originInstanceId);
        else if ('recipients' in env && Array.isArray(env.recipients) && env.msg) onBroadcast(env.recipients, env.msg);
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

    return {
      quit: async () => {
        await Promise.allSettled([subClient.quit(), pubClient.quit()]);
      },
      publishKick: async (accountId, originInstanceId) => {
        try {
          await pubClient.publish(GW_PUSH_REDIS_CHANNEL, JSON.stringify({ kick: { accountId, originInstanceId } }));
        } catch (e) {
          log.warn('kick publish failed', { accountId, err: (e as Error).message });
        }
      },
    };
  } catch (e) {
    log.error('subscribe failed; channel real-time push disabled', { url, err: (e as Error).message });
    return null;
  }
}
