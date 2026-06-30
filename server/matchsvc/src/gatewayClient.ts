// matchsvc → gateway reverse push (S1-M5). matchsvc is the private matching brain and holds no
// player connections; async events (room_state / match_found / room_error) are forwarded via this
// HTTP POST to gateway's /gw/push, which locates the player socket by accountId and delivers the
// message. Single gateway instance: one fixed address suffices; when gateway is scaled horizontally,
// routing here must be account→gateway-instance (via Redis — deferred, see META_DESIGN §6.7).
//
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). Fire-and-forget — drop silently when the
// player is offline or gateway blips (room state is the latest snapshot and will be resent on the
// next change; a lost match_found leaves the player in the room and they can retry starting a match).
import { createLogger, internalHeaders } from '@nw/shared';
import type { PushMsg } from './Matchsvc';

const log = createLogger('matchsvc:gw');

export class GatewayClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://gateway:8090 (internal direct connection, not publicly exposed)
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => {
    if (!this.baseUrl) {
      log.warn('gateway push not configured: event dropped', { accountId, kind: msg.kind, roomId });
      return;
    }
    void fetch(`${this.baseUrl}/gw/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('matchsvc', this.internalKey) },
      body: JSON.stringify({ accountId, msg, roomId }),
    })
      .then((res) => {
        if (!res.ok) log.warn('gateway push non-OK', { accountId, kind: msg.kind, roomId, status: res.status });
      })
      .catch((e) => {
        // Will be resent on the next state change; offline players should be silently dropped.
        // During integration testing a lost match_found will stall the "searching" state — make sure this is visible.
        log.error('gateway push failed', {
          accountId,
          kind: msg.kind,
          roomId,
          url: this.baseUrl,
          err: (e as Error).message,
        });
      });
  };
}
