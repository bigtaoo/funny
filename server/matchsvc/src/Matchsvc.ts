// matchsvc —— 玩家不可达的私有匹配大脑（M17），自 2026-06-14 起为**独立进程**（S1-M5）。
// 玩家操作由 gateway 解码后经内部 HTTP 调用本进程（internalHttp.ts → 本类方法）；
// 异步事件经注入的 push 回调推回 gateway（GatewayClient HTTP），gateway 再推给玩家 socket。
//
// 职责（SERVER_API.md §8.1 / MATCHSVC_DESIGN.md §2）：
//   • friendly 内存房间（建房 / 输码加入 / ready / 房主开局）；
//   • ranked 匹配队列（ELO 邻近配对，搬自 gameserver Matchmaking）；
//   • game 注册表（哪台 gameserver 空闲）+ 配对/开局后签 match ticket；
//   • 异步事件（房间态变更 / match_found）经注入的 push 回调推回 gateway → 玩家。
//
// **不连任何库**：匹配要的 elo 由 gateway 入队前向 meta 取后带入（enqueue 的 elo 参数）。
import { randomUUID, randomInt } from 'crypto';
import { signTicket, type TicketClaims } from '@nw/shared';
import { Matchmaking, type QueueEntry } from './Matchmaking';
import { GameRegistry } from './GameRegistry';

// RoomPhase 枚举值镜像 contracts/transport.proto（编码归 gateway，matchsvc 只透传整数 phase）。
const RoomPhase = {
  WAITING: 0,
  READY: 1,
  COUNTDOWN: 2,
  IN_MATCH: 3,
  OVER: 4,
} as const;

// ── gateway 推送接口（matchsvc 不直接持连接，proto 无关）────────────────
export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  | { kind: 'room_error'; code: string; message: string };
export type Push = (accountId: string, msg: PushMsg) => void;

interface Slot {
  accountId: string;
  name: string;
  side: 0 | 1;
  ready: boolean;
  connected: boolean;
}
interface Room {
  roomId: string;
  code: string;
  slots: Slot[];
  phase: number;
  /** 全员掉线后的清房计时器。 */
  reapTimer: NodeJS.Timeout | null;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去 0/O/1/I/L
const CODE_LEN = 6;
const REAP_MS = 60_000; // 全员掉线后保留房间的宽限

export interface MatchsvcOpts {
  ticketTtlSec?: number;
  /** 注入时钟（测试）。 */
  now?: () => number;
  /** Matchmaking 自动巡检开关（测试关掉手动 tick）。 */
  autoTick?: boolean;
}

export class Matchsvc {
  private readonly rooms = new Map<string, Room>(); // roomId → 房间
  private readonly byCode = new Map<string, string>(); // code → roomId
  private readonly accountRoom = new Map<string, string>(); // accountId → roomId
  private readonly matchmaking: Matchmaking;
  private readonly internalKey: string;
  private readonly ticketTtlSec: number;
  private readonly now: () => number;

  constructor(
    private readonly push: Push,
    private readonly games: GameRegistry,
    internalKey: string,
    opts: MatchsvcOpts = {},
  ) {
    this.internalKey = internalKey;
    this.ticketTtlSec = opts.ticketTtlSec ?? 30;
    this.now = opts.now ?? Date.now;
    this.matchmaking = new Matchmaking((a, b) => this.onPair(a, b), {
      now: opts.now,
      autoTick: opts.autoTick,
    });
  }

  // ───────────────────────── ranked 匹配 ─────────────────────────

  /** 开始 ranked 匹配（elo 由 gateway 向 meta 取后带入）。已在房 / 已在队则忽略。 */
  enqueue(accountId: string, name: string, elo: number): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) return;
    this.matchmaking.enqueue(accountId, name, elo);
  }

  cancel(accountId: string): void {
    this.matchmaking.remove(accountId);
  }

  /** Matchmaking 配对成功 → 直接开局（无 ready / 房主环节）。 */
  private onPair(a: QueueEntry, b: QueueEntry): void {
    this.startMatch('ranked', { accountId: a.accountId, name: a.name }, { accountId: b.accountId, name: b.name });
  }

  // ───────────────────────── friendly 房间 ─────────────────────────

  roomCreate(accountId: string, name: string): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = this.uniqueCode();
    const roomId = randomUUID();
    const room: Room = {
      roomId,
      code,
      slots: [{ accountId, name, side: 0, ready: false, connected: true }],
      phase: RoomPhase.WAITING,
      reapTimer: null,
    };
    this.rooms.set(roomId, room);
    this.byCode.set(code, roomId);
    this.accountRoom.set(accountId, roomId);
    this.broadcast(room);
  }

  roomJoin(accountId: string, name: string, code: string): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const roomId = this.byCode.get(code.toUpperCase());
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) {
      this.push(accountId, { kind: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no such room' });
      return;
    }
    if (room.slots.length >= 2) {
      this.push(accountId, { kind: 'room_error', code: 'ROOM_FULL', message: 'room is full' });
      return;
    }
    room.slots.push({ accountId, name, side: 1, ready: false, connected: true });
    this.accountRoom.set(accountId, room.roomId);
    this.broadcast(room);
  }

  roomReady(accountId: string, ready: boolean): void {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.ready = ready;
    room.phase =
      room.slots.length === 2 && room.slots.every((s) => s.ready)
        ? RoomPhase.READY
        : RoomPhase.WAITING;
    this.broadcast(room);
  }

  /** 房主（side 0）在双方 ready 后开局。 */
  roomStart(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const host = room.slots.find((s) => s.side === 0);
    if (!host || host.accountId !== accountId) return;
    if (room.slots.length !== 2 || !room.slots.every((s) => s.ready)) return;

    const [s0, s1] = room.slots;
    this.destroyRoom(room); // 大厅房使命完成；对局态归 gameserver
    this.startMatch(
      'friendly',
      { accountId: s0!.accountId, name: s0!.name },
      { accountId: s1!.accountId, name: s1!.name },
    );
  }

  /** 离开房间 / 退队。 */
  roomLeave(accountId: string): void {
    this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    this.removeFromRoom(room, accountId);
  }

  // ───────────────────────── 连接生命周期（gateway 通知）─────────────────────────

  /** 账号（重）连上 gateway：若在房，把当前 room_state 重发给它（控制面重连续会话）。 */
  onConnected(accountId: string): void {
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (slot && !slot.connected) {
      slot.connected = true;
      if (room.reapTimer) {
        clearTimeout(room.reapTimer);
        room.reapTimer = null;
      }
      this.broadcast(room);
    } else {
      this.pushRoomState(accountId, room); // 仅补发给本人
    }
  }

  /** 账号掉 gateway 连接：退队；若在大厅房标记掉线（保留宽限，支持控制面重连）。 */
  onDisconnected(accountId: string): void {
    this.matchmaking.remove(accountId);
    const room = this.roomOf(accountId);
    if (!room) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.connected = false;
    this.broadcast(room);
    if (room.slots.every((s) => !s.connected)) {
      room.reapTimer = setTimeout(() => this.destroyRoom(room), REAP_MS);
      room.reapTimer.unref?.();
    }
  }

  // ───────────────────────── game 注册表 ─────────────────────────

  registerGame(gameId: string, wsUrl: string, capacity: number): void {
    this.games.register(gameId, wsUrl, capacity);
  }
  gameHeartbeat(gameId: string, load: number, rooms: number): void {
    this.games.heartbeat(gameId, load, rooms);
  }

  // ───────────────────────── 开局 + 签 ticket ─────────────────────────

  private startMatch(
    mode: 'friendly' | 'ranked',
    a: { accountId: string; name: string },
    b: { accountId: string; name: string },
  ): void {
    const gameUrl = this.games.pick();
    if (!gameUrl) {
      const msg: PushMsg = { kind: 'room_error', code: 'GAME_UNAVAILABLE', message: 'no game server available' };
      this.push(a.accountId, msg);
      this.push(b.accountId, msg);
      return;
    }
    const roomId = randomUUID();
    const seed = randomInt(1, 2 ** 48); // < 2^48，落在安全整数内

    const sign = (self: { accountId: string; name: string }, opp: { accountId: string; name: string }, side: 0 | 1): string => {
      const claims: TicketClaims = {
        roomId,
        seed,
        side,
        mode,
        opponent: opp.name,
        gameUrl,
        accountId: self.accountId,
      };
      return signTicket(claims, { key: this.internalKey, ttlSec: this.ticketTtlSec });
    };

    this.push(a.accountId, { kind: 'match_found', gameUrl, ticket: sign(a, b, 0) });
    this.push(b.accountId, { kind: 'match_found', gameUrl, ticket: sign(b, a, 1) });
  }

  // ───────────────────────── 内部 ─────────────────────────

  private roomOf(accountId: string): Room | undefined {
    const id = this.accountRoom.get(accountId);
    return id ? this.rooms.get(id) : undefined;
  }

  private removeFromRoom(room: Room, accountId: string): void {
    room.slots = room.slots.filter((s) => s.accountId !== accountId);
    this.accountRoom.delete(accountId);
    if (room.slots.length === 0) {
      this.destroyRoom(room);
      return;
    }
    // 留下者补位为 side 0（房主），重置 ready。
    room.slots[0]!.side = 0;
    room.slots[0]!.ready = false;
    room.phase = RoomPhase.WAITING;
    this.broadcast(room);
  }

  private destroyRoom(room: Room): void {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
    for (const s of room.slots) this.accountRoom.delete(s.accountId);
    this.byCode.delete(room.code);
    this.rooms.delete(room.roomId);
  }

  private playersView(room: Room): PlayerView[] {
    return room.slots.map((s) => ({
      side: s.side,
      name: s.name,
      ready: s.ready,
      connected: s.connected,
    }));
  }

  private pushRoomState(accountId: string, room: Room): void {
    this.push(accountId, {
      kind: 'room_state',
      code: room.code,
      players: this.playersView(room),
      phase: room.phase,
    });
  }

  private broadcast(room: Room): void {
    const players = this.playersView(room);
    for (const s of room.slots) {
      this.push(s.accountId, { kind: 'room_state', code: room.code, players, phase: room.phase });
    }
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.byCode.has(code)) return code;
    }
    return CODE_ALPHABET[0]!.repeat(CODE_LEN - 4) + Date.now().toString(36).slice(-4).toUpperCase();
  }
}
