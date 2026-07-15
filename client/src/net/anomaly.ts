// Full-coverage client anomaly reporting channel (complementary to FEATURE_FLAGS_DESIGN §9 "targeted client log collection").
//
// Targeted collection only retrieves logs for publicIds on the allowlist; this channel is the opposite —
// **any** client that encounters the following anomalies reports directly to metaserver → Loki,
// enabling field anomaly detection across all users (no prior allowlisting required):
//   mem        JS heap exceeded threshold (fed in via MemoryMonitor bypass)
//   cpu        main thread sustained saturation / persistent low FPS (PerfMonitor)
//   webgl_lost WebGL context lost (critical signal for black-screen class failures)
//   anr        main loop frozen / long stall (watchdog)
//   jserror    uncaught exception / Promise rejection (log.ts errorSink bypass)
//   crash      previous session ended abnormally (crash sentinel reports on next startup)
//
// Four anti-abuse gates: ① per-type cooldown (high-frequency signals coalesced every 60s) ② per-session total cap ③ per-entry detail truncation
// ④ server-side per-IP rate limiting (service.ts). No baseUrl / Loki unreachable → silently dropped, never impacts the player.
//
// Two crash capture paths:
//   ① On page exit (pagehide / visibilitychange→hidden), use an uncredentialed keepalive fetch (survives page unload) to eagerly
//      flush the queue + recent breadcrumbs, catching "soft crash / frozen-then-closed / error-then-refresh" type crashes that
//      **have a cleanup opportunity**. (Deliberately NOT navigator.sendBeacon — see flushBeacon for the CORS rationale.)
//   ② True hard crashes (OOM / renderer process killed / tab killed) have no reporting opportunity at the moment —
//      instead use a localStorage "session sentinel": write a marker on startup + update a heartbeat timestamp,
//      mark cleanExit on exit; on the next startup, if the previous sentinel has a marker but no cleanExit,
//      the previous session is judged to have crashed, and a crash event is reported with the approximate crash time + last error.

import { recentClientLogs, netLog, setErrorSink } from './log';
import { getApiBaseUrl } from './config';

const log = netLog('anomaly');

export type AnomalyType = 'mem' | 'cpu' | 'webgl_lost' | 'anr' | 'jserror' | 'crash';

/** A single anomaly event (same shape as ClientAnomalyEvent in metaserver/clientLog.ts on the server). */
interface AnomalyEvent {
  type: AnomalyType;
  ts: number; // epoch ms
  msg: string;
  detail?: string; // structured supplement serialized into a single string, truncated to prevent overflow
}

const ENDPOINT = '/client/anomaly';
const FLUSH_DEBOUNCE_MS = 1_500; // debounce delay after enqueue (batches bursts, reduces packet count)
const SESSION_CAP = 50;          // max events reported per session (safety cap against storm)
const MSG_MAX = 300;
const DETAIL_MAX = 800;
const BREADCRUMB_N = 12;          // number of recent log entries attached to crash / exit beacons

// Minimum interval (ms) before re-reporting each type. High-frequency sampled types (mem/cpu/anr) are coalesced to prevent flooding; webgl/crash are rare and only subject to the session cap.
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

/** Build version baked in at compile time (short commit hash; '0.0.0' if unbaked). Attributes a recurring anomaly to a specific deploy — e.g. to rule out a long-open tab still running pre-fix code. */
function readBuildVersion(): string {
  return (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0';
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

  /** Report a single anomaly event (with cooldown + session cap + detail truncation). Safe in any environment; enqueues for exit beacon when baseUrl is unavailable. */
  report(type: AnomalyType, msg: string, detail?: Record<string, unknown>): void {
    const now = Date.now();
    if (now - (this.lastByType[type] ?? -Infinity) < COOLDOWN_MS[type]) return; // within cooldown: discard
    if (this.sent + this.queue.length >= SESSION_CAP) return;                    // session cap reached
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

  /** Regular fetch report (fire-and-forget; keepalive allows late deliveries to complete). Failures are silent and not re-queued (prevents unbounded offline accumulation). */
  private async flush(): Promise<void> {
    const base = getApiBaseUrl();
    if (!base || this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    this.sent += events.length;
    try {
      await fetch(`${base}${ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicId: readPublicId() ?? undefined, platform: platformName(), buildVersion: readBuildVersion(), events }),
        keepalive: true,
        credentials: 'omit', // telemetry is unauthenticated (publicId in body); no cookies → cross-origin CORS needs no ACAC
      });
    } catch { /* best-effort, silently swallow */ }
  }

  /**
   * Eager exit flush: sends the pending queue + recent breadcrumbs via an uncredentialed keepalive fetch (survives page unload).
   * Only sends when there are pending events — a clean exit (empty queue) sends nothing and attaches no breadcrumbs.
   *
   * NOTE — why keepalive fetch and NOT navigator.sendBeacon: sendBeacon always sends the request credentialed (cookies),
   * which makes the browser require `Access-Control-Allow-Credentials: true` on the cross-origin response. This API
   * authenticates via Bearer token, sets no cookies, and its CORS reflects the origin without that header — so a
   * credentialed beacon is blocked outright and the crash/exit report never lands (observed as a CORS error against
   * /client/anomaly). A keepalive fetch is the spec-sanctioned unload-surviving alternative and defaults to no cookies
   * cross-origin; we pin credentials:'omit' to make that intent explicit. Telemetry is unauthenticated (publicId in body).
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
    const body = JSON.stringify({ publicId: readPublicId() ?? undefined, platform: platformName(), buildVersion: readBuildVersion(), events });
    const url = `${base}${ENDPOINT}`;
    try { void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'omit' }); } catch { /* swallow */ }
  }
}

export const anomalyReporter = new AnomalyReporter();

/** Report a single anomaly event (unified entry point for MemoryMonitor / PerfMonitor / watchdog / error hooks). */
export function reportAnomaly(type: AnomalyType, msg: string, detail?: Record<string, unknown>): void {
  anomalyReporter.report(type, msg, detail);
}

// ── Crash sentinel (localStorage) ───────────────────────────────────────────────────────────────
const SENTINEL_KEY = 'nw_session_sentinel';
const HEARTBEAT_MS = 15_000;

interface Sentinel { startedAt: number; lastSeenAt: number; cleanExit?: boolean; lastError?: string; }

function lsGet(k: string): string | null { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } }
function lsSet(k: string, v: string): void { try { globalThis.localStorage?.setItem(k, v); } catch { /* ignore */ } }

let sentinel: Sentinel | null = null;

/**
 * Call once on startup: ① detect whether the previous session ended abnormally (crash) and file a late report; ② start the current session sentinel + heartbeat.
 * markCleanExit() is called on exit (see installAnomalyWatchers).
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
        // Immediately flush via beacon rather than waiting 1.5s for the batched fetch: crashes often cascade
        // (crash again after reload), and if this session also crashes within 1.5s the debounce timer never fires
        // → the previous crash late-report is never sent. Beacon dequeues immediately and survives an instant re-crash.
        anomalyReporter.flushBeacon();
        log.warn('detected abnormal previous-session exit', { aliveMs });
      }
    } catch { /* corrupted sentinel: ignore */ }
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

/** Mark the current session as a clean exit (called on page exit; prevents a crash report on the next startup). */
function markCleanExit(): void {
  if (!sentinel) return;
  sentinel.cleanExit = true;
  sentinel.lastSeenAt = Date.now();
  lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
}

// ── Anomaly watcher installation (error bypass / exit beacon / WebGL lost / watchdog / WeChat onError) ───────────────
export interface AnomalyWatchersOpts {
  /** Rendering canvas (listens for webglcontextlost). Automatically skipped in WeChat / environments without addEventListener. */
  canvas?: { addEventListener?: (type: string, cb: (e: unknown) => void) => void } | null;
}

/** Install all anomaly watchers (call once on application startup). Must be called after setErrorSink is available (log.installGlobalErrorHandlers already installed). */
export function installAnomalyWatchers(opts: AnomalyWatchersOpts = {}): void {
  const g = globalThis as typeof globalThis & { __nwAnomalyHooked?: boolean };
  if (g.__nwAnomalyHooked) return;
  g.__nwAnomalyHooked = true;

  // 1) Uncaught exception bypass → jserror (registers a sink with log.ts; log.ts does not reverse-import this module, so no cycle).
  setErrorSink((kind, msg) => reportAnomaly('jserror', `[${kind}] ${msg}`));

  // 2) On exit: beacon eagerly flushes the pending queue; the clean-exit mark is only set on a **true unload** (pagehide).
  //    ⚠ Critical distinction: visibilitychange→hidden (switching to background / switching app / keyboard popup) does **not** count as an exit —
  //    iOS is most likely to kill the tab due to memory pressure precisely when going to the background.
  //    If hidden also set cleanExit, a "killed in background" would be misread as a normal exit on the next startup and never reported as a crash.
  //    So hidden only eagerly flushes the queue and never sets cleanExit; only pagehide (definitive page unload) sets it.
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('pagehide', () => { markCleanExit(); anomalyReporter.flushBeacon(); });
    g.addEventListener('visibilitychange', () => {
      if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') {
        anomalyReporter.flushBeacon(); // eagerly flush, but do not mark clean exit
      }
    });
  }

  // 3) WebGL context lost (critical signal for black-screen class failures).
  const canvas = opts.canvas;
  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('webglcontextlost', () => {
      reportAnomaly('webgl_lost', 'webgl context lost');
      log.error('webgl context lost');
    });
  }

  // 4) Main loop watchdog (ANR / freeze): a wall-clock timer independent of the ticker. When the main thread freezes,
  //    this callback is delayed; on recovery the freeze duration is inferred from the "actual - expected" drift.
  //    Background tabs are throttled → not counted as frozen when document.hidden.
  installAnrWatchdog();

  // 5) WeChat mini-game global error callback (no window error event; must be wired separately).
  const wx = (globalThis as { wx?: { onError?: (cb: (e: { message?: string } | string) => void) => void } }).wx;
  wx?.onError?.((e) => reportAnomaly('jserror', `[wx onError] ${clip(String((e as { message?: string })?.message ?? e), MSG_MAX)}`));
}

function installAnrWatchdog(): void {
  const WATCH_MS = 1_000;
  const STALL_MS = 4_000; // minimum freeze duration to count as an ANR (avoids false positives from GC jitter / background throttling)
  const g = globalThis as typeof globalThis & { document?: { hidden?: boolean }; addEventListener?: (type: string, cb: () => void) => void };

  // Latched (not sampled) hidden flag: a backgrounded tab has its timers throttled/suspended by the
  // OS/browser, so a long "stall" is often just the tab being backgrounded the whole time — but by the
  // time this interval's callback finally runs after the tab returns to foreground, `document.hidden`
  // has ALREADY flipped back to false (visibilitychange fires before suspended timers resume), so a
  // one-shot `document.hidden` check at fire time misses it and reports a false ANR. Latch it instead:
  // remember if the page was hidden at ANY point since the last tick, not just at this instant.
  let hiddenSinceLastTick = g.document?.hidden === true;
  g.addEventListener?.('visibilitychange', () => {
    if (g.document?.hidden) hiddenSinceLastTick = true;
  });

  let expected = Date.now() + WATCH_MS;
  setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    const wasHidden = hiddenSinceLastTick || g.document?.hidden === true;
    if (!wasHidden && drift > STALL_MS) {
      reportAnomaly('anr', `main thread stalled ~${Math.round(drift)}ms`, { stallMs: Math.round(drift) });
      log.warn(`main thread stalled ~${Math.round(drift)}ms`);
    }
    hiddenSinceLastTick = false;
    expected = now + WATCH_MS;
  }, WATCH_MS);
}
