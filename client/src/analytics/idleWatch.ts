/**
 * `churn_signal{reason:'idle_10min'}` — the player is still on the screen and has stopped touching it.
 *
 * Promised by ANALYTICS_DESIGN §5.6 from the start and deferred twice (§12.2, §12.6) for one honest
 * reason: the analytics layer cannot see input. It has no InputManager, and it must not acquire one —
 * `analytics/index.ts` is imported by `app/createAppCore.ts`, which is deliberately render-free so the
 * headless E2E harness can drive it, and every route from input to a timestamp
 * (`InputManager` → `render/renderPolicy`) drags PIXI into that graph.
 *
 * So the probe is injected instead: `app.ts` (which already owns both) passes
 * `msSinceActivity` from `render/renderPolicy.ts`, where every platform adapter's pointer path
 * already funnels through `holdRenderActive()`. Nothing new is measured, nothing new is hooked — the
 * number was already there for the frame-rate throttle.
 *
 * Distinct from the `background` / `explicit_exit` signals in `analytics/index.ts`: those fire when
 * the app is hidden and are followed by `endSession()`. This one fires while the app is **visible**
 * and ends nothing — the player may well come back, and a session that ends here would take its own
 * duration with it.
 */
import { track, currentScene } from './index';
import { onAppLifecycleChange } from '../platform/appLifecycle';

/** How long without input counts as idle. Named by the event value itself (`idle_10min`). */
export const IDLE_MS = 10 * 60 * 1000;
/** Poll period. Coarse on purpose: this decides a 10-minute threshold, not a frame. */
export const CHECK_MS = 60 * 1000;

export interface IdleProbe {
  /** ms since the last real pointer input (render/renderPolicy.ts `msSinceActivity`). */
  msSinceActivity: () => number;
}

interface IdleWatchOpts {
  idleMs?: number;
  checkMs?: number;
  /** Test seam: the interval scheduler. Defaults to the global `setInterval`/`clearInterval`. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** Test seam: wall clock. */
  now?: () => number;
}

/**
 * Start watching for an idle stretch. Returns a stop function (tests; app code never stops it).
 *
 * Two rules keep it from crying wolf:
 *
 * ① **One signal per idle stretch.** It re-arms only once input resumes, so a player who leaves the
 *    tab open over lunch produces one `idle_10min`, not one every minute.
 * ② **Nothing is claimed about time the watch was not watching.** `msSinceActivity()` is clamped to
 *    the span since the watch started or since the app last came back to the foreground (see
 *    `attentiveSince`), because `lastActivityMs` in renderPolicy is a module-level value whose
 *    meaning before `RenderPolicy.install()` is "nobody has said otherwise yet" — unclamped, the
 *    very first check could report a ten-minute idle stretch on a game open for twenty seconds.
 *
 * While the app is hidden the check is skipped entirely: `onAppHidden` in `analytics/index.ts` has
 * already reported that departure as `background`/`explicit_exit`, and a backgrounded tab accrues
 * "no input" trivially — counting it here would double-report the same churn under a reason that
 * claims the player was looking at the screen.
 */
export function startIdleWatch(probe: IdleProbe, opts: IdleWatchOpts = {}): () => void {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const checkMs = opts.checkMs ?? CHECK_MS;
  const setIv = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIv = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const now = opts.now ?? (() => Date.now());

  let armed = true;
  let hidden = false;
  /**
   * The earliest moment this watch is entitled to call "idle since" — the start of the watch, and
   * then each return to the foreground. Coming back from a backgrounded tab is itself proof the
   * player is present, but it is not pointer input, so without this the first check after a long
   * background would report a ten-minute idle stretch against someone who just walked back in.
   */
  let attentiveSince = now();

  onAppLifecycleChange((state) => {
    hidden = state !== 'visible';
    if (!hidden) { attentiveSince = now(); armed = true; }
  });

  const handle = setIv(() => {
    if (hidden) return;
    const idleFor = Math.min(probe.msSinceActivity(), now() - attentiveSince);
    if (idleFor < idleMs) { armed = true; return; }
    if (!armed) return;
    armed = false;
    track('churn_signal', { reason: 'idle_10min', scene: currentScene(), idle_sec: Math.round(idleFor / 1000) });
  }, checkMs);

  return () => clearIv(handle);
}
