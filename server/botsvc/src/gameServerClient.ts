// Gameserver data-plane WS client. Connects with the matchsvc-signed ticket (`?ticket=`), waits for
// `match_start` (carries seed/localSide/decks — gameserver is a pure relay, it never runs
// simulation, per server/gameserver/src/Room.ts), then streams `cmd_submit`/`frame_batch` for the
// rest of the match and finally reports `match_result`.
import { EnvelopeSocket } from './envelopeSocket';
import type { FrameBatch, MatchOver, MatchStart } from './generated/transport';

export interface GameServerClientHandlers {
  /** Fired once per match, after connect, before any frame_batch. */
  onMatchStart(m: MatchStart): void;
  onFrameBatch(fb: FrameBatch): void;
  /**
   * Fired when the SERVER unilaterally settles the match (opponent disconnect-forfeit or hash
   * mismatch) rather than this client's own engine reaching game_over. Room.destroy() never closes
   * the socket, so without this the client just hangs waiting for frame_batches that will never
   * come again, until the caller's own wall-clock guard fires minutes later (see battleSession.ts).
   */
  onMatchOver(m: MatchOver): void;
  /** Fired on an unexpected close (before the bot itself called close()) — treat as match failure. */
  onDisconnect(code: number): void;
}

export class GameServerClient {
  private socket: EnvelopeSocket | undefined;
  private intentionalClose = false;

  connect(gameUrl: string, ticket: string, handlers: GameServerClientHandlers, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let gotMatchStart = false;
      const timer = setTimeout(() => {
        if (gotMatchStart) return;
        this.close();
        reject(new Error('match_start timed out'));
      }, timeoutMs);

      EnvelopeSocket.connect(`${gameUrl}?ticket=${encodeURIComponent(ticket)}`, {
        onServerMsg: (msg) => {
          if (msg.matchStart) {
            gotMatchStart = true;
            clearTimeout(timer);
            handlers.onMatchStart(msg.matchStart);
            resolve();
          } else if (msg.frameBatch) {
            handlers.onFrameBatch(msg.frameBatch);
          } else if (msg.matchOver) {
            handlers.onMatchOver(msg.matchOver);
          }
        },
        onClose: (code) => {
          clearTimeout(timer);
          if (!this.intentionalClose) handlers.onDisconnect(code);
          if (!gotMatchStart) reject(new Error(`gameserver socket closed before match_start (code ${code})`));
        },
        onError: (err) => {
          clearTimeout(timer);
          if (!gotMatchStart) reject(err);
        },
      })
        .then((socket) => {
          this.socket = socket;
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  submitCmd(commands: Uint8Array): void {
    this.socket?.send({ cmdSubmit: { commands } });
  }

  reportResult(stateHash: string, winnerSide: number, statsJson = ''): void {
    this.socket?.send({ matchResult: { stateHash, winnerSide, statsJson } });
  }

  close(): void {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = undefined;
  }
}
