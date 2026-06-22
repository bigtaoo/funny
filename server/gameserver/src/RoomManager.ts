// 数据面房间路由（S1-M2）。瘦身后 gameserver 不建房 / 不匹配 / 不连库：房间由 ticket
// 握手按需创建——同 roomId 的两张 ticket（side 0/1，seed 一致）凑齐即开局。本类只做
// 「按 roomId 找/建房 + 把数据面消息分发给房间」，并在局末上报 meta（注入 report）。
import { Room, type EloBySide, type MatchReport } from './Room';
import { MatchMode, type ClientMsg, type MatchModeVal } from './proto/transport';
import type { Connection } from './Connection';

export interface RoomManagerDeps {
  /** 局末上报 meta（结算 + 归档）。 */
  report: (r: MatchReport) => Promise<EloBySide | null>;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly deps: RoomManagerDeps) {}

  /**
   * ticket 握手后接入：按 roomId 找/建房，加入指定 side。
   * 交叉核对——第二张 ticket 的 seed/mode 必须与房间（第一张 ticket 建立的）一致，
   * 否则拒绝（防伪造 / 错配）。返回 false 表示拒绝（调用方关连接）。
   */
  join(conn: Connection, name: string, publicId: string, seed: number, mode: MatchModeVal, opponentTitle = ''): boolean {
    let room = this.rooms.get(conn.roomId);
    if (room) {
      // 已有房：核对 seed/mode 一致（防伪造 / 错配）。
      if (room.seedValue !== seed || room.mode !== mode) return false;
      // 该 side 已在房 = 重连：不重复 addPlayer，slot.conn 由后续 conn_resume 重绑。
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
      // room_create/join/ready/start 属控制面（gateway），数据面忽略。
      default:
        break;
    }
  }

  /** 测试 / 关服用。 */
  destroyAll(): void {
    for (const room of [...this.rooms.values()]) room.destroy();
    this.rooms.clear();
  }
}

export { MatchMode };
