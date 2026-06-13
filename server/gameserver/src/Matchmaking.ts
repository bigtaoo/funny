// Ranked 匹配队列（S1-R）。按 ELO 邻近配对；等待越久，可接受的分差窗口越宽，
// 保证冷门时段也能在有限等待内成局。单实例内存队列（多实例横扩需共享队列，留后续）。
import type { Connection } from './Connection';

export interface QueueEntry {
  accountId: string;
  conn: Connection;
  elo: number;
  enqueuedAt: number;
}

export interface MatchmakingOpts {
  /** 初始可接受分差窗口（半宽）。默认 100。 */
  baseWindow?: number;
  /** 每等待 1s 窗口加宽量。默认 50。 */
  widenPerSec?: number;
  /** 配对巡检间隔 ms。默认 1000。 */
  tickMs?: number;
  /** 注入时钟（测试用）。默认 Date.now。 */
  now?: () => number;
  /** 是否自动起定时器巡检。默认 true；测试可关掉手动 tick()。 */
  autoTick?: boolean;
}

export class Matchmaking {
  private queue: QueueEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  private readonly baseWindow: number;
  private readonly widenPerSec: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly autoTick: boolean;

  constructor(
    /** 配对成功回调：移出队列由本类负责，建房由上层处理。 */
    private readonly onPair: (a: QueueEntry, b: QueueEntry) => void,
    opts: MatchmakingOpts = {},
  ) {
    this.baseWindow = opts.baseWindow ?? 100;
    this.widenPerSec = opts.widenPerSec ?? 50;
    this.tickMs = opts.tickMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.autoTick = opts.autoTick ?? true;
  }

  has(accountId: string): boolean {
    return this.queue.some((e) => e.accountId === accountId);
  }

  get size(): number {
    return this.queue.length;
  }

  /** 入队（同账号再次入队覆盖旧条目，重置等待）。入队后尝试一次配对。 */
  enqueue(conn: Connection, elo: number): void {
    this.remove(conn.accountId);
    this.queue.push({ accountId: conn.accountId, conn, elo, enqueuedAt: this.now() });
    this.ensureTimer();
    this.tick();
  }

  /** 出队（取消匹配 / 掉线 / 已配对）。队空则停巡检。 */
  remove(accountId: string): void {
    this.queue = this.queue.filter((e) => e.accountId !== accountId);
    if (this.queue.length === 0) this.stopTimer();
  }

  /**
   * 一轮配对：按 ELO 升序，相邻两人若分差 ≤ 窗口（取两人中等待更久者的窗口）即配对。
   * 贪心相邻配对对「按分排序后的队列」足够好且确定（避免饥饿）。
   */
  tick(): void {
    if (this.queue.length < 2) return;
    const t = this.now();
    const sorted = [...this.queue].sort((a, b) => a.elo - b.elo);
    const paired = new Set<string>();

    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (paired.has(a.accountId) || paired.has(b.accountId)) continue;
      const window = Math.max(this.windowFor(a, t), this.windowFor(b, t));
      if (Math.abs(a.elo - b.elo) <= window) {
        paired.add(a.accountId);
        paired.add(b.accountId);
      }
    }
    if (paired.size === 0) return;

    // 先从队列移除已配对者，再回调建房（回调里可能再入队，不能被本轮误删）。
    const pairs: [QueueEntry, QueueEntry][] = [];
    const sortedPaired = sorted.filter((e) => paired.has(e.accountId));
    for (let i = 0; i + 1 < sortedPaired.length; i += 2) {
      pairs.push([sortedPaired[i]!, sortedPaired[i + 1]!]);
    }
    this.queue = this.queue.filter((e) => !paired.has(e.accountId));
    if (this.queue.length === 0) this.stopTimer();
    for (const [a, b] of pairs) this.onPair(a, b);
  }

  /** 清空（关服）。 */
  clear(): void {
    this.queue = [];
    this.stopTimer();
  }

  private windowFor(e: QueueEntry, t: number): number {
    const waitSec = Math.max(0, (t - e.enqueuedAt) / 1000);
    return this.baseWindow + waitSec * this.widenPerSec;
  }

  private ensureTimer(): void {
    if (!this.autoTick || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // 不阻止进程退出。
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
