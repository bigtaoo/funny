// 房间目录 + 连接路由（S1-2）。建房 / 输码加入 / 重连寻房 / 消息分发。
// 单实例：本地 rooms Map 持 Room 对象，RoomRegistry 持目录元信息（留多实例口子）。
import { randomUUID, randomInt } from 'crypto';
import type { Collections, SaveDoc, SaveData } from '@nw/shared';
import {
  type RoomRegistry,
  INITIAL_ELO,
  ELO_FLOOR,
  computeEloDelta,
  eloToRank,
  nextStreak,
} from '@nw/shared';
import { Connection } from './Connection';
import { Room, type MatchArchive, type EloResult } from './Room';
import { Matchmaking, type QueueEntry } from './Matchmaking';
import { MatchMode, type ClientMsg } from './proto/transport';

// 房间码字母表：去掉易混字符（0/O/1/I/L）。
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, Connection>(); // accountId → 活跃连接
  private readonly instanceId = randomUUID();
  private readonly matchmaking: Matchmaking;

  constructor(
    private readonly registry: RoomRegistry,
    private readonly cols: Collections | null,
  ) {
    this.matchmaking = new Matchmaking((a, b) => void this.createRankedRoom(a, b));
  }

  // ───────────────────────── 连接生命周期 ─────────────────────────

  /** 新连接接入：同账号旧连接被顶替（双开 / 重连前的残连）。 */
  register(conn: Connection): void {
    const prev = this.connections.get(conn.accountId);
    if (prev && prev !== conn) prev.close(4409, 'replaced');
    this.connections.set(conn.accountId, conn);
  }

  /** 连接关闭：通知所属房间 + 清连接映射（仅当映射仍指向本连接）。 */
  onClose(conn: Connection): void {
    this.matchmaking.remove(conn.accountId); // 在 ranked 队列里则退队
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
        if (room) room.leave(conn.accountId);
        else this.matchmaking.remove(conn.accountId); // 不在房内 → 取消 ranked 匹配
        break;
      }
      case 'cmd_submit':
        this.roomOf(conn)?.submitCmd(conn.accountId, msg.commands);
        break;
      case 'match_result':
        this.roomOf(conn)?.reportResult(conn.accountId, msg.stateHash, msg.winnerSide);
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
    if (conn.roomId) {
      conn.send({ case: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    if (mode === MatchMode.RANKED) {
      await this.enqueueRanked(conn);
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

  // ───────────────────────── Ranked 匹配 / ELO（S1-R）─────────────────────────

  /** Ranked 入队：需 Mongo（天梯权威）；读当前 ELO 后入匹配队列。 */
  private async enqueueRanked(conn: Connection): Promise<void> {
    if (!this.cols) {
      conn.send({
        case: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked requires server storage',
      });
      return;
    }
    if (this.matchmaking.has(conn.accountId)) return; // 已在队列，幂等
    let elo = INITIAL_ELO;
    try {
      const doc = await this.cols.saves.findOne({ _id: conn.accountId });
      elo = doc?.save.pvp.elo ?? INITIAL_ELO;
    } catch (e) {
      console.error('[gameserver] read elo for matchmaking failed:', e);
    }
    // await 期间连接可能被顶替 / 进了房 → 不入队
    if (this.connections.get(conn.accountId) !== conn || conn.roomId) return;
    this.matchmaking.enqueue(conn, elo);
  }

  /** 匹配成功建 ranked 房并直接开局（无 ready / 房主环节）。 */
  private async createRankedRoom(a: QueueEntry, b: QueueEntry): Promise<void> {
    // 配对回调与连接关闭存在竞态：校验仍是活跃且空闲连接，否则把在线方放回队列。
    const live = (e: QueueEntry): boolean =>
      this.connections.get(e.accountId) === e.conn && !e.conn.roomId;
    if (!live(a) || !live(b)) {
      if (live(a)) this.matchmaking.enqueue(a.conn, a.elo);
      if (live(b)) this.matchmaking.enqueue(b.conn, b.elo);
      return;
    }
    const code = await this.uniqueCode();
    const roomId = randomUUID();
    await this.registry.create({
      roomId,
      code,
      mode: 'ranked',
      instanceId: this.instanceId,
      createdAt: Date.now(),
    });
    const room = new Room(roomId, code, MatchMode.RANKED, {
      onDestroy: (id) => this.destroyRoom(id),
      archive: (doc) => this.archive(doc),
      settleRanked: (w, l) => this.settleRanked(w, l),
    });
    this.rooms.set(roomId, room);
    room.addPlayer(a.conn);
    room.addPlayer(b.conn);
    room.beginRanked();
  }

  /** Ranked 局末 ELO 结算：读双方分 → 算分差 → 各自原子写 saves.pvp。 */
  private async settleRanked(
    winnerId: string,
    loserId: string,
  ): Promise<Map<string, EloResult>> {
    const out = new Map<string, EloResult>();
    if (!this.cols) return out;
    const [wDoc, lDoc] = await Promise.all([
      this.cols.saves.findOne({ _id: winnerId }),
      this.cols.saves.findOne({ _id: loserId }),
    ]);
    const wElo = wDoc?.save.pvp.elo ?? INITIAL_ELO;
    const lElo = lDoc?.save.pvp.elo ?? INITIAL_ELO;
    const { winner, loser } = computeEloDelta(wElo, lElo);
    const [wRes, lRes] = await Promise.all([
      this.applyPvp(winnerId, wDoc, winner, true),
      this.applyPvp(loserId, lDoc, loser, false),
    ]);
    if (wRes) out.set(winnerId, wRes);
    if (lRes) out.set(loserId, lRes);
    return out;
  }

  /**
   * 单方 pvp 原子更新（乐观锁 rev 守卫 + 重试）。整体替换 save（同 putSave 约定），
   * 避免与客户端 PUT /save 的并发写互相覆盖。
   */
  private async applyPvp(
    accountId: string,
    doc: SaveDoc | null,
    delta: number,
    won: boolean,
  ): Promise<EloResult | null> {
    if (!this.cols) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = attempt === 0 && doc ? doc : await this.cols.saves.findOne({ _id: accountId });
      if (!cur) return null; // ranked 玩家应已有存档（已 auth）
      const pvp = cur.save.pvp;
      const after = Math.max(ELO_FLOOR, pvp.elo + delta);
      const appliedDelta = after - pvp.elo; // floor 钳制后的真实变化
      const rank = eloToRank(after);
      const next: SaveData = {
        ...cur.save,
        rev: cur.save.rev + 1,
        updatedAt: Date.now(),
        pvp: {
          ...pvp,
          elo: after,
          rank,
          streak: nextStreak(pvp.streak, won),
          wins: pvp.wins + (won ? 1 : 0),
          losses: pvp.losses + (won ? 0 : 1),
        },
      };
      const res = await this.cols.saves.findOneAndUpdate(
        { _id: accountId, rev: cur.rev },
        { $set: { save: next, rev: next.rev } },
        { returnDocument: 'after' },
      );
      if (res) return { delta: appliedDelta, after, rankAfter: rank };
      // rev 冲突（客户端并发 PUT /save）→ 重读重试
    }
    console.warn(`[gameserver] applyPvp rev conflict exhausted for ${accountId}`);
    return null;
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
    // BSON 文档硬上限 16MB。内嵌录像随对局长度增长，长局可能撞顶 → insertOne 抛、
    // 被下方 .catch 静默吞 → 归档丢失却无感。超阈值先告警（「大局转对象存储 replayRef」
    // 是后续任务，落地前至少留下排查线索，不让人误以为「都归档了」）。
    const replayBytes = doc.replay.frames.reduce(
      (n, f) => n + f.cmds.reduce((m, c) => m + c.commands.length + 8, 0),
      0,
    );
    const WARN_BYTES = 12 * 1024 * 1024; // 留足 BSON 其余字段 + 编码膨胀余量
    if (replayBytes > WARN_BYTES) {
      console.warn(
        `[gameserver] inline replay large (~${(replayBytes / 1024 / 1024).toFixed(1)}MB, ` +
          `${doc.replay.frames.length} frames) for room ${doc.roomId}; ` +
          `may exceed 16MB BSON limit — replayRef object storage is the fix (S1-RP 待办)`,
      );
    }
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
