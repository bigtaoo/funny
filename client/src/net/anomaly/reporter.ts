// anomaly.ts's core event reporter, extracted as form① (claudedocs/client-modules.md "单文件
// 500 行收敛") — all state here is module-scope singletons (AnomalyReporter/storage), same shape
// as the file it was split from; siblings (anrContext.ts/crashSentinel.ts/watchers.ts) import
// from here, never the reverse, so the split stays acyclic.
import { recentClientLogs, netLog } from '../log';
import { getApiBaseUrl } from '../config';
import { netTransport } from '../transport';
import type { IStorage } from '../../platform/IPlatform';
import { deviceClass, deviceMemoryGb, devicePixelRatio, momentContext, type MomentContext } from './deviceContext';

export const log = netLog('anomaly');

export type AnomalyType = 'mem' | 'cpu' | 'webgl_lost' | 'anr' | 'jserror' | 'crash';

/** A single anomaly event (same shape as ClientAnomalyEvent in metaserver/clientLog.ts on the server). */
interface AnomalyEvent {
  type: AnomalyType;
  ts: number; // epoch ms
  msg: string;
  detail?: string; // structured supplement serialized into a single string, truncated to prevent overflow
  // Moment-level device context (deviceContext.ts), captured when the event is reported rather than
  // when the batch is flushed — up to FLUSH_DEBOUNCE_MS separates the two, which is long enough to
  // matter for sinceRot on exactly the rotation-time failures these fields exist to find.
  orient?: MomentContext['orient'];
  vp?: MomentContext['vp'];
  sinceRot?: MomentContext['sinceRot'];
}

const ENDPOINT = '/client/anomaly';
const FLUSH_DEBOUNCE_MS = 1_500; // debounce delay after enqueue (batches bursts, reduces packet count)
const SESSION_CAP = 50;          // max events reported per session (safety cap against storm)
export const MSG_MAX = 300;
const DETAIL_MAX = 800;
export const BREADCRUMB_N = 12;  // number of recent log entries attached to crash / exit beacons

// Minimum interval (ms) before re-reporting each type. High-frequency sampled types (mem/cpu/anr) are coalesced to prevent flooding; webgl/crash are rare and only subject to the session cap.
const COOLDOWN_MS: Record<AnomalyType, number> = {
  mem: 60_000, cpu: 60_000, anr: 30_000, jserror: 10_000, webgl_lost: 0, crash: 0,
};

function platformName(): string {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  return t === 'wechat' || t === 'crazygames' ? t : 'web';
}

// Injected once from app.ts (platform.storage) so this module works on WeChat mini-game, which has
// no global `localStorage` — reading straight off `globalThis.localStorage` silently returns nothing
// there. Defaults to a `globalThis.localStorage` shim so existing tests (which stub the global) and
// any pre-injection calls keep working on web.
let storage: IStorage = {
  getItem: (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  setItem: (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch { /* ignore */ } },
  removeItem: (k) => { try { globalThis.localStorage?.removeItem(k); } catch { /* ignore */ } },
};

/** Wire in the real platform storage (call once from app.ts, alongside initCrashSentinel/installAnomalyWatchers). */
export function setAnomalyStorage(s: IStorage): void { storage = s; }

/** Current platform storage — read live by crashSentinel.ts's sentinel persistence (must see any
 *  post-startup setAnomalyStorage() call, not a snapshot taken at import time). */
export function getStorage(): IStorage { return storage; }

function readPublicId(): string | null {
  try { return storage.getItem('nw_player_public_id'); } catch { return null; }
}

/** Build version baked in at compile time (short commit hash; '0.0.0' if unbaked). Attributes a recurring anomaly to a specific deploy — e.g. to rule out a long-open tab still running pre-fix code. */
export function readBuildVersion(): string {
  return (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0';
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

function stringifyDetail(detail: Record<string, unknown>): string {
  let s: string;
  try { s = JSON.stringify(detail); } catch { s = String(detail); }
  return clip(s, DETAIL_MAX);
}

/**
 * The upload envelope: who is reporting, on what hardware, running which build. Session-stable, so
 * it rides on the batch rather than on every event; clientLog.ts stamps it onto each Loki line.
 *
 * `device`/`dpr`/`mem` were added 2026-08-24 — see deviceContext.ts for why `platform` alone (a build
 * target, not a device) left mobile-only failures unfilterable.
 */
function envelope(events: AnomalyEvent[]): string {
  return JSON.stringify({
    publicId: readPublicId() ?? undefined,
    platform: platformName(),
    buildVersion: readBuildVersion(),
    device: deviceClass(),
    dpr: devicePixelRatio(),
    mem: deviceMemoryGb(),
    events,
  });
}

class AnomalyReporter {
  private queue: AnomalyEvent[] = [];
  private sent = 0;
  private lastByType: Partial<Record<AnomalyType, number>> = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Report a single anomaly event (with cooldown + session cap + detail truncation). Safe in any
   * environment; enqueues for exit beacon when baseUrl is unavailable.
   *
   * `ctx` overrides the live device context, and exists for exactly one caller: the crash sentinel,
   * which reports on the **previous** session during the next startup. Snapshotting the current
   * orientation/viewport there would describe the session that survived, not the one that died —
   * and would quietly invent a "the crash happened in portrait" claim out of the reader's own
   * post-crash screen position. The sentinel passes the dead session's persisted values instead.
   */
  report(type: AnomalyType, msg: string, detail?: Record<string, unknown>, ctx?: MomentContext): void {
    const now = Date.now();
    if (now - (this.lastByType[type] ?? -Infinity) < COOLDOWN_MS[type]) return; // within cooldown: discard
    if (this.sent + this.queue.length >= SESSION_CAP) return;                    // session cap reached
    this.lastByType[type] = now;
    const ev: AnomalyEvent = { type, ts: now, msg: clip(msg, MSG_MAX), ...(ctx ?? momentContext()) };
    if (detail) ev.detail = stringifyDetail(detail);
    this.queue.push(ev);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, FLUSH_DEBOUNCE_MS);
  }

  /** Regular report (fire-and-forget; keepalive allows late deliveries to complete). Failures are silent and not re-queued (prevents unbounded offline accumulation). */
  private async flush(): Promise<void> {
    const base = getApiBaseUrl();
    if (!base || this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    this.sent += events.length;
    try {
      await netTransport().request({
        method: 'POST',
        url: `${base}${ENDPOINT}`,
        headers: { 'content-type': 'application/json' },
        body: envelope(events),
        keepalive: true,
        credentials: 'omit', // telemetry is unauthenticated (publicId in body); no cookies → cross-origin CORS needs no ACAC
      });
    } catch { /* best-effort, silently swallow */ }
  }

  /**
   * Eager exit flush: sends the pending queue + recent breadcrumbs via an uncredentialed keepalive request (survives page unload).
   * Only sends when there are pending events — a clean exit (empty queue) sends nothing and attaches no breadcrumbs.
   *
   * NOTE — why a keepalive request and NOT navigator.sendBeacon: sendBeacon always sends the request credentialed (cookies),
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
    const body = envelope(events);
    const url = `${base}${ENDPOINT}`;
    try {
      void netTransport()
        .request({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'omit' })
        .catch(() => { /* swallow */ });
    } catch { /* swallow */ }
  }
}

export const anomalyReporter = new AnomalyReporter();

/** Report a single anomaly event (unified entry point for MemoryMonitor / PerfMonitor / watchdog / error hooks). */
export function reportAnomaly(type: AnomalyType, msg: string, detail?: Record<string, unknown>, ctx?: MomentContext): void {
  anomalyReporter.report(type, msg, detail, ctx);
}
