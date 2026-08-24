// anomaly.ts's localStorage crash sentinel, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛") — module-scope state (`sentinel`), same shape as the file it was split
// from. Reads the live current storage via reporter.ts's getStorage() rather than capturing the
// module's `storage` binding directly, since setAnomalyStorage() can rewire it after this module
// has already loaded (app.ts injects platform storage during startup, before initCrashSentinel()
// but the ordering isn't a hard guarantee this module should bake in).
import { recentClientLogs } from '../log';
import { installRotationWatch, lastRotationAt, momentContext, type MomentContext } from './deviceContext';
import { anomalyReporter, clip, getStorage, log, MSG_MAX, readBuildVersion, reportAnomaly } from './reporter';

const SENTINEL_KEY = 'nw_session_sentinel';
const HEARTBEAT_MS = 15_000;

interface Sentinel {
  startedAt: number;
  lastSeenAt: number;
  cleanExit?: boolean;
  lastError?: string;
  // Device context as of the last write, so a crash report can describe the session that DIED
  // rather than the one reading the sentinel afterwards (see reporter.report's `ctx` parameter).
  orient?: MomentContext['orient'];
  vp?: MomentContext['vp'];
  /** Epoch ms of this session's last orientation flip; absent if it never rotated. */
  lastRotAt?: number;
}

function lsGet(k: string): string | null { try { return getStorage().getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { getStorage().setItem(k, v); } catch { /* ignore */ } }

let sentinel: Sentinel | null = null;

/** Refresh the liveness stamp + device context and persist. Called on the heartbeat and, crucially,
 *  the instant the screen rotates — see the rotation-watch wiring in initCrashSentinel. */
function touchSentinel(): void {
  if (!sentinel) return;
  sentinel.lastSeenAt = Date.now();
  const ctx = momentContext();
  sentinel.orient = ctx.orient;
  sentinel.vp = ctx.vp;
  sentinel.lastRotAt = lastRotationAt();
  lsSet(SENTINEL_KEY, JSON.stringify(sentinel));
}

/**
 * Reconstruct the dead session's moment-context from its sentinel.
 *
 * `sinceRot` here means "how long after its last rotation was that session still known to be
 * alive" — a lower bound on survival-after-rotation, since lastSeenAt is only as fresh as the last
 * heartbeat or rotation write. A crash carrying sinceRot≈0 is therefore the signature we are
 * hunting: the last thing we ever heard from that session was it rotating.
 */
function deadSessionContext(prev: Sentinel): MomentContext {
  const ctx: MomentContext = {};
  if (prev.orient) ctx.orient = prev.orient;
  if (prev.vp) ctx.vp = prev.vp;
  if (typeof prev.lastRotAt === 'number') {
    ctx.sinceRot = Math.max(0, (prev.lastSeenAt ?? prev.startedAt) - prev.lastRotAt);
  }
  return ctx;
}

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
        }, deadSessionContext(prev));
        // Immediately flush via beacon rather than waiting 1.5s for the batched fetch: crashes often cascade
        // (crash again after reload), and if this session also crashes within 1.5s the debounce timer never fires
        // → the previous crash late-report is never sent. Beacon dequeues immediately and survives an instant re-crash.
        anomalyReporter.flushBeacon();
        log.warn('detected abnormal previous-session exit', { aliveMs });
      }
    } catch { /* corrupted sentinel: ignore */ }
  }
  sentinel = { startedAt: Date.now(), lastSeenAt: Date.now() };
  touchSentinel();

  // Persist on every orientation flip, not just on the 15s heartbeat. Two things depend on this:
  //   ① the flip itself survives a kill that follows it — otherwise a rotate-then-die reports as a
  //      bare aliveMs:0 with no rotation on record, which is precisely the case we cannot currently see;
  //   ② it sharpens aliveMs. A session that rotates at t+3s and dies at t+4s used to be indistinguishable
  //      from one that died at t+0.1s (both "aliveMs:0", the first heartbeat never having landed).
  installRotationWatch(touchSentinel);

  setInterval(() => {
    if (!sentinel) return;
    const errs = recentClientLogs(40).filter((e) => e.level === 'error');
    if (errs.length) sentinel.lastError = clip(errs[errs.length - 1].msg, MSG_MAX);
    touchSentinel();
  }, HEARTBEAT_MS);
}

/** Mark the current session as a clean exit (called on page exit; prevents a crash report on the next startup). */
export function markCleanExit(): void {
  if (!sentinel) return;
  sentinel.cleanExit = true;
  touchSentinel();
}
