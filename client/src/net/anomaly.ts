// 客户端异常事件「全量」上报通道（与 FEATURE_FLAGS_DESIGN §9「客户端日志定向采集」并列、互补）。
//
// 定向采集只在被白名单点名的 publicId 上回捞日志；本通道相反——**任何**客户端遇到下列异常都直报
// metaserver → Loki，便于在全网定位野外异常（无需事先点名）：
//   mem        JS 堆超阈值（MemoryMonitor 旁路喂入）
//   cpu        主线程持续饱和 / 持续低 FPS（PerfMonitor）
//   webgl_lost WebGL 上下文丢失（黑屏类故障的关键信号）
//   anr        主循环卡死 / 长时间冻结（看门狗）
//   jserror    未捕获异常 / Promise 拒绝（log.ts errorSink 旁路）
//   crash      上次会话异常退出（崩溃哨兵下次启动补报）
//
// 防滥用四闸：① 每类事件冷却（高频信号 60s 合一）② 单会话总量上限 ③ 单条 detail 截断
// ④ 服务端按 IP 限流（service.ts）。无 baseUrl / Loki 不可达 → 静默丢弃，绝不影响玩家。
//
// 崩溃捕获两路：
//   ① 离场（pagehide / visibilitychange→hidden）用 navigator.sendBeacon（存活于页面卸载）抢发队列 +
//      最近面包屑，逮住「软崩溃 / 卡死后被关 / 报错后刷新」这类**有清理机会**的崩溃。
//   ② 真·硬崩溃（OOM / 渲染进程被杀 / 标签页被杀）当场无机会上报——改用 localStorage「会话哨兵」：
//      启动写标记 + 心跳更新存活时刻，离场标记 cleanExit；下次启动若发现上次哨兵有标记却无 cleanExit，
//      即判定上次会话崩溃，带「大约崩溃时刻 + 最后一条错误」补报一条 crash 事件。

import { recentClientLogs, netLog, setErrorSink } from './log';
import { getApiBaseUrl } from './config';

const log = netLog('anomaly');

export type AnomalyType = 'mem' | 'cpu' | 'webgl_lost' | 'anr' | 'jserror' | 'crash';

/** 一条异常事件（与服务端 metaserver/clientLog.ts 的 ClientAnomalyEvent 同形）。 */
interface AnomalyEvent {
  type: AnomalyType;
  ts: number; // epoch ms
  msg: string;
  detail?: string; // 结构化补充压成单串、截断防爆
}

const ENDPOINT = '/client/anomaly';
const FLUSH_DEBOUNCE_MS = 1_500; // 入队后合批延迟（突发合流，少发几个包）
const SESSION_CAP = 50;          // 单会话最多上报事件数（兜底防风暴）
const MSG_MAX = 300;
const DETAIL_MAX = 800;
const BREADCRUMB_N = 12;          // 崩溃 / 离场 beacon 捎带的最近日志条数

// 各类型再次上报的最小间隔（ms）。高频采样类（mem/cpu/anr）合流防刷；webgl/crash 罕见，仅受会话上限约束。
const COOLDOWN_MS: Record<AnomalyType, number> = {
  mem: 60_000, cpu: 60_000, anr: 30_000, jserror: 10_000, webgl_lost: 0, crash: 0,
};

function platformName(): string {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  return t === 'wechat' || t === 'crazygames' ? t : 'web';
}

function readPublicId(): string | null {
  try { return globalThis.localStorage?.getItem('nw_player_public_id') ?? null; } catch { return null; }
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

function stringifyDetail(detail: Record<string, unknown>): string {
  let s: string;
  try { s = JSON.stringify(detail); } catch { s = String(detail); }
  return clip(s, DETAIL_MAX);
}

class AnomalyReporter {
  private queue: AnomalyEvent[] = [];
  private sent = 0;
  private lastByType: Partial<Record<AnomalyType, number>> = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 上报一条异常事件（带冷却 + 会话上限 + detail 截断）。任何环境安全；无 baseUrl 时入队待离场 beacon。 */
  report(type: AnomalyType, msg: string, detail?: Record<string, unknown>): void {
    const now = Date.now();
    if (now - (this.lastByType[type] ?? -Infinity) < COOLDOWN_MS[type]) return; // 冷却内：丢弃
    if (this.sent + this.queue.length >= SESSION_CAP) return;                    // 会话上限
    this.lastByType[type] = now;
    const ev: AnomalyEvent = { type, ts: now, msg: clip(msg, MSG_MAX) };
    if (detail) ev.detail = stringifyDetail(detail);
    this.queue.push(ev);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, FLUSH_DEBOUNCE_MS);
  }

  /** 普通 fetch 上报（fire-and-forget；keepalive 让晚到的也尽量发完）。失败静默、不回灌队列（防离线无限堆积）。 */
  private async flush(): Promise<void> {
    const base = getApiBaseUrl();
    if (!base || this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    this.sent += events.length;
    try {
      await fetch(`${base}${ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicId: readPublicId() ?? undefined, platform: platformName(), events }),
        keepalive: true,
      });
    } catch { /* 尽力而为，静默 */ }
  }

  /**
   * 离场抢发：把待发队列 + 最近面包屑用 sendBeacon（存活于页面卸载）发出去；不可用则退化 keepalive fetch。
   * 仅在有待发事件时才发——正常离场（队列空）不白发包、不附面包屑。
   */
  flushBeacon(): void {
    const base = getApiBaseUrl();
    if (!base || this.queue.length === 0) return;
    const crumbs: AnomalyEvent[] = recentClientLogs(BREADCRUMB_N).map((e) => ({
      type: 'crash',
      ts: e.ts,
      msg: clip(`[crumb:${e.level}${e.tag ? ':' + e.tag : ''}] ${e.msg}`, MSG_MAX),
    }));
    const events = this.queue.splice(0, this.queue.length).concat(crumbs);
    this.sent += events.length;
    const body = JSON.stringify({ publicId: readPublicId() ?? undefined, platform: platformName(), events });
    const url = `${base}${ENDPOINT}`;
    try {
      const nav = globalThis.navigator as (Navigator & { sendBeacon?: Navigator['sendBeacon'] }) | undefined;
      if (nav?.sendBeacon) { nav.sendBeacon(url, new Blob([body], { type: 'application/json' })); return; }
    } catch { /* fall through */ }
    try { void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }); } catch { /* swallow */ }
  }
}

export const anomalyReporter = new AnomalyReporter();

/** 上报一条异常事件（MemoryMonitor / PerfMonitor / 看门狗 / 错误钩子统一入口）。 */
export function reportAnomaly(type: AnomalyType, msg: string, detail?: Record<string, unknown>): void {
  anomalyReporter.report(type, msg, detail);
}

// ── 崩溃哨兵（localStorage） ───────────────────────────────────────────────────────────────
const SENTINEL_KEY = 'nw_session_sentinel';
const HEARTBEAT_MS = 15_000;

interface Sentinel { startedAt: number; lastSeenAt: number; cleanExit?: boolean; lastError?: string; }

function lsGet(k: string): string | null { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } }
function lsSet(k: string, v: string): void { try { globalThis.localStorage?.setItem(k, v); } catch { /* ignore */ } }

let sentinel: Sentinel | null = null;

/**
 * 启动调一次：① 检测上次会话是否异常退出（崩溃）并补报；② 开本次会话哨兵 + 心跳。
 * markCleanExit() 在离场时调（见 installAnomalyWatchers）。
 */
export function initCrashSentinel(): void {
  const raw = lsGet(SENTINEL_KEY);
  if (raw) {
    try {
      const prev = JSON.parse(raw) as Sentinel;
      if (prev && typeof prev.startedAt === 'number' && !prev.cleanExit) {
        const aliveMs = Math.max(0, (prev.lastSeenAt ?? prev.startedAt) - prev.startedAt);
        reportAnomaly('crash', 'previous session ended without clean exit', {
          startedAt: prev.startedAt,
          lastSeenAt: prev.lastSeenAt,
          aliveMs,
          ...(prev.lastError ? { lastError: prev.lastError } : {}),
        });
        // 立即用 beacon 抢发，不等 1.5s 合批 fetch：崩溃常成串（重载后又崩），若本次会话也在 1.5s 内
        // 再崩，debounce 定时器永不触发 → 上次的 crash 补报永远发不出。beacon 当场离队、存活于即时再崩。
        anomalyReporter.flushBeacon();
        log.warn('detected abnormal previous-session exit', { aliveMs });
      }
    } catch { /* 损坏的哨兵：忽略 */ }
  }
  sentinel = { startedAt: Date.now(), lastSeenAt: Date.now() };
  lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
  setInterval(() => {
    if (!sentinel) return;
    sentinel.lastSeenAt = Date.now();
    const errs = recentClientLogs(40).filter((e) => e.level === 'error');
    if (errs.length) sentinel.lastError = clip(errs[errs.length - 1].msg, MSG_MAX);
    lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
  }, HEARTBEAT_MS);
}

/** 标记本次会话干净退出（离场时调；下次启动据此不报崩溃）。 */
function markCleanExit(): void {
  if (!sentinel) return;
  sentinel.cleanExit = true;
  sentinel.lastSeenAt = Date.now();
  lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
}

// ── 异常监听器装配（错误旁路 / 离场 beacon / WebGL 丢失 / 看门狗 / 微信 onError） ───────────────
export interface AnomalyWatchersOpts {
  /** 渲染画布（监听 webglcontextlost）。微信 / 无 addEventListener 环境自动跳过。 */
  canvas?: { addEventListener?: (type: string, cb: (e: unknown) => void) => void } | null;
}

/** 安装全部异常监听器（应用启动时调一次）。需在 setErrorSink 可用后调（log.installGlobalErrorHandlers 已装）。 */
export function installAnomalyWatchers(opts: AnomalyWatchersOpts = {}): void {
  const g = globalThis as typeof globalThis & { __nwAnomalyHooked?: boolean };
  if (g.__nwAnomalyHooked) return;
  g.__nwAnomalyHooked = true;

  // 1) 未捕获异常旁路 → jserror（向 log.ts 注册 sink；log.ts 不反向 import 本模块，故无环）。
  setErrorSink((kind, msg) => reportAnomaly('jserror', `[${kind}] ${msg}`));

  // 2) 离场：beacon 抢发待发队列；干净退出标记只在**真·卸载**（pagehide）打。
  //    ⚠ 关键区分：visibilitychange→hidden（切后台/切 App/弹键盘）**不算**退出——iOS 恰在转后台时
  //    最易因内存压力杀标签页。若 hidden 也标 cleanExit，则「后台被杀」会被下次启动误判成正常退出、
  //    永不补报 crash。故 hidden 只抢发队列、绝不标 cleanExit；只有 pagehide（页面确凿卸载）才标。
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('pagehide', () => { markCleanExit(); anomalyReporter.flushBeacon(); });
    g.addEventListener('visibilitychange', () => {
      if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') {
        anomalyReporter.flushBeacon(); // 抢发，但不标干净退出
      }
    });
  }

  // 3) WebGL 上下文丢失（黑屏类故障关键信号）。
  const canvas = opts.canvas;
  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('webglcontextlost', () => {
      reportAnomaly('webgl_lost', 'webgl context lost');
      log.error('webgl context lost');
    });
  }

  // 4) 主循环看门狗（ANR / 卡死）：独立于 ticker 的 wall-clock 定时器，主线程冻结时本回调被推迟，
  //    恢复后据「实际 - 预期」漂移反推冻结时长。后台标签页会被节流→ document.hidden 时不算卡死。
  installAnrWatchdog();

  // 5) 微信小游戏全局错误回调（无 window error 事件，单独接）。
  const wx = (globalThis as { wx?: { onError?: (cb: (e: { message?: string } | string) => void) => void } }).wx;
  wx?.onError?.((e) => reportAnomaly('jserror', `[wx onError] ${clip(String((e as { message?: string })?.message ?? e), MSG_MAX)}`));
}

function installAnrWatchdog(): void {
  const WATCH_MS = 1_000;
  const STALL_MS = 4_000; // 主线程冻结超过这么久才算一次卡死（避免 GC 抖动 / 后台节流误报）
  let expected = Date.now() + WATCH_MS;
  setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    const hidden = (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
    if (!hidden && drift > STALL_MS) {
      reportAnomaly('anr', `main thread stalled ~${Math.round(drift)}ms`, { stallMs: Math.round(drift) });
      log.warn(`main thread stalled ~${Math.round(drift)}ms`);
    }
    expected = now + WATCH_MS;
  }, WATCH_MS);
}
