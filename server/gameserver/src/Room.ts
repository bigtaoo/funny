// 房间纯帧中继 + 服务器权威节拍器（M14）+ 非空帧日志 + 重连 + 局末上报 meta（S1-M2/M3）。
//
// 瘦身后（M16）：gameserver 不建房 / 不匹配 / 不连库。房间由 ticket 握手按需创建：
// 同 roomId 的两张 ticket（side 0/1，seed 一致）凑齐即开局。无 ready / 房主环节
// （那些在 matchsvc 控制面已完成）。局末把结果 + 录像 POST 给 meta 结算/归档。
//
// 节拍：模拟 30Hz；网络 10Hz，每 100ms 下发一个 frame_batch（覆盖 3 个 sim 帧）。
// cmd_submit 落到「当前窗口对应帧」= 本批次的 to_frame；同帧多指令按 side 升序确定性排序。
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
// 第一名玩家到位后，等第二名连上的上限（覆盖 ticket TTL + 余量）。
// 超时未开局 → 销毁空等房间，防止「拿到 ticket 却没连上」泄漏房间。
const LAUNCH_TIMEOUT_MS = 35_000;

/**
 * 内嵌录像（S1-RP）——重连保留的非空帧日志即录像，局末随上报零成本持久化（meta 写 matches）。
 * `commands` 仍是 game.proto opaque bytes（服务器不解码，M12）。
 */
export interface MatchReplay {
  engineVersion: number; // 服务器逻辑无关 → 0；客户端回放自校验
  mode: string;
  seed: number;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: Uint8Array }[] }[];
  meta: { recordedAt: number; winner: number };
}

/** 单方 ELO 结算结果（meta 回给 game → 转 match_over.elo）。 */
export interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}
/** side → ELO 变化（ranked 结算时 meta 回传）。 */
export type EloBySide = Record<number, EloResult>;

/** 局末上报 meta 的载荷（M19，§8.3）。 */
export interface MatchReport {
  roomId: string;
  seed: number;
  mode: string; // friendly | ranked
  reason: string; // base | disconnect | mismatch
  winnerSide: number; // -1 = 未知
  hashOk: boolean;
  players: { side: number; accountId: string }[];
  results: { side: number; stateHash: string; winnerSide: number }[];
  replay: MatchReplay;
}

export interface RoomDeps {
  /** 房间销毁时回调（清 manager 映射）。 */
  onDestroy: (roomId: string) => void;
  /**
   * 局末上报 meta（结算 + 归档）。返回每方 ELO 变化（ranked 结算成功）或 null。
   * friendly 不阻塞 match_over（fire-and-forget）；ranked await 后带 elo 下发。
   */
  report: (r: MatchReport) => Promise<EloBySide | null>;
}

interface Slot {
  side: 0 | 1;
  accountId: string;
  name: string; // 对手展示名（来自对方 ticket.opponent → 实为本方 name；UI 用）
  conn: Connection | null;
}

export class Room {
  phase: number = RoomPhase.WAITING;
  private slots: Slot[] = [];

  private curFrame = START_FRAME;
  private pending: SideCmd[] = [];
  private readonly log: FrameCmds[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private launchTimer: NodeJS.Timeout | null = null;

  private results = new Map<number, { hash: string; winner: number }>();
  private settled = false;

  constructor(
    readonly roomId: string,
    /** ticket 派定的种子（双方一致；gameserver 不再生成）。 */
    private readonly seed: number,
    readonly mode: MatchModeVal,
    private readonly deps: RoomDeps,
  ) {}

  // ───────────────────────── 房间管理 ─────────────────────────

  get isFull(): boolean {
    return this.slots.length >= 2;
  }

  /** 房间种子（RoomManager 交叉核对第二张 ticket 用）。 */
  get seedValue(): number {
    return this.seed;
  }

  hasSide(side: number): boolean {
    return this.slots.some((s) => s.side === side);
  }
  hasAccount(accountId: string): boolean {
    return this.slots.some((s) => s.accountId === accountId);
  }

  /** 按 ticket 加入指定 side；两人凑齐即开局。重复 side 忽略。 */
  addPlayer(conn: Connection, name: string): void {
    if (this.phase >= RoomPhase.IN_MATCH) return; // 已开局，新增走 resume
    if (this.hasSide(conn.side)) return;
    this.slots.push({ side: conn.side, accountId: conn.accountId, name, conn });
    if (this.slots.length === 2) {
      this.launch();
    } else if (!this.launchTimer) {
      // 第一名就位 → 起空等超时，第二名迟迟不连则销毁空房。
      this.launchTimer = setTimeout(() => {
        this.launchTimer = null;
        if (this.phase < RoomPhase.IN_MATCH) this.destroy();
      }, LAUNCH_TIMEOUT_MS);
      this.launchTimer.unref?.();
    }
  }

  private slotOfSide(side: number): Slot | undefined {
    return this.slots.find((s) => s.side === side);
  }

  private playerSlotsOut(): PlayerSlotOut[] {
    return this.slots.map((s) => ({
      side: s.side,
      name: s.name,
      ready: true,
      connected: s.conn !== null,
    }));
  }

  private broadcast(send: (c: Connection) => void): void {
    for (const s of this.slots) if (s.conn) send(s.conn);
  }

  // ───────────────────────── 开局 ─────────────────────────

  private launch(): void {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
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

  submitCmd(side: number, commands: Uint8Array): void {
    if (this.phase !== RoomPhase.IN_MATCH) return;
    if (!this.hasSide(side)) return;
    this.pending.push({ side, commands });
  }

  /** 局末上报 hash + 客户端判定胜方 → 双方齐 → 比对 + 结算（meta 权威算 ELO）。 */
  reportResult(side: number, stateHash: string, winnerSide: number): void {
    if (this.phase !== RoomPhase.IN_MATCH || this.settled) return;
    if (!this.hasSide(side)) return;
    this.results.set(side, { hash: stateHash, winner: winnerSide });
    if (this.results.size < this.slots.length) return;

    const reports = [...this.results.values()];
    const hashOk = reports.every((r) => r.hash === reports[0]!.hash);
    if (this.mode === MatchMode.RANKED) {
      const winnersAgree = reports.every((r) => r.winner === reports[0]!.winner);
      if (hashOk && winnersAgree) {
        void this.endMatch({ winnerSide: reports[0]!.winner, reason: 'base', hashOk: true });
      } else {
        void this.endMatch({ winnerSide: -1, reason: 'mismatch', hashOk: false });
      }
      return;
    }
    // friendly：胜负由客户端模拟权威决定，meta 只审计/归档。
    void this.endMatch({ winnerSide: -1, reason: hashOk ? 'base' : 'mismatch', hashOk });
  }

  /** 显式离开。对局中视为认输（对手胜）。 */
  leave(side: number): void {
    const slot = this.slotOfSide(side);
    if (!slot) return;
    if (this.phase === RoomPhase.IN_MATCH) {
      const peer = this.slots.find((s) => s.side !== side);
      void this.endMatch({ winnerSide: peer ? peer.side : -1, reason: 'disconnect', hashOk: true });
      return;
    }
    this.removeSlot(side);
  }

  // ───────────────────────── 断线 / 重连（S1-4）─────────────────────────

  onDisconnect(side: number, closing: Connection): void {
    const slot = this.slotOfSide(side);
    if (!slot || slot.conn !== closing) return; // 已被新连接顶替则忽略
    slot.conn = null;

    if (this.phase !== RoomPhase.IN_MATCH) {
      this.removeSlot(side);
      return;
    }
    this.stopMetronome();
    const peer = this.slots.find((s) => s.side !== side && s.conn);
    peer?.conn?.send({ case: 'peer_dc', side, graceMs: GRACE_MS });
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.endMatch({
        winnerSide: peer ? peer.side : -1,
        reason: 'disconnect',
        hashOk: true,
      });
    }, GRACE_MS);
  }

  /** 重连：重绑连接 + conn_resync 补帧 + 续发节拍。 */
  resume(conn: Connection, lastFrame: number): void {
    const slot = this.slotOfSide(conn.side);
    if (!slot || this.phase !== RoomPhase.IN_MATCH || this.settled) {
      conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no active match' });
      return;
    }
    slot.conn = conn;
    conn.send({
      case: 'conn_resync',
      seed: this.seed,
      startFrame: START_FRAME,
      log: this.log.filter((f) => f.frame > lastFrame),
      curFrame: this.curFrame,
    });

    if (this.slots.every((s) => s.conn)) {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.startMetronome();
    }
  }

  private removeSlot(side: number): void {
    this.slots = this.slots.filter((s) => s.side !== side);
    if (this.slots.length === 0) this.destroy();
  }

  // ───────────────────────── 节拍器（M14）─────────────────────────

  private startMetronome(): void {
    if (this.batchTimer) return;
    if (!this.slots.every((s) => s.conn) || this.slots.length !== 2) return;
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
      const cmds = [...this.pending].sort((a, b) => a.side - b.side); // 稳定排序保到达序
      const fc: FrameCmds = { frame: this.curFrame, cmds };
      this.log.push(fc);
      frames = [fc];
      this.pending = [];
    }
    this.broadcast((c) => c.send({ case: 'frame_batch', toFrame: this.curFrame, frames }));
  }

  // ───────────────────────── 结算（上报 meta）/ 销毁 ─────────────────────────

  private async endMatch(opts: {
    winnerSide: number;
    reason: string;
    hashOk: boolean;
  }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopMetronome();
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.phase = RoomPhase.OVER;

    const report: MatchReport = {
      roomId: this.roomId,
      seed: this.seed,
      mode: this.mode === MatchMode.RANKED ? 'ranked' : 'friendly',
      reason: opts.reason,
      winnerSide: opts.winnerSide,
      hashOk: opts.hashOk,
      players: this.slots.map((s) => ({ side: s.side, accountId: s.accountId })),
      results: [...this.results.entries()].map(([side, r]) => ({
        side,
        stateHash: r.hash,
        winnerSide: r.winner,
      })),
      replay: this.buildReplay(opts.winnerSide),
    };

    // ranked：等 meta 结算回 ELO 再下发 match_over；friendly：立即下发，上报 fire-and-forget。
    let eloBySide: EloBySide | null = null;
    if (this.mode === MatchMode.RANKED) {
      try {
        eloBySide = await this.deps.report(report);
      } catch (e) {
        console.error('[gameserver] meta report (ranked) failed:', e);
      }
    } else {
      void this.deps.report(report).catch((e) =>
        console.error('[gameserver] meta report (friendly) failed:', e),
      );
    }

    this.broadcast((c) => {
      const elo = eloBySide ? eloBySide[c.side] : undefined;
      c.send({
        case: 'match_over',
        winnerSide: opts.winnerSide < 0 ? 0 : opts.winnerSide,
        reason: opts.reason,
        mismatch: !opts.hashOk,
        ...(elo ? { elo } : {}),
      });
    });

    this.destroy();
  }

  private buildReplay(winnerSide: number): MatchReplay {
    return {
      engineVersion: 0,
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
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
    this.deps.onDestroy(this.roomId);
  }
}
