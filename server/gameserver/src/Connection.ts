// Single data-plane WS connection wrapper (S1-M2): binds ticket identity (roomId / side / accountId),
// encodes outgoing messages, and detects heartbeat liveness. The gameserver is a pure frame relay —
// identity comes entirely from the ticket signed by matchsvc; gameserver never queries any database (M16).
import type { WebSocket } from 'ws';
import { encodeServer, type ServerMsg } from './proto/transport';

export class Connection {
  /** Heartbeat: set to true after each pong/ping; cleared to false by the watchdog; if still false on the next watchdog pass the connection is declared dead. */
  alive = true;

  constructor(
    /** ticket.roomId — the match this connection belongs to. */
    readonly roomId: string,
    /** ticket.side — this player's side (0/1). */
    readonly side: 0 | 1,
    /** ticket.accountId — passed through only for end-of-match reporting to meta; the gameserver does not read any database. */
    readonly accountId: string,
    readonly ws: WebSocket,
  ) {}

  send(msg: ServerMsg): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(encodeServer(msg));
    } catch {
      // Write failures are handled uniformly by the close event
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }
}
