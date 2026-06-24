import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly } from '../net/anomaly';

// 运行时 CPU / 主线程饱和看护：浏览器无直接 CPU 用量 API，可观测的等价信号是「主线程被占满」。
// 两路并行采样，任一持续越线即上报一条 cpu 异常（reportAnomaly → 全量通道 → Loki）：
//
//   ① 长任务忙碌比（仅 Chromium / 支持 PerformanceObserver('longtask') 处）：累计窗口内所有 >50ms 的
//      主线程长任务时长 ÷ 窗口长度。比值高 = 主线程被 JS 占满 = 体感「CPU 飙高 / 卡顿」。
//   ② 持续低 FPS（处处可用，含微信）：用 ticker.deltaMS 估每窗 FPS，连续多窗低于阈值即判定持续卡顿。
//      不支持 longtask 的环境（微信）靠这一路兜底。
//
// 与 MemoryMonitor 同构：挂 app.ticker、跨场景常驻、冷却防刷（reportAnomaly 内已对 cpu 类设 60s 冷却）。
// 阈值可用 localStorage 'nw_fps_warn'（持续低于此 FPS 判卡顿）/ 'nw_cpu_busy_warn'（长任务忙碌比 0~1）覆盖。

const log = netLog('perf');

const DEFAULT_FPS_WARN = 30;        // 持续低于此 FPS 视为卡顿
const DEFAULT_BUSY_WARN = 0.5;      // 长任务忙碌比 ≥ 此值视为主线程饱和
const WINDOW_MS = 2_000;            // 采样窗口
const SUSTAIN_WINDOWS = 5;          // 连续这么多个低 FPS 窗口（≈10s）才上报，避免瞬时尖峰误报

function numFromLs(key: string, fallback: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage 不可用：用默认 */ }
  return fallback;
}

interface LongTaskEntry { duration: number }
interface PerfObserver { observe(opts: { entryTypes: string[] }): void; disconnect(): void }

/** 全应用单例的 CPU / 主线程饱和看护。app.ts 启动 install(app.ticker) 一次，跨场景常驻。 */
export class PerfMonitor {
  private ticker: PIXI.Ticker | null = null;
  private accMs = 0;
  private frames = 0;
  private lowFpsStreak = 0;
  /** 当前采样窗内累计的长任务时长（ms）；PerformanceObserver 回调里累加，窗末清零。 */
  private longTaskMs = 0;
  private observer: PerfObserver | null = null;

  install(ticker: PIXI.Ticker): void {
    this.ticker = ticker;
    ticker.add(this.onTick);
    this.installLongTaskObserver();
  }

  uninstall(): void {
    this.ticker?.remove(this.onTick);
    this.ticker = null;
    try { this.observer?.disconnect(); } catch { /* ignore */ }
    this.observer = null;
  }

  private installLongTaskObserver(): void {
    const Ctor = (globalThis as { PerformanceObserver?: new (cb: (list: { getEntries(): LongTaskEntry[] }) => void) => PerfObserver }).PerformanceObserver;
    if (!Ctor) return; // 不支持（微信等）：仅靠 FPS 一路
    try {
      this.observer = new Ctor((list) => {
        for (const e of list.getEntries()) this.longTaskMs += e.duration;
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch { this.observer = null; } // 部分环境构造成功但 observe('longtask') 抛：降级到 FPS
  }

  private onTick = (): void => {
    this.frames += 1;
    this.accMs += this.ticker?.deltaMS ?? 16.7;
    if (this.accMs < WINDOW_MS) return;

    const windowMs = this.accMs;
    const fps = (this.frames * 1000) / windowMs;
    const busyRatio = Math.min(1, this.longTaskMs / windowMs);
    this.accMs = 0;
    this.frames = 0;
    this.longTaskMs = 0;

    // ① 长任务忙碌比：单窗即越线就报（长任务本身已是「主线程被占满」的硬证据）。
    if (this.observer && busyRatio >= numFromLs('nw_cpu_busy_warn', DEFAULT_BUSY_WARN)) {
      reportAnomaly('cpu', `main-thread busy ${(busyRatio * 100).toFixed(0)}% over ${Math.round(windowMs)}ms`, {
        busyRatio: Math.round(busyRatio * 100) / 100, windowMs: Math.round(windowMs), fps: Math.round(fps),
      });
      log.warn(`main-thread busy ${(busyRatio * 100).toFixed(0)}%`, { fps: Math.round(fps) });
      return; // 已报，本窗不再叠加 FPS 路径
    }

    // ② 持续低 FPS：连续多窗才报（瞬时掉帧/切场景不算）。
    const fpsWarn = numFromLs('nw_fps_warn', DEFAULT_FPS_WARN);
    if (fps < fpsWarn) {
      this.lowFpsStreak += 1;
      if (this.lowFpsStreak >= SUSTAIN_WINDOWS) {
        this.lowFpsStreak = 0;
        reportAnomaly('cpu', `sustained low fps ~${fps.toFixed(0)} (<${fpsWarn}) for ${Math.round((WINDOW_MS * SUSTAIN_WINDOWS) / 1000)}s`, {
          fps: Math.round(fps), thresholdFps: fpsWarn, sustainedMs: WINDOW_MS * SUSTAIN_WINDOWS,
        });
        log.warn(`sustained low fps ~${fps.toFixed(0)}`);
      }
    } else {
      this.lowFpsStreak = 0;
    }
  };
}
