// matchsvc → gateway reverse push (S1-M5). matchsvc is the private matching brain and holds no
// player connections; async events (room_state / match_found / room_error) are forwarded to whichever
// gateway instance holds the player's socket.
//
// Routing (2026-07-18, closes the gap this file used to flag as deferred — see META_DESIGN §6.7):
// when a Redis client is supplied, publishes {recipients:[accountId], msg} on GW_PUSH_REDIS_CHANNEL —
// the same fan-out channel + envelope shape worldsvc already uses for sect/nation broadcasts (S8-4b).
// Every gateway instance subscribes to that channel and delivers only to accountIds online on itself
// (Gateway.routeBroadcast), so this works correctly regardless of how many gateway instances are running
// or which one holds the socket. Without Redis (dev / single-instance), falls back to the original direct
// HTTP POST to one fixed gateway address.
//
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). Fire-and-forget — drop silently when the
// player is offline or gateway blips (room state is the latest snapshot and will be resent on the
// next change; a lost match_found leaves the player in the room and they can retry starting a match).
import { createLogger, postInternal, GW_PUSH_REDIS_CHANNEL } from '@nw/shared';
import type { PushMsg } from './Matchsvc';

const log = createLogger('matchsvc:gw');

/** Minimal Redis interface required for fan-out publish (mirrors worldsvc's BroadcastRedis). */
export interface PublishRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://gateway:8090 (internal direct connection, not publicly exposed); used as fallback when redis is unavailable
    private readonly internalKey: string,
    /** Optional Redis publish client (reuses matchsvc's existing activeMatch connection). null = always falls back to direct HTTP. */
    private readonly redis: PublishRedis | null = null,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null || this.redis !== null;
  }

  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => {
    void this.pushAsync(accountId, msg, roomId);
  };

  private async pushAsync(accountId: string, msg: PushMsg, roomId?: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.publish(GW_PUSH_REDIS_CHANNEL, JSON.stringify({ recipients: [accountId], msg }));
        return;
      } catch (e) {
        log.warn('redis publish failed, falling back to direct HTTP', { accountId, kind: msg.kind, err: (e as Error).message });
      }
    }
    if (!this.baseUrl) {
      log.warn('gateway push not configured: event dropped', { accountId, kind: msg.kind, roomId });
      return;
    }
    // match_found is non-self-healing: losing it strands the player in "searching" while matchsvc
    // already dequeued + signed the ticket → retry. Client dedups a re-sent match_found by ticket
    // (NetSession.connectGame), so retry is safe. Other kinds are self-healing → retries=0.
    const retries = msg.kind === 'match_found' ? 2 : 0;
    void postInternal(`${this.baseUrl}/gw/push`, { accountId, msg, roomId }, {
      caller: 'matchsvc',
      key: this.internalKey,
      retries,
      log,
      label: `/gw/push ${msg.kind}`,
    });
  }
}
