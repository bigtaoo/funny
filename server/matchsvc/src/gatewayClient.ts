// matchsvc → gateway reverse push (S1-M5). matchsvc is the private matching brain and holds no
// player connections; async events (room_state / match_found / room_error) are forwarded via this
// HTTP POST to gateway's /gw/push, which locates the player socket by accountId and delivers the
// message. Single gateway instance: one fixed address suffices; when gateway is scaled horizontally,
// routing here must be account→gateway-instance (via Redis — deferred, see META_DESIGN §6.7).
//
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). Fire-and-forget — drop silently when the
// player is offline or gateway blips (room state is the latest snapshot and will be resent on the
// next change; a lost match_found leaves the player in the room and they can retry starting a match).
import { createLogger, postInternal } from '@nw/shared';
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
  };
}
