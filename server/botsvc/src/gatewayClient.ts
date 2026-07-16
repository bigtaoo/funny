// Gateway control-plane WS client (BOTSVC_DESIGN §8 remaining increment). Connects exactly like a
// real client (`wss://<gateway>/gw?token=<jwt>`), enqueues ranked matchmaking, and resolves once the
// server pushes `match_found` — mirrors client/src/net/NetClient.ts's createRoom()/onServerMsg
// handling, trimmed to the one flow botsvc needs (no room UI, no reconnect).
import { EnvelopeSocket } from './envelopeSocket';
import { MatchMode } from './generated/transport';

export interface MatchFoundInfo {
  gameUrl: string;
  ticket: string;
}

export class GatewayClient {
  private socket: EnvelopeSocket | undefined;

  /**
   * Connects, enqueues ranked matchmaking with `deck`, and waits for `match_found`. Closes the
   * gateway connection once matched (or on timeout/error) — the control-plane socket has no further
   * role once the game data-plane connection takes over.
   */
  async enqueueRanked(wsUrl: string, jwt: string, deck: string[], timeoutMs = 60_000): Promise<MatchFoundInfo> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('ranked matchmaking timed out'));
      }, timeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      EnvelopeSocket.connect(`${wsUrl}?token=${encodeURIComponent(jwt)}`, {
        onServerMsg: (msg) => {
          if (msg.matchFound) {
            finish(() => {
              this.close();
              resolve({ gameUrl: msg.matchFound!.gameUrl, ticket: msg.matchFound!.ticket });
            });
          } else if (msg.roomError) {
            finish(() => {
              this.close();
              reject(new Error(`room_error: ${msg.roomError!.code} ${msg.roomError!.message}`));
            });
          } else if (msg.matchBot) {
            // Queue wait exceeded matchsvc's bot-fallback threshold (see Matchsvc.ts's botFallbackMs):
            // it wants THIS client to simulate a local AI match instead of matching a real opponent.
            // Meaningless for a bot (it exists to exercise the real ranked flow) — bail cleanly rather
            // than sit on the 60s enqueueRanked timeout waiting for a match_found that isn't coming.
            finish(() => {
              this.close();
              reject(new Error('matched to local bot-fallback (no real opponent found)'));
            });
          }
        },
        onClose: (code) => {
          finish(() => reject(new Error(`gateway socket closed before match_found (code ${code})`)));
        },
        onError: (err) => {
          finish(() => reject(err));
        },
      })
        .then((socket) => {
          this.socket = socket;
          socket.send({ roomCreate: { mode: MatchMode.RANKED, deck } });
        })
        .catch((err) => finish(() => reject(err)));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
