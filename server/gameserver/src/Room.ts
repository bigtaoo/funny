// 房间 + 服务器权威节拍器（M14）+ 非空帧日志 + 重连 + 局末结算（S1-2~5）。
//
// 节拍：模拟 30Hz；网络 10Hz，每 100ms 下发一个 frame_batch（覆盖 3 个 sim 帧）。
// cmd_submit 落到「当前窗口对应帧」= 本批次的 to_frame；同帧多指令按 side 升序、
// 再按到达序确定性排序（唯一排序者 = 服务器，否则双端发散）。
import { randomInt } from 'crypto';
import { Connection } from './Connection';
import {
  MatchMode,
  RoomPhase,
  type FrameCmds,
  type MatchModeVal,
  type PlayerSlotOut,
  type SideCmd,
} from './proto/transport';

const FRAMES_PER_BATCH = 3; // sim 30Hz ÷ net 10Hz
const BATCH_MS = 100;
const GRACE_MS = 60_000; // 掉线宽限（M10）
const START_FRAME = 0;

/**
 * 内嵌录像（S1-RP）——重连保留的非空帧日志即录像，局末零成本持久化。
 * 这是 `contracts/replay.proto` 的 **netplay 子集**：省略 `config_ref`（PvP=rosterVer，
 * 暂无 roster 版本概念）与 `meta.level_id`（仅 PvE 有），netplay 下二者恒空。
 * `commands` 仍是 game.proto opaque bytes（服务器不解码，M12）。
 */
export interface MatchReplay {
  /** 服务器逻辑无关（M12），无法自证引擎版本 → 0；客户端回放时自校验。 */
  engineVersion: number;
  mode: string; // netplay（gameserver 只承载双人真人对局）
  seed: number;
  endFrame: number; // 末帧水位（= 最后下发的 to_frame）
  frames: { frame: number; cmds: { side: number; commands: Uint8Array }[] }[];
  meta: { recordedAt: number; winner: number };
}

/** 归档对局到 matches（friendly 仅记结果 + 内嵌录像）。 */
export interface MatchArchive {
  roomId: string;
  mode: string;
  seed: number;
  players: { side: number; accountId: string }[];
  winner: number; // -1 = 未知（friendly 正常结束，胜负客户端权威）
  reason: string; // base | disconnect | mismatch
  hashOk: boolean;
  /** 内嵌录像（非空帧日志 + seed + 配置）；空局亦记（frames 为空）。 */
  replay: MatchReplay;
}

export interface RoomDeps {
  /** 房间销毁时回调（清 registry / 连接映射）。 */
  onDestroy: (roomId: string) => void;
  /** 对局归档（无 Mongo 时为 noop）。 */
  archive: (doc: MatchArchive) => void;
}

interface Slot {
  side: number;
  accountId: string;
  name: string;
  conn: Connection | null;
  ready: boolean;
}

export class Room {
  phase: number = RoomPhase.WAITING;
  private slots: Slot[] = [];

  // —— 对局态 ——
  private seed = 0;
  private curFrame = START_FRAME; // 已下发到的最新帧（= 上一批 to_frame）
  private pending: SideCmd[] = []; // 本窗口收集的指令（到达序）
  private readonly log: FrameCmds[] = []; // 非空帧日志（重连补帧 + 录像）
  private batchTimer: NodeJS.Timeout | null = null;

  // —— 掉线宽限 ——
  private graceTimer: NodeJS.Timeout | null = null;

  // —— 局末结算 ——
  private results = new Map<number, string>(); // side → stateHash
  private settled = false;

  constructor(
    readonly roomId: string,
    readonly code: string,
    readonly mode: MatchModeVal,
    private readonly deps: RoomDeps,
  ) {}

  // ───────────────────────── 房间管理 ─────────────────────────

  get isFull(): boolean {
    return this.slots.length >= 2;
  }

  hasAccount(accountId: string): boolean {
    return this.slots.some((s) => s.accountId === accountId);
  }

  /** 加入房间，返回分配的 side（满员返回 null）。 */
  addPlayer(conn: Connection): number | null {
    if (this.isFull) return null;
    const side = this.slots.length === 0 ? 0 : 1;
    this.slots.push({
      side,
      accountId: conn.accountId,
      name: conn.accountId.slice(0, 12),
      conn,
      ready: false,
    });
    conn.roomId = this.roomId;
    this.broadcastRoomState();
    return side;
  }

  private slotOf(accountId: string): Slot | undefined {
    return this.slots.find((s) => s.accountId === accountId);
  }

  private playerSlotsOut(): PlayerSlotOut[] {
    return this.slots.map((s) => ({
      side: s.side,
      name: s.name,
      ready: s.ready,
      connected: s.conn !== null,
    }));
  }

  private broadcast(send: (c: Connection) => void): void {
    for (const s of this.slots) if (s.conn) send(s.conn);
  }

  private broadcastRoomState(): void {
    const players = this.playerSlotsOut();
    this.broadcast((c) =>
      c.send({ case: 'room_state', code: this.code, players, phase: this.phase }),
    );
  }

  // ───────────────────────── 客户端消息 ─────────────────────────

  setReady(accountId: string, ready: boolean): void {
    if (this.phase >= RoomPhase.IN_MATCH) return;
    const slot = this.slotOf(accountId);
    if (!slot) return;
    slot.ready = ready;
    this.phase =
      this.slots.length === 2 && this.slots.every((s) => s.ready)
        ? RoomPhase.READY
        : RoomPhase.WAITING;
    this.broadcastRoomState();
  }

  /** 房主（side 0）在双方 ready 后开局。 */
  start(accountId: string): void {
    if (this.phase >= RoomPhase.IN_MATCH) return;
    const host = this.slots.find((s) => s.side === 0);
    if (!host || host.accountId !== accountId) return;
    if (this.slots.length !== 2 || !this.slots.every((s) => s.ready)) return;

    this.seed = randomSeed();
    this.curFrame = START_FRAME;
    this.phase = RoomPhase.IN_MATCH;
    for (const s of this.slots) {
      s.conn?.send({
        case: 'match_start',
        roomId: this.roomId,
        mode: this.mode,
        seed: this.seed,
        startFrame: START_FRAME,
        localSide: s.side,
      });
    }
    this.startMetronome();
  }

  /** cmd_submit：塞进当前窗口（下个批次的 to_frame）。 */
  submitCmd(accountId: string, commands: Uint8Array): void {
    if (this.phase !== RoomPhase.IN_MATCH) return;
    const slot = this.slotOf(accountId);
    if (!slot) return;
    this.pending.push({ side: slot.side, commands });
  }

  /** 局末上报状态 hash → 双方齐 → 比对 + 结算（S1-5）。 */
  reportResult(accountId: string, stateHash: string): void {
    if (this.phase !== RoomPhase.IN_MATCH || this.settled) return;
    const slot = this.slotOf(accountId);
    if (!slot) return;
    this.results.set(slot.side, stateHash);
    if (this.results.size < this.slots.length) return; // 等另一方

    const hashes = [...this.results.values()];
    const hashOk = hashes.every((h) => h === hashes[0]);
    // friendly 正常结束：胜负由客户端模拟权威决定，服务器只审计/归档。
    this.endMatch({ winnerSide: -1, reason: hashOk ? 'base' : 'mismatch', hashOk });
  }

  /** 显式离开。对局中视为认输（对手胜）。 */
  leave(accountId: string): void {
    const slot = this.slotOf(accountId);
    if (!slot) return;
    if (this.phase === RoomPhase.IN_MATCH) {
      const peer = this.slots.find((s) => s.side !== slot.side);
      this.endMatch({
        winnerSide: peer ? peer.side : -1,
        reason: 'disconnect',
        hashOk: true,
      });
      return;
    }
    this.removeSlot(accountId);
  }

  // ───────────────────────── 断线 / 重连（S1-4）─────────────────────────

  /**
   * 连接关闭。对局中 → 停发 + peer_dc + 60s 宽限；局前 → 退出房间。
   * 传入关闭的连接：若 slot 已被新连接（重连）顶替则忽略，避免误清新连接。
   */
  onDisconnect(accountId: string, closing: Connection): void {
    const slot = this.slotOf(accountId);
    if (!slot || slot.conn !== closing) return; // 已被新连接顶替则忽略
    slot.conn = null;

    if (this.phase !== RoomPhase.IN_MATCH) {
      this.removeSlot(accountId);
      return;
    }
    // 对局中：停节拍器，通知在线方，起宽限计时
    this.stopMetronome();
    this.broadcastRoomState();
    const peer = this.slots.find((s) => s.side !== slot.side && s.conn);
    peer?.conn?.send({ case: 'peer_dc', side: slot.side, graceMs: GRACE_MS });
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.endMatch({
        winnerSide: peer ? peer.side : -1,
        reason: 'disconnect',
        hashOk: true,
      });
    }, GRACE_MS);
  }

  /** 重连：重绑连接 + conn_resync 补帧 + 续发节拍（S1-4）。 */
  resume(conn: Connection, lastFrame: number): void {
    const slot = this.slotOf(conn.accountId);
    if (!slot || this.phase !== RoomPhase.IN_MATCH || this.settled) {
      conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no active match' });
      return;
    }
    slot.conn = conn;
    conn.roomId = this.roomId;

    conn.send({
      case: 'conn_resync',
      seed: this.seed,
      startFrame: START_FRAME,
      log: this.log.filter((f) => f.frame > lastFrame),
      curFrame: this.curFrame,
    });
    this.broadcastRoomState();

    // 双方都在线 → 清宽限、续发节拍
    if (this.slots.every((s) => s.conn)) {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.startMetronome();
    }
  }

  private removeSlot(accountId: string): void {
    this.slots = this.slots.filter((s) => s.accountId !== accountId);
    if (this.slots.length === 0) {
      this.destroy();
      return;
    }
    if (this.phase === RoomPhase.READY) this.phase = RoomPhase.WAITING;
    this.broadcastRoomState();
  }

  // ───────────────────────── 节拍器（M14）─────────────────────────

  private startMetronome(): void {
    if (this.batchTimer) return;
    // 仅双方在线时推进
    if (!this.slots.every((s) => s.conn)) return;
    this.batchTimer = setInterval(() => this.tickBatch(), BATCH_MS);
  }

  private stopMetronome(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private tickBatch(): void {
    this.curFrame += FRAMES_PER_BATCH;
    let frames: FrameCmds[] = [];
    if (this.pending.length > 0) {
      // 确定性 tiebreak：side 升序（Array.sort 稳定 → 同 side 保到达序）
      const cmds = [...this.pending].sort((a, b) => a.side - b.side);
      const fc: FrameCmds = { frame: this.curFrame, cmds };
      this.log.push(fc);
      frames = [fc];
      this.pending = [];
    }
    this.broadcast((c) =>
      c.send({ case: 'frame_batch', toFrame: this.curFrame, frames }),
    );
  }

  // ───────────────────────── 结算 / 销毁 ─────────────────────────

  private endMatch(opts: { winnerSide: number; reason: string; hashOk: boolean }): void {
    if (this.settled) return;
    this.settled = true;
    this.stopMetronome();
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.phase = RoomPhase.OVER;

    this.broadcast((c) =>
      c.send({
        case: 'match_over',
        winnerSide: opts.winnerSide < 0 ? 0 : opts.winnerSide,
        reason: opts.reason,
        mismatch: !opts.hashOk,
      }),
    );

    this.deps.archive({
      roomId: this.roomId,
      mode: this.mode === MatchMode.RANKED ? 'ranked' : 'friendly',
      seed: this.seed,
      players: this.slots.map((s) => ({ side: s.side, accountId: s.accountId })),
      winner: opts.winnerSide,
      reason: opts.reason,
      hashOk: opts.hashOk,
      replay: this.buildReplay(opts.winnerSide),
    });

    this.destroy();
  }

  /**
   * Assemble the inline replay from the retained non-empty frame log (S1-RP).
   * Zero extra capture cost — `this.log` is the same buffer kept for reconnect.
   * `commands` stay opaque (Buffer of game.proto bytes); the server never decodes.
   */
  private buildReplay(winnerSide: number): MatchReplay {
    return {
      engineVersion: 0, // logic-agnostic server; client self-validates on playback
      mode: 'netplay',
      seed: this.seed,
      endFrame: this.curFrame,
      frames: this.log.map((fc) => ({
        frame: fc.frame,
        cmds: fc.cmds.map((sc) => ({ side: sc.side, commands: Buffer.from(sc.commands) })),
      })),
      meta: { recordedAt: Date.now(), winner: winnerSide },
    };
  }

  destroy(): void {
    this.stopMetronome();
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    for (const s of this.slots) if (s.conn) s.conn.roomId = null;
    this.deps.onDestroy(this.roomId);
  }
}

/** 安全整数范围内随机种子（< 2^48，落在 Number.MAX_SAFE_INTEGER 内，protobuf uint64 可承载）。 */
function randomSeed(): number {
  // gameserver 非游戏逻辑层，可用 crypto；确定性由 seed 下发双端保证。
  return randomInt(1, 2 ** 48);
}
