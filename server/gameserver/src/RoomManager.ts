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

  /** Whether a live room exists for this roomId (used to tell reconnects from initial joins). */
  roomExists(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /**
   * All accountIds currently rostered in a live room (any phase, WAITING or IN_MATCH). Read at
   * shutdown, before destroyAll() wipes them, so the caller can tell meta to clear their
   * login-reconnect-prompt cache — these rooms are about to disappear with no end-of-match report.
   */
  activeAccountIds(): string[] {
    const ids = new Set<string>();
    for (const room of this.rooms.values()) {
      for (const accountId of room.rosterAccountIds) ids.add(accountId);
    }
    return [...ids];
  }

  /**
   * Called after a ticket handshake: find/create a room by roomId and join the specified side.
   * Cross-validation — the second ticket's seed/mode must match the room established by the first
   * ticket; otherwise the join is rejected (prevents forgery / mismatched pairing).
   * Returns false to indicate rejection (caller should close the connection).
   */
  join(
    conn: Connection,
    name: string,
    publicId: string,
    seed: number,
    mode: MatchModeVal,
    opponentTitle = '',
    decks?: { top: string[]; bottom: string[] },
    opponentAvatarId = '',
  ): boolean {
    let room = this.rooms.get(conn.roomId);
    if (room) {
      // Room already exists: verify seed/mode match (prevents forgery / mismatched pairing).
      if (room.seedValue !== seed || room.mode !== mode) return false;
      // Side already in room = reconnect (or a new-device login taking over): rebind immediately and
      // evict any stale connection instead of leaving it dangling until a conn_resume arrives.
      if (room.hasSide(conn.side)) {
        room.takeover(conn);
      } else {
        room.addPlayer(conn, name, publicId, opponentTitle, decks, opponentAvatarId);
      }
      return true;
    }
    room = new Room(conn.roomId, seed, mode, {
      onDestroy: (id) => this.rooms.delete(id),
      report: this.deps.report,
    });
    this.rooms.set(conn.roomId, room);
    room.addPlayer(conn, name, publicId, opponentTitle, decks, opponentAvatarId);
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
