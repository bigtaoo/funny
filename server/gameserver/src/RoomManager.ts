// 房间目录 + 连接路由（S1-2）。建房 / 输码加入 / 重连寻房 / 消息分发。
// 单实例：本地 rooms Map 持 Room 对象，RoomRegistry 持目录元信息（留多实例口子）。
import { randomUUID, randomInt } from 'crypto';
import type { Collections } from '@nw/shared';
import { type RoomRegistry } from '@nw/shared';
import { Connection } from './Connection';
import { Room, type MatchArchive } from './Room';
import { MatchMode, type ClientMsg } from './proto/transport';

// 房间码字母表：去掉易混字符（0/O/1/I/L）。
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, Connection>(); // accountId → 活跃连接
  private readonly instanceId = randomUUID();

  constructor(
    private readonly registry: RoomRegistry,
    private readonly cols: Collections | null,
  ) {}

  // ───────────────────────── 连接生命周期 ─────────────────────────

  /** 新连接接入：同账号旧连接被顶替（双开 / 重连前的残连）。 */
  register(conn: Connection): void {
    const prev = this.connections.get(conn.accountId);
    if (prev && prev !== conn) prev.close(4409, 'replaced');
    this.connections.set(conn.accountId, conn);
  }

  /** 连接关闭：通知所属房间 + 清连接映射（仅当映射仍指向本连接）。 */
  onClose(conn: Connection): void {
    if (conn.roomId) {
      const room = this.rooms.get(conn.roomId);
      room?.onDisconnect(conn.accountId, conn);
    }
    if (this.connections.get(conn.accountId) === conn) {
      this.connections.delete(conn.accountId);
    }
  }

  // ───────────────────────── 消息分发 ─────────────────────────

  handle(conn: Connection, msg: ClientMsg): void {
    switch (msg.case) {
      case 'room_create':
        void this.create(conn, msg.mode);
        break;
      case 'room_join':
        void this.join(conn, msg.code);
        break;
      case 'conn_resume':
        this.resume(conn, msg.roomId, msg.lastFrame);
        break;
      case 'ping':
        conn.alive = true;
        conn.send({ case: 'pong' });
        break;
      // —— 以下需在房间内 ——
      case 'room_ready':
        this.roomOf(conn)?.setReady(conn.accountId, msg.ready);
        break;
      case 'room_start':
        this.roomOf(conn)?.start(conn.accountId);
        break;
      case 'room_leave': {
        const room = this.roomOf(conn);
        room?.leave(conn.accountId);
        break;
      }
      case 'cmd_submit':
        this.roomOf(conn)?.submitCmd(conn.accountId, msg.commands);
        break;
      case 'match_result':
        this.roomOf(conn)?.reportResult(conn.accountId, msg.stateHash);
        break;
      case 'unknown':
        break;
    }
  }

  private roomOf(conn: Connection): Room | undefined {
    return conn.roomId ? this.rooms.get(conn.roomId) : undefined;
  }

  // ───────────────────────── 建房 / 加入 / 重连 ─────────────────────────

  private async create(conn: Connection, mode: number): Promise<void> {
    if (mode === MatchMode.RANKED) {
      conn.send({
        case: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked matchmaking lands in S1-R',
      });
      return;
    }
    if (conn.roomId) {
      conn.send({ case: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = await this.uniqueCode();
    const roomId = randomUUID();
    await this.registry.create({
      roomId,
      code,
      mode: 'friendly',
      instanceId: this.instanceId,
      createdAt: Date.now(),
    });
    const room = new Room(roomId, code, MatchMode.FRIENDLY, {
      onDestroy: (id) => this.destroyRoom(id),
      archive: (doc) => this.archive(doc),
    });
    this.rooms.set(roomId, room);
    room.addPlayer(conn);
  }

  private async join(conn: Connection, code: string): Promise<void> {
    if (conn.roomId) {
      conn.send({ case: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const info = await this.registry.getByCode(code.toUpperCase());
    const room = info ? this.rooms.get(info.roomId) : undefined;
    if (!room) {
      conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no such room' });
      return;
    }
    if (room.isFull) {
      conn.send({ case: 'room_error', code: 'ROOM_FULL', message: 'room is full' });
      return;
    }
    room.addPlayer(conn);
  }

  private resume(conn: Connection, roomId: string, lastFrame: number): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.hasAccount(conn.accountId)) {
      conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'cannot resume' });
      return;
    }
    room.resume(conn, lastFrame);
  }

  private destroyRoom(roomId: string): void {
    this.rooms.delete(roomId);
    void this.registry.remove(roomId);
  }

  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!(await this.registry.getByCode(code))) return code;
    }
    // 极小概率连续撞码：退回时间戳尾巴兜底
    return CODE_ALPHABET[0]!.repeat(CODE_LEN - 4) + Date.now().toString(36).slice(-4).toUpperCase();
  }

  private archive(doc: MatchArchive): void {
    if (!this.cols) return;
    void this.cols.matches
      .insertOne({
        roomId: doc.roomId,
        mode: doc.mode,
        seed: String(doc.seed),
        players: doc.players,
        winner: doc.winner,
        reason: doc.reason,
        hashOk: doc.hashOk,
        // Inline replay (S1-RP): seed + config + non-empty frame log. `replayRef`
        // (object storage for large matches) is a later task; small matches embed.
        replay: {
          engineVersion: doc.replay.engineVersion,
          mode: doc.replay.mode,
          seed: String(doc.replay.seed),
          endFrame: doc.replay.endFrame,
          frames: doc.replay.frames, // cmds[].commands are BSON binary (opaque)
          meta: doc.replay.meta,
        },
        ts: Date.now(),
      })
      .catch((e) => console.error('[gameserver] archive match failed:', e));
  }
}
