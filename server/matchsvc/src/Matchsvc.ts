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
import { signTicket, createLogger, type FeatureFlagCache, type TicketClaims } from '@nw/shared';
import { Matchmaking, type QueueEntry } from './Matchmaking';
import { GameRegistry } from './GameRegistry';

const log = createLogger('matchsvc');

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
  /** 9 位数字公开 id（玩家交流/投诉用；缺省空串）。 */
  publicId: string;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  // 匹配超时降级打 AI（feature flag match_bot_fallback）。客户端据此开本地 AI 局，无 ticket/gameUrl。
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string };

/** bot-fallback 时随机挑选的 AI 对手展示名（纯展示，叙事统一为「红笔批改/假想敌」语气）。 */
const BOT_NAMES = ['红笔小将', '草稿纸新兵', '橡皮擦练习生', '便利贴学徒', '修正液守卫'];
/**
 * 推送回调。`roomId` 是跨进程关联 id（correlation id）——同一局在 matchsvc / gateway / game /
 * meta 的日志里都带它，Grafana 用 `| json | roomId="X"` 可把整局拉成一条时间线。仅用于日志，
 * 不进客户端可见的 PushMsg。无房上下文（如 ALREADY_IN_ROOM 错误）时省略。
 */
export type Push = (accountId: string, msg: PushMsg, roomId?: string) => void;

interface Slot {
  accountId: string;
  name: string;
  publicId: string;
  /** 佩戴称号 id（来自 meta /internal/profile；空串=无称号）。 */
  equippedTitle: string;
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

// MUST stay identical to client RoomScene.ts (its keypad can only type these
// chars). 10 digits + 11 letters; letters skip I/O/L so they don't read as 0/1.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
const CODE_LEN = 6;
const REAP_MS = 60_000; // 全员掉线后保留房间的宽限

export interface MatchsvcOpts {
  ticketTtlSec?: number;
  /** 注入时钟（测试）。 */
  now?: () => number;
  /** Matchmaking 自动巡检开关（测试关掉手动 tick）。 */
  autoTick?: boolean;
  /** 功能开关缓存（轮询 admin 原始规则 + 本地求值）。缺省 = 不可用，match_bot_fallback 视为关。 */
  flags?: FeatureFlagCache;
  /** 入队等待超过此毫秒数 → 评估 match_bot_fallback 决定是否降级打 AI。默认 30000。 */
  botFallbackMs?: number;
}

export class Matchsvc {
  private readonly rooms = new Map<string, Room>(); // roomId → 房间
  private readonly byCode = new Map<string, string>(); // code → roomId
  private readonly accountRoom = new Map<string, string>(); // accountId → roomId
  private readonly matchmaking: Matchmaking;
  private readonly internalKey: string;
  private readonly ticketTtlSec: number;
  private readonly now: () => number;
  private readonly flags?: FeatureFlagCache;

  constructor(
    private readonly push: Push,
    private readonly games: GameRegistry,
    internalKey: string,
    opts: MatchsvcOpts = {},
  ) {
    this.internalKey = internalKey;
    this.ticketTtlSec = opts.ticketTtlSec ?? 30;
    this.now = opts.now ?? Date.now;
    if (opts.flags) this.flags = opts.flags;
    this.matchmaking = new Matchmaking((a, b) => this.onPair(a, b), {
      now: opts.now,
      autoTick: opts.autoTick,
      botFallbackMs: opts.botFallbackMs ?? 30_000,
      onTimeout: (e) => this.onQueueTimeout(e),
    });
  }

  /**
   * 实时态聚合（admin GET /internal/stats，OPS_DESIGN §4.1）：ranked 队列长度 / 活跃 friendly
   * 房间数 / 健康 game 实例数 / game 负载合计。
   */
  stats(): { queue: number; rooms: number; gameInstances: number; gameLoad: number } {
    const g = this.games.stats();
    return {
      queue: this.matchmaking.size,
      rooms: this.rooms.size,
      gameInstances: g.instances,
      gameLoad: g.load,
    };
  }

  // ───────────────────────── ranked 匹配 ─────────────────────────

  /**
   * 开始 ranked 匹配（elo 由 gateway 向 meta 取后带入）。已在房 / 已在队则忽略。
   * publicId 随队列条目带入：ranked 不展示房间 slot，但开局后要把对手 publicId 写进
   * ticket → match_start，供对局内资料弹层展示。
   */
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = '', platform = ''): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      log.warn('enqueue ignored: already in room/queue', { accountId });
      return;
    }
    this.matchmaking.enqueue(accountId, name, publicId, elo, equippedTitle, platform);
    log.info('enqueued for ranked', { accountId, elo, queueSize: this.matchmaking.size });
  }

  cancel(accountId: string): void {
    this.matchmaking.remove(accountId);
  }

  /**
   * 入队等待超阈值（默认 30s）的决策点：若 feature flag `match_bot_fallback` 对该玩家开启，
   * 出队并推送 match_bot（客户端开本地 AI 局）；否则保持在队继续等真人（行为不变）。
   * flags 缺省/admin 不可达 → 视为关（default false），优雅降级为「一直等」。
   */
  private onQueueTimeout(entry: QueueEntry): void {
    const on =
      this.flags?.isOn('match_bot_fallback', {
        accountId: entry.accountId,
        ...(entry.platform ? { platform: entry.platform as never } : {}),
      }) ?? false;
    if (!on) {
      log.info('queue timeout: bot fallback OFF → keep waiting for human', { accountId: entry.accountId });
      return;
    }
    this.matchmaking.remove(entry.accountId);
    const seed = randomInt(1, 2 ** 48);
    const opponentName = BOT_NAMES[randomInt(0, BOT_NAMES.length)]!;
    log.info('queue timeout: bot fallback ON → match_bot', { accountId: entry.accountId, elo: entry.elo, seed });
    this.push(entry.accountId, { kind: 'match_bot', seed, opponentName, elo: entry.elo, difficulty: 'normal' });
  }

  /** Matchmaking 配对成功 → 直接开局（无 ready / 房主环节）。 */
  private onPair(a: QueueEntry, b: QueueEntry): void {
    log.info('ranked pair matched', { a: a.accountId, b: b.accountId, eloA: a.elo, eloB: b.elo });
    this.startMatch(
      'ranked',
      { accountId: a.accountId, name: a.name, publicId: a.publicId, equippedTitle: a.equippedTitle },
      { accountId: b.accountId, name: b.name, publicId: b.publicId, equippedTitle: b.equippedTitle },
    );
  }

  // ───────────────────────── friendly 房间 ─────────────────────────

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = ''): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const code = this.uniqueCode();
    const roomId = randomUUID();
    const room: Room = {
      roomId,
      code,
      slots: [{ accountId, name, publicId, equippedTitle, side: 0, ready: false, connected: true }],
      phase: RoomPhase.WAITING,
      reapTimer: null,
    };
    this.rooms.set(roomId, room);
    this.byCode.set(code, roomId);
    this.accountRoom.set(accountId, roomId);
    log.info('room created', { accountId, code, roomId });
    this.broadcast(room);
  }

  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = ''): void {
    if (this.accountRoom.has(accountId) || this.matchmaking.has(accountId)) {
      this.push(accountId, { kind: 'room_error', code: 'ALREADY_IN_ROOM', message: 'leave first' });
      return;
    }
    const roomId = this.byCode.get(code.toUpperCase());
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) {
      log.warn('join failed: room not found', { accountId, code });
      this.push(accountId, { kind: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no such room' });
      return;
    }
    if (room.slots.length >= 2) {
      log.warn('join failed: room full', { accountId, code });
      this.push(accountId, { kind: 'room_error', code: 'ROOM_FULL', message: 'room is full' });
      return;
    }
    room.slots.push({ accountId, name, publicId, equippedTitle, side: 1, ready: false, connected: true });
    this.accountRoom.set(accountId, room.roomId);
    log.info('room joined', { accountId, code, roomId: room.roomId });
    this.broadcast(room);
  }

  roomReady(accountId: string, ready: boolean): void {
    const room = this.roomOf(accountId);
    if (!room || room.phase >= RoomPhase.IN_MATCH) return;
    const slot = room.slots.find((s) => s.accountId === accountId);
    if (!slot) return;
    slot.ready = ready;
    const allReady = room.slots.length === 2 && room.slots.every((s) => s.ready);
    room.phase = allReady ? RoomPhase.READY : RoomPhase.WAITING;
    this.broadcast(room);

    // Both players ready → start automatically. Previously this only flipped the
    // phase to READY and waited for the host to press "start", which players read
    // as the game failing to start. Auto-start (like ranked) removes that gap.
    if (allReady) {
      const [s0, s1] = room.slots;
      this.destroyRoom(room); // 大厅房使命完成；对局态归 gameserver
      this.startMatch(
        'friendly',
        { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle },
        { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle },
      );
    }
  }

  /**
   * 房主（side 0）在双方 ready 后开局。双方 ready 现在已由 {@link roomReady} 自动开局，
   * 此入口保留以兼容旧客户端的显式 start 按钮（房间届时已销毁 → roomOf 返回 undefined → no-op）。
   */
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
      { accountId: s0!.accountId, name: s0!.name, publicId: s0!.publicId, equippedTitle: s0!.equippedTitle },
      { accountId: s1!.accountId, name: s1!.name, publicId: s1!.publicId, equippedTitle: s1!.equippedTitle },
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
    log.info('game server registered', { gameId, wsUrl, capacity });
    this.games.register(gameId, wsUrl, capacity);
  }
  gameHeartbeat(gameId: string, load: number, rooms: number): void {
    this.games.heartbeat(gameId, load, rooms);
  }

  // ───────────────────────── 开局 + 签 ticket ─────────────────────────

  private startMatch(
    mode: 'friendly' | 'ranked',
    a: { accountId: string; name: string; publicId: string; equippedTitle: string },
    b: { accountId: string; name: string; publicId: string; equippedTitle: string },
  ): void {
    const gameUrl = this.games.pick();
    if (!gameUrl) {
      log.error('startMatch aborted: no game server available (none registered + no fallback)', {
        a: a.accountId,
        b: b.accountId,
        mode,
      });
      const msg: PushMsg = { kind: 'room_error', code: 'GAME_UNAVAILABLE', message: 'no game server available' };
      this.push(a.accountId, msg);
      this.push(b.accountId, msg);
      return;
    }
    const roomId = randomUUID();
    const seed = randomInt(1, 2 ** 48); // < 2^48，落在安全整数内
    log.info('match starting', { mode, roomId, gameUrl, a: a.accountId, b: b.accountId, seed });

    const sign = (
      self: { accountId: string; name: string; publicId: string; equippedTitle: string },
      opp: { accountId: string; name: string; publicId: string; equippedTitle: string },
      side: 0 | 1,
    ): string => {
      const claims: TicketClaims = {
        roomId,
        seed,
        side,
        mode,
        opponent: opp.name,
        opponentPublicId: opp.publicId,
        opponentTitle: opp.equippedTitle || undefined,
        gameUrl,
        accountId: self.accountId,
      };
      return signTicket(claims, { key: this.internalKey, ttlSec: this.ticketTtlSec });
    };

    this.push(a.accountId, { kind: 'match_found', gameUrl, ticket: sign(a, b, 0) }, roomId);
    this.push(b.accountId, { kind: 'match_found', gameUrl, ticket: sign(b, a, 1) }, roomId);
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
      publicId: s.publicId,
    }));
  }

  private pushRoomState(accountId: string, room: Room): void {
    this.push(
      accountId,
      { kind: 'room_state', code: room.code, players: this.playersView(room), phase: room.phase },
      room.roomId,
    );
  }

  private broadcast(room: Room): void {
    const players = this.playersView(room);
    for (const s of room.slots) {
      this.push(s.accountId, { kind: 'room_state', code: room.code, players, phase: room.phase }, room.roomId);
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
