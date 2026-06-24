// 客户端联机日志（S1 联调）。把网络层的连接 / 收发 / 异常打到 console，
// 玩家可在浏览器 DevTools 看到完整链路（之前 NetClient 静默吞掉所有错误，匹配卡住时无从排查）。
//
// 形如：`[net:gateway] state connecting`。tag 区分子系统（gateway / game / api / app）。
// 默认全开；若太吵，可 localStorage.setItem('nw_net_log', 'off') 关闭。

import { uncaughtErrorMessage } from './apiErrorMessage';

export interface NetLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// ── 客户端日志环形缓冲（客户端日志定向采集，FEATURE_FLAGS_DESIGN §9.4）─────────────────────
// 始终在内存里保留最近 N 条日志（不上报时几乎零成本）。被运营定向后，FeatureFlags 模块从这里捞
// ≥阈值的条目批量 POST /client/log。环形缓冲让「命中前的上下文」也能一并上报，便于复现卡死现场。

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 一条缓冲日志（与服务端 metaserver/clientLog.ts 的 ClientLogEntry 同形）。 */
export interface ClientLogEntry {
  level: ClientLogLevel;
  msg: string;
  ts: number; // epoch ms
  tag?: string;
  /** 单调序号（缓冲内唯一递增），上报方据此只取「上次之后的新条目」，避免重复上报。 */
  seq: number;
}

/** verbose 程度排名：debug 最高（含最多），error 最低。阈值比较用。 */
export const LOG_LEVEL_RANK: Record<ClientLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const RING_CAPACITY = 200;
const ring: ClientLogEntry[] = [];
let seqCounter = 0;

/** 把 data 浓缩进一行 msg（上报无 console 的结构化能力，全部塞 msg 字符串，截断防爆）。 */
function appendData(msg: string, data?: unknown): string {
  if (data === undefined) return msg;
  let s: string;
  try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return `${msg} ${s}`;
}

/** 记一条到环形缓冲（netLog / 全局异常钩子内部调用；外部一般不直接用）。 */
export function recordClientLog(level: ClientLogLevel, tag: string, msg: string, data?: unknown): void {
  const entry: ClientLogEntry = { level, msg: appendData(msg, data), ts: Date.now(), seq: ++seqCounter };
  if (tag) entry.tag = tag;
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
}

/**
 * 取缓冲里「level ≤ 阈值 verbose 度」且 seq > afterSeq 的条目（上报用）。
 * 返回新条目 + 缓冲当前最大 seq（调用方存为下次 afterSeq）。无新条目时 lastSeq = afterSeq。
 */
export function snapshotClientLogs(thresholdRank: number, afterSeq: number): { entries: ClientLogEntry[]; lastSeq: number } {
  const entries = ring.filter((e) => e.seq > afterSeq && LOG_LEVEL_RANK[e.level] <= thresholdRank);
  const lastSeq = ring.length > 0 ? ring[ring.length - 1].seq : afterSeq;
  return { entries, lastSeq };
}

function enabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('nw_net_log') !== 'off';
  } catch {
    return true;
  }
}

export function netLog(tag: string): NetLogger {
  const prefix = `[net:${tag}]`;
  const emit = (
    level: ClientLogLevel,
    fn: (...a: unknown[]) => void,
    msg: string,
    data?: unknown,
  ): void => {
    // 环形缓冲始终记录（与 console 开关无关——定向采集要的就是「console 关着也能捞」的离线日志）。
    recordClientLog(level, tag, msg, data);
    if (!enabled()) return;
    if (data === undefined) fn(prefix, msg);
    else fn(prefix, msg, data);
  };
  return {
    debug: (m, d) => emit('debug', console.debug.bind(console), m, d),
    info: (m, d) => emit('info', console.info.bind(console), m, d),
    warn: (m, d) => emit('warn', console.warn.bind(console), m, d),
    error: (m, d) => emit('error', console.error.bind(console), m, d),
  };
}

/**
 * 玩家可见提示的渲染出口（app.ts 注入 GlobalToast.show）。这里只持有「怎么把一句话显示出来」，
 * 不关心文案从哪来——分类（reason→文案）在本模块，定点提示（已本地化的整句）由调用方给。
 * 抽到此处是因为 log.ts 不依赖 PIXI，能被 SaveManager / createAppCore 等无渲染模块安全 import。
 */
let toastSink: ((text: string) => void) | null = null;

/** 注册玩家提示渲染出口（应用启动时调一次）。 */
export function setToastSink(fn: (text: string) => void): void {
  toastSink = fn;
}

/** 弹一句已本地化的玩家提示（供 SaveManager 云同步失败等定点兜底用）。未注册 sink 时静默。 */
export function showToastMessage(text: string): void {
  if (!toastSink) return;
  // sink 本身不能再抛——否则可能触发又一次 unhandledrejection 形成回环。
  try { toastSink(text); } catch { /* swallow */ }
}

/**
 * 安装全局未捕获异常 / Promise 拒绝处理器（应用启动时调一次）。
 * 之前未捕获错误只在 console 默认输出、且 unhandledrejection 常被忽略——这里统一加显眼前缀，
 * 确保「客户端输出所有的异常和错误」，并把漏网的 API / 网络错误归类后弹全局兜底 toast 提示玩家
 * （仅当错误一路冒泡到 window，即场景没有自己 catch + 提示时才会走到，故是「漏网才兜底」）。
 */
export function installGlobalErrorHandlers(): void {
  const g = globalThis as typeof globalThis & { __nwErrHooked?: boolean };
  if (g.__nwErrHooked) return;
  g.__nwErrHooked = true;
  if (typeof g.addEventListener !== 'function') return;
  g.addEventListener('error', (ev: ErrorEvent) => {
    const detail = { source: ev.filename, line: ev.lineno, col: ev.colno, error: ev.error };
    console.error('[uncaught error]', ev.message, detail);
    // 入环形缓冲（定向采集）：未捕获错误是排障最关键的线索，务必能被远程捞到。
    recordClientLog('error', 'uncaught', `[uncaught error] ${ev.message}`, { source: ev.filename, line: ev.lineno, col: ev.colno });
    const msg = uncaughtErrorMessage(ev.error ?? ev.message);
    if (msg) showToastMessage(msg);
  });
  g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    console.error('[unhandled rejection]', ev.reason);
    recordClientLog('error', 'unhandled', `[unhandled rejection] ${String((ev.reason as { message?: string })?.message ?? ev.reason)}`);
    const msg = uncaughtErrorMessage(ev.reason);
    if (msg) showToastMessage(msg);
  });
}
