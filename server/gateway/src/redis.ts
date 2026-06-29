// gateway Redis subscriber (S8-4b + B7, §8.4 horizontal fan-out push). gateway subscribes to GW_PUSH_REDIS_CHANNEL;
// worldsvc publishes a {recipient list + one push message} to that channel; this process fans it out only to
// recipients that are online on this instance (routeBroadcast). Multiple gateway instances each subscribe independently, providing natural cross-instance routing (SOC9).
//
// Reconnect: ioredis sets autoResubscribe=true (also the default), so after reconnection it re-subscribes to the same channel automatically;
// any push messages missed during the gap are recovered by the client via REST history fetch on next request (REST is authoritative; push is an accelerator).
//
// No Redis URL configured → returns null, real-time channel push is disabled (worldsvc falls back to O(n) direct HTTP push;
// clients can still poll history via REST). Dynamic ioredis import: compiles even when ioredis is not installed in dev (mirrors worldsvc/redis.ts).
import { createLogger, GW_PUSH_REDIS_CHANNEL } from '@nw/shared';
import type { PushMsg } from './matchsvcClient';

const log = createLogger('gateway:redis');

/** Fan-out envelope received from Redis: one push message plus its list of recipient accountIds. */
interface BroadcastEnvelope {
  recipients: string[];
  msg: PushMsg;
}

export interface GatewaySubscriber {
  quit(): Promise<void>;
}

/**
 * Connect and subscribe to GW_PUSH_REDIS_CHANNEL. Each message is parsed as {recipients, msg}; the onBroadcast callback
 * is consumed by Gateway.routeBroadcast (pushes only to locally-online recipients). On connection failure → returns null (real-time push degraded).
 * autoResubscribe=true ensures Redis re-subscription after reconnection (B7 acceptance criterion).
 */
export async function connectGatewaySubscriber(
  url: string | undefined,
  onBroadcast: (recipients: string[], msg: PushMsg) => void,
): Promise<GatewaySubscriber | null> {
  if (!url) return null;
  try {
    const spec = 'ioredis';
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      autoResubscribe: true, // re-subscribe automatically after reconnection (ioredis default is already true; explicit for auditability)
    });
    client.on('error', (e: Error) => log.error('redis error', { err: e.message }));
    client.on('ready', () => log.info('redis ready / resubscribed', { channel: GW_PUSH_REDIS_CHANNEL }));
    client.on('message', (_channel: string, payload: string) => {
      try {
        const env = JSON.parse(payload) as BroadcastEnvelope;
        if (Array.isArray(env.recipients) && env.msg) onBroadcast(env.recipients, env.msg);
      } catch (e) {
        log.warn('bad broadcast payload', { err: (e as Error).message });
      }
    });
    await client.subscribe(GW_PUSH_REDIS_CHANNEL);
    log.info('subscribed', { channel: GW_PUSH_REDIS_CHANNEL });
    return { quit: () => client.quit().then(() => undefined) };
  } catch (e) {
    log.error('subscribe failed; channel real-time push disabled', { url, err: (e as Error).message });
    return null;
  }
}
