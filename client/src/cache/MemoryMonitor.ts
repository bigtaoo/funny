import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly } from '../net/anomaly';
import { snapshotPools } from './poolRegistry';

// 运行时内存看护：每隔几秒读 JS 堆占用，超阈值就 console.warn 一条，并把各对象池的
// 空闲对象数 / 粗估占用一起 dump 出来（poolRegistry.snapshotPools）。微信小游戏侧再额外接
// wx.onMemoryWarning（操作系统级低内存信号，才是真预算闸门）。
//
// 注意：performance.memory.usedJSHeapSize 只反映 **JS 堆**，不含 GPU 显存（spritesheet/纹理）。
// 但本游戏历史上的大泄漏（每局退场不 destroy → Ticker.shared 闭包钉住整张场景图，连玩涨到 10GB+）
// 正是 JS 堆类泄漏，所以盯 usedJSHeapSize 恰好能逮住这一类问题。仅 Chromium / 微信支持 performance.memory，
// 其它环境自动降级为「只接 wx 信号、不做堆采样」。

const log = netLog('mem');
const MB = 1024 * 1024;

// JS 堆告警默认阈值（MB）。健康的一局战斗 JS 堆通常远低于 150MB；这里留足余量取 400MB，
// 既不会被正常波动误触，又能在泄漏类无界增长时（迟早越过）报出来。可用
// localStorage.setItem('nw_mem_warn_mb', '250') 按平台收紧（如低端安卓 / 微信）。
const DEFAULT_WARN_MB = 400;

const SAMPLE_EVERY_MS = 5_000;   // 采样间隔
const REWARN_EVERY_MS = 30_000;  // 两次告警之间的最小间隔（避免刷屏）

interface JSHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readHeap(): JSHeap | null {
  const m = (performance as unknown as { memory?: JSHeap })?.memory;
  return m && typeof m.usedJSHeapSize === 'number' ? m : null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

function warnThresholdMB(): number {
  try {
    const raw = globalThis.localStorage?.getItem('nw_mem_warn_mb');
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage 不可用：用默认 */ }
  return DEFAULT_WARN_MB;
}

const round = (n: number, d = 1): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * 场景图 PIXI 级计数：纹理缓存条目数 / stage 下显示对象总数 / ticker 监听器数。
 * 这三个数把「堆涨但池空」的纯 JS 保留型泄漏定性到具体一类——纹理缓存无界增长 vs
 * 退场不 destroy 的场景图残留 vs ticker 闭包钉死（见本文件顶注的历史泄漏）。
 * 仅在告警时（60s 冷却）跑一次；遍历设上限，避免泄漏已发生时计数本身再加重卡顿。
 */
const NODE_WALK_CAP = 200_000;

function countNodes(root: PIXI.Container | null): number {
  if (!root) return -1;
  let n = 0;
  const stack: PIXI.DisplayObject[] = [root];
  while (stack.length > 0 && n < NODE_WALK_CAP) {
    const obj = stack.pop() as PIXI.Container;
    n += 1;
    const kids = obj.children;
    if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return n;
}

function cacheSize(name: 'TextureCache' | 'BaseTextureCache'): number {
  const c = (PIXI.utils as unknown as Record<string, Record<string, unknown> | undefined>)[name];
  return c ? Object.keys(c).length : -1;
}

/**
 * 全应用单例的内存看护。app.ts 启动时 install(app.ticker) 一次，跨场景常驻；
 * 无战斗时池注册表为空，则只报堆读数。
 */
export class MemoryMonitor {
  private ticker: PIXI.Ticker | null = null;
  private stage: PIXI.Container | null = null;
  private accMs = 0;
  private lastWarnMs = -Infinity;

  install(ticker: PIXI.Ticker, stage?: PIXI.Container): void {
    this.ticker = ticker;
    this.stage = stage ?? null;
    ticker.add(this.onTick);

    // 微信小游戏：操作系统的低内存回调才是真预算闸门（performance.memory 在微信运行时通常不可用）。
    const wx = (globalThis as unknown as { wx?: { onMemoryWarning?: (cb: (res: { level?: number }) => void) => void } }).wx;
    wx?.onMemoryWarning?.((res) => {
      this.dump(`wx onMemoryWarning（level ${res?.level ?? '?'}）`);
    });
  }

  uninstall(): void {
    this.ticker?.remove(this.onTick);
    this.ticker = null;
  }

  private onTick = (): void => {
    this.accMs += this.ticker?.deltaMS ?? 16.7;
    if (this.accMs < SAMPLE_EVERY_MS) return;
    this.accMs = 0;

    const heap = readHeap();
    if (!heap) return; // 不支持堆采样的环境：只靠 wx 信号

    const usedMB = heap.usedJSHeapSize / MB;
    const threshold = warnThresholdMB();
    if (usedMB < threshold) return;

    const t = nowMs();
    if (t - this.lastWarnMs < REWARN_EVERY_MS) return;
    this.lastWarnMs = t;
    this.dump(`JS 堆 ${usedMB.toFixed(0)}MB 超过 ${threshold}MB 告警阈值`);
  };

  /** 立刻打一条内存 + 池占用的告警（堆超阈值 / 收到 wx 低内存信号时调用）。 */
  private dump(reason: string): void {
    const heap = readHeap();
    const pools = snapshotPools();
    const heapInfo = heap
      ? { usedMB: round(heap.usedJSHeapSize / MB), totalMB: round(heap.totalJSHeapSize / MB), limitMB: round(heap.jsHeapSizeLimit / MB) }
      : 'unavailable';
    const poolTotal = { idle: pools.totalIdle, estMB: round(pools.totalBytes / MB, 2) };
    // PIXI 级计数：池为空（poolTotal.estMB≈0）却堆涨时，这三个数定性是哪一类保留型泄漏。
    const nodes = countNodes(this.stage);
    const gpu = {
      tex: cacheSize('TextureCache'),
      baseTex: cacheSize('BaseTextureCache'),
      nodes: nodes >= NODE_WALK_CAP ? `${NODE_WALK_CAP}+` : nodes,
      tickers: this.ticker?.count ?? -1,
    };
    log.warn(reason, {
      heap: heapInfo,
      pools: pools.rows.map((r) => ({ label: r.label, idle: r.idle, estKB: round(r.estBytes / 1024) })),
      poolTotal,
      gpu,
    });
    // 同步进「全量异常上报」通道（与定向采集的环形缓冲并行）：全网任何客户端内存超标都直报 Loki。
    // reportAnomaly 内对 mem 类有 60s 冷却，不会因 5s 采样而刷屏。
    reportAnomaly('mem', reason, { heap: heapInfo, poolTotal, gpu });
  }
}
