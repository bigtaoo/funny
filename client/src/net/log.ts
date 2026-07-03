// Client online logging (S1 integration debugging). Logs network-layer connections / sends-receives / errors to the console
// so players can see the full request chain in the browser DevTools (previously NetClient silently swallowed all errors,
// making it impossible to diagnose stuck matchmaking).
//
// Format: `[net:gateway] state connecting`. The tag identifies the subsystem (gateway / game / api / app).
// Enabled by default; to silence it, call localStorage.setItem('nw_net_log', 'off').

import { uncaughtErrorMessage } from './apiErrorMessage';

export interface NetLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

// ── Client log ring buffer (targeted client log collection, FEATURE_FLAGS_DESIGN §9.4) ─────────────────────
// Always keeps the most recent N log entries in memory (near-zero cost when not reporting).
// Once targeted by an operator, the FeatureFlags module pulls entries at or above the threshold and batch-POSTs them to /client/log.
// The ring buffer allows pre-targeting context to be included in the report, making it easier to reproduce freeze scenes.

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A single buffered log entry (same shape as ClientLogEntry in metaserver/clientLog.ts on the server). */
export interface ClientLogEntry {
  level: ClientLogLevel;
  msg: string;
  ts: number; // epoch ms
  tag?: string;
  /** Monotonically increasing sequence number (unique within the buffer); the reporter uses this to fetch only entries newer than the last reported seq, avoiding duplicate uploads. */
  seq: number;
}

/** Verbosity rank: debug is highest (most verbose), error is lowest. Used for threshold comparisons. */
export const LOG_LEVEL_RANK: Record<ClientLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const RING_CAPACITY = 200;
const ring: ClientLogEntry[] = [];
let seqCounter = 0;

/** Condense data into a single-line msg (reports lack console's structured output capability; everything is packed into the msg string and truncated to prevent overflow). */
function appendData(msg: string, data?: unknown): string {
  if (data === undefined) return msg;
  let s: string;
  try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return `${msg} ${s}`;
}

/** Write one entry to the ring buffer (called internally by netLog / global error hooks; external callers generally do not use this directly). */
export function recordClientLog(level: ClientLogLevel, tag: string, msg: string, data?: unknown): void {
  const entry: ClientLogEntry = { level, msg: appendData(msg, data), ts: Date.now(), seq: ++seqCounter };
  if (tag) entry.tag = tag;
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
}

/**
 * Retrieve entries from the buffer where level verbosity rank <= thresholdRank and seq > afterSeq (for reporting).
 * Returns new entries + the buffer's current maximum seq (caller stores this as the next afterSeq). When there are no new entries, lastSeq = afterSeq.
 */
export function snapshotClientLogs(thresholdRank: number, afterSeq: number): { entries: ClientLogEntry[]; lastSeq: number } {
  const entries = ring.filter((e) => e.seq > afterSeq && LOG_LEVEL_RANK[e.level] <= thresholdRank);
  const lastSeq = ring.length > 0 ? ring[ring.length - 1].seq : afterSeq;
  return { entries, lastSeq };
}

/** Retrieve the last n entries from the buffer tail (used to attach scene breadcrumbs to crash / exit beacons, and for the crash sentinel to record the last error; not filtered by level). */
export function recentClientLogs(n: number): ClientLogEntry[] {
  return n <= 0 ? [] : ring.slice(-n);
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
    // Always record to the ring buffer (independent of the console toggle — targeted collection specifically needs offline logs that can be retrieved even when the console is off).
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
 * Render outlet for player-visible toast messages (injected by app.ts via GlobalToast.show). This module only holds
 * "how to display a message" — it does not care where the text comes from. Classification (reason → text) lives here;
 * targeted toasts (fully localized strings) are provided by the caller.
 * Extracted here because log.ts has no PIXI dependency and can be safely imported by non-rendering modules such as SaveManager / createAppCore.
 */
/** Toast intent → the render outlet maps this to a colour (error = red bar, success = green bar). */
export type ToastKind = 'error' | 'success';

let toastSink: ((text: string, kind: ToastKind) => void) | null = null;

/** Register the player toast render outlet (call once on application startup). */
export function setToastSink(fn: (text: string, kind: ToastKind) => void): void {
  toastSink = fn;
}

/** Show a localized player toast (used as a targeted fallback for events such as SaveManager cloud sync failure). Silently no-ops if no sink is registered. */
export function showToastMessage(text: string, kind: ToastKind = 'error'): void {
  if (!toastSink) return;
  // The sink must not throw — otherwise it could trigger another unhandledrejection and form a cycle.
  try { toastSink(text, kind); } catch { /* swallow */ }
}

/**
 * Bypass outlet for uncaught exceptions (injected by net/anomaly): feeds window-level uncaught errors / Promise rejections into the full-coverage anomaly reporter.
 * Injected via setter rather than direct import to prevent log.ts from reverse-depending on anomaly (anomaly depends on log; avoids a cycle).
 */
let errorSink: ((kind: 'uncaught' | 'unhandled', msg: string) => void) | null = null;

/** Register the uncaught exception bypass outlet (call once on application startup). */
export function setErrorSink(fn: (kind: 'uncaught' | 'unhandled', msg: string) => void): void {
  errorSink = fn;
}

/**
 * Install global uncaught exception / Promise rejection handlers (call once on application startup).
 * Previously, uncaught errors only appeared in the console's default output and unhandledrejection was often ignored —
 * this adds a prominent prefix to all of them, ensuring "all client exceptions and errors are visible",
 * and classifies any API / network errors that slip through to show a global fallback toast to the player
 * (only reached when an error bubbles all the way to window, i.e., the scene did not catch + display it itself — hence "last-resort fallback").
 */
export function installGlobalErrorHandlers(): void {
  const g = globalThis as typeof globalThis & { __nwErrHooked?: boolean };
  if (g.__nwErrHooked) return;
  g.__nwErrHooked = true;
  if (typeof g.addEventListener !== 'function') return;
  g.addEventListener('error', (ev: ErrorEvent) => {
    const detail = { source: ev.filename, line: ev.lineno, col: ev.colno, error: ev.error };
    console.error('[uncaught error]', ev.message, detail);
    // Record to ring buffer (targeted collection): uncaught errors are the most critical diagnostic signal and must be remotely retrievable.
    recordClientLog('error', 'uncaught', `[uncaught error] ${ev.message}`, { source: ev.filename, line: ev.lineno, col: ev.colno });
    errorSink?.('uncaught', `${ev.message} @ ${ev.filename}:${ev.lineno}`);
    const msg = uncaughtErrorMessage(ev.error ?? ev.message);
    if (msg) showToastMessage(msg);
  });
  g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    console.error('[unhandled rejection]', ev.reason);
    const reason = String((ev.reason as { message?: string })?.message ?? ev.reason);
    recordClientLog('error', 'unhandled', `[unhandled rejection] ${reason}`);
    errorSink?.('unhandled', reason);
    const msg = uncaughtErrorMessage(ev.reason);
    if (msg) showToastMessage(msg);
  });
}
