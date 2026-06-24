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
    fn: (...a: unknown[]) => void,
    msg: string,
    data?: unknown,
  ): void => {
    if (!enabled()) return;
    if (data === undefined) fn(prefix, msg);
    else fn(prefix, msg, data);
  };
  return {
    debug: (m, d) => emit(console.debug.bind(console), m, d),
    info: (m, d) => emit(console.info.bind(console), m, d),
    warn: (m, d) => emit(console.warn.bind(console), m, d),
    error: (m, d) => emit(console.error.bind(console), m, d),
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
    console.error('[uncaught error]', ev.message, {
      source: ev.filename,
      line: ev.lineno,
      col: ev.colno,
      error: ev.error,
    });
    const msg = uncaughtErrorMessage(ev.error ?? ev.message);
    if (msg) showToastMessage(msg);
  });
  g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    console.error('[unhandled rejection]', ev.reason);
    const msg = uncaughtErrorMessage(ev.reason);
    if (msg) showToastMessage(msg);
  });
}
