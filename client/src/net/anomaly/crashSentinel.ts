// anomaly.ts's localStorage crash sentinel, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛") — module-scope state (`sentinel`), same shape as the file it was split
// from. Reads the live current storage via reporter.ts's getStorage() rather than capturing the
// module's `storage` binding directly, since setAnomalyStorage() can rewire it after this module
// has already loaded (app.ts injects platform storage during startup, before initCrashSentinel()
// but the ordering isn't a hard guarantee this module should bake in).
import { recentClientLogs } from '../log';
import { anomalyReporter, clip, getStorage, log, MSG_MAX, readBuildVersion, reportAnomaly } from './reporter';

const SENTINEL_KEY = 'nw_session_sentinel';
const HEARTBEAT_MS = 15_000;

interface Sentinel { startedAt: number; lastSeenAt: number; cleanExit?: boolean; lastError?: string; }

function lsGet(k: string): string | null { try { return getStorage().getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { getStorage().setItem(k, v); } catch { /* ignore */ } }

let sentinel: Sentinel | null = null;

/**
 * Call once on startup: ① detect whether the previous session ended abnormally (crash) and file a late report; ② start the current session sentinel + heartbeat.
 * markCleanExit() is called on exit (see watchers.ts's installAnomalyWatchers).
 */
export function initCrashSentinel(): void {
  const raw = lsGet(SENTINEL_KEY);
  if (raw) {
    try {
      const prev = JSON.parse(raw) as Sentinel;
      // Dev/unbaked builds (__NW_BUILD_VERSION__ === '0.0.0') never report crashes. The heartbeat only updates
      // every HEARTBEAT_MS (15s), so any session shorter than one beat records aliveMs:0 — and dev-time hot
      // reloads / quick refreshes trip exactly that path, flooding Loki with false "unclean exit" crashes that
      // carry no field signal. Prod builds bake a real commit hash and still report: an aliveMs:0 there is a
      // genuine hard death within 15s (a clean reload fires pagehide → markCleanExit and is never reported).
      // Mirrors the dev-build gating already used in web.ts (version check) and ota.ts (update check).
      if (prev && typeof prev.startedAt === 'number' && !prev.cleanExit && readBuildVersion() !== '0.0.0') {
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
export function markCleanExit(): void {
  if (!sentinel) return;
  sentinel.cleanExit = true;
  sentinel.lastSeenAt = Date.now();
  lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
}
