// anomaly.ts's watcher installation (error bypass / exit beacon / WebGL lost / ANR watchdog /
// WeChat onError), extracted as form① (claudedocs/client-modules.md "单文件 500 行收敛").
import { setErrorSink } from '../log';
import { anrContext, installLongTaskObserver, longTaskObserverActive } from './anrContext';
import { markCleanExit } from './crashSentinel';
import { anomalyReporter, clip, log, MSG_MAX, reportAnomaly } from './reporter';

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

  // 4b) Long Tasks observer (Chromium-only) — see anrContext.ts's installLongTaskObserver for why
  //     this is worth having alongside the watchdog: it can independently confirm/rule out "main
  //     thread was actually busy running JS" during a reported stall.
  installLongTaskObserver();

  // 5) WeChat mini-game global error callback (no window error event; must be wired separately).
  const wx = (globalThis as { wx?: { onError?: (cb: (e: { message?: string } | string) => void) => void } }).wx;
  wx?.onError?.((e) => reportAnomaly('jserror', `[wx onError] ${clip(String((e as { message?: string })?.message ?? e), MSG_MAX)}`));
}

function installAnrWatchdog(): void {
  const WATCH_MS = 1_000;
  const STALL_MS = 4_000; // minimum freeze duration to count as an ANR (avoids false positives from GC jitter / background throttling)
  const g = globalThis as typeof globalThis & {
    document?: { hidden?: boolean; addEventListener?: (type: string, cb: () => void) => void };
    addEventListener?: (type: string, cb: () => void) => void;
  };

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

  // Page Lifecycle 'freeze'/'resume' (Chromium): a *stronger* suspension signal than
  // visibilitychange — some OS/browser tab-freeze paths (bfcache-adjacent, background CPU
  // budget exhaustion) fire these without ever flipping `document.hidden`, which is the exact gap
  // flagged after the 2026-07-18 batch (long freezes with no longFrame/longConstruct/longRender and,
  // per the new long-task check above, potentially no observed long tasks either). Latched the same
  // way, and logged as crumbs so a freeze/resume pair right before a stall is visible even when it
  // doesn't end up suppressing the report.
  g.document?.addEventListener?.('freeze', () => {
    hiddenSinceLastTick = true;
    log.info('page lifecycle: freeze');
  });
  g.document?.addEventListener?.('resume', () => {
    log.info('page lifecycle: resume');
  });

  let expected = Date.now() + WATCH_MS;
  setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    const wasHidden = hiddenSinceLastTick || g.document?.hidden === true;
    if (!wasHidden && drift > STALL_MS) {
      const ctx = anrContext(expected - WATCH_MS);
      // Confirmed via a week of prod batches (FEATURE_FLAGS_DESIGN §9.7, 2026-07-20): once the Long
      // Tasks observer is active and reports zero tasks overlapping the drift window, all three
      // own-code timers (longFrame/longConstruct/longRender) are necessarily also empty — the main
      // thread simply wasn't running JS. That is genuine OS/browser thread suspension, not anything
      // this app can fix. With only a handful of testers today, reporting it anyway would bury real
      // signal in noise — so it's suppressed (kept local-only) instead of sent to the server.
      if (longTaskObserverActive && !('longTaskMs' in ctx)) {
        log.info(`anr suppressed: ~${Math.round(drift)}ms drift, no long tasks observed (thread suspension, not app code)`);
      } else {
        reportAnomaly('anr', `main thread stalled ~${Math.round(drift)}ms`, { stallMs: Math.round(drift), ...ctx });
        log.warn(`main thread stalled ~${Math.round(drift)}ms`);
      }
    }
    hiddenSinceLastTick = false;
    expected = now + WATCH_MS;
  }, WATCH_MS);
}
