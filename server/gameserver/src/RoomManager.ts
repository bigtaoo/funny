// Data-plane room routing (S1-M2). After slimming down, the gameserver does not create rooms /
// does not match players / does not connect to any database: rooms are created on demand by the
// ticket handshake — once both tickets for the same roomId (side 0/1, matching seed) have arrived,
// the match begins. This class only handles "find/create room by roomId + dispatch data-plane
// messages to the room", and reports match results to meta at game end (via the injected report).
import { Room, type EloBySide, type MatchReport } from './Room';
import { MatchMode, type ClientMsg, type MatchModeVal } from './proto/transport';
import type { Connection } from './Connection';

export interface RoomManagerDeps {
  /** Report match result to meta at game end (settlement + archival). */
  report: (r: MatchReport) => Promise<EloBySide | null>;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly deps: RoomManagerDeps) {}

  /**
   * Called after a ticket handshake: find/create a room by roomId and join the specified side.
   * Cross-validation — the second ticket's seed/mode must match the room established by the first
   * ticket; otherwise the join is rejected (prevents forgery / mismatched pairing).
   * Returns false to indicate rejection (caller should close the connection).
   */
  join(conn: Connection, name: string, publicId: string, seed: number, mode: MatchModeVal, opponentTitle = ''): boolean {
    let room = this.rooms.get(conn.roomId);
    if (room) {
      // Room already exists: verify seed/mode match (prevents forgery / mismatched pairing).
      if (room.seedValue !== seed || room.mode !== mode) return false;
      // Side already in room = reconnect: do not call addPlayer again; slot.conn is rebound by a subsequent conn_resume.
      if (!room.hasSide(conn.side)) room.addPlayer(conn, name, publicId, opponentTitle);
      return true;
    }
    room = new Room(conn.roomId, seed, mode, {
      onDestroy: (id) => this.rooms.delete(id),
      report: this.deps.report,
    });
    this.rooms.set(conn.roomId, room);
    room.addPlayer(conn, name, publicId, opponentTitle);
    return true;
  }

  onClose(conn: Connection): void {
    this.rooms.get(conn.roomId)?.onDisconnect(conn.side, conn);
  }

  handle(conn: Connection, msg: ClientMsg): void {
    const room = this.rooms.get(conn.roomId);
    switch (msg.case) {
      case 'cmd_submit':
        room?.submitCmd(conn.side, msg.commands);
        break;
      case 'match_result':
        room?.reportResult(conn.side, msg.stateHash, msg.winnerSide, msg.stats);
        break;
      case 'conn_resume':
        room?.resume(conn, msg.lastFrame);
        break;
      case 'room_leave':
        room?.leave(conn.side);
        break;
      case 'ping':
        conn.alive = true;
        conn.send({ case: 'pong' });
        break;
      // room_create/join/ready/start belong to the control plane (gateway); ignored on the data plane.
      default:
        break;
    }
  }

  /** For testing / server shutdown. */
  destroyAll(): void {
    for (const room of [...this.rooms.values()]) room.destroy();
    this.rooms.clear();
  }
}

export { MatchMode };
