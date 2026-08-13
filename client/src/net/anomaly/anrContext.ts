// anomaly.ts's ANR attribution context, extracted as form① (claudedocs/client-modules.md "单文件
// 500 行收敛") — all state here is module-scope (activeScene/longTaskLog/etc.), same shape as the
// file it was split from. Exported `let`s (longTaskObserverActive) are live ES-module bindings:
// importers see this module's own reassignments without needing a getter — unlike a class
// instance field copied onto a plain host object, a module binding isn't a copy.
import { recentClientLogs } from '../log';
import { BREADCRUMB_N } from './reporter';

// The watchdog only sees a wall-clock drift; it has no idea *what* was on screen or running when the
// main thread froze. These hooks let the higher layers (SceneManager / MemoryMonitor) feed that
// context in without anomaly.ts (net layer) reverse-importing PIXI or the scene graph:
//   setActiveScene(name)  — SceneManager stamps the current scene on every swap (a plain string).
//   setAnrContextProvider — MemoryMonitor registers a getter for live GPU/texture counters.
//   recordFrameSample(ms) — SceneManager times every scene.update() call. If a single call ran long
//                           enough to plausibly BE the freeze, its scene + duration is attached — this
//                           tells us whether the block happened inside our own synchronous render code
//                           (a specific scene's update() took e.g. 30000ms) versus somewhere the ticker
//                           can't see (GC pause, tab-switch compositor stall, background throttling edge
//                           case) — the watchdog alone can't distinguish these, and that distinction is
//                           exactly what's still missing to root-cause the recurring 25-54s freezes.
// All folded into the `anr` event detail so a recurring freeze is attributable to a screen and, when
// possible, a specific blocking call — instead of being an anonymous stallMs with no lead.

let activeScene = '';
let anrContextProvider: (() => Record<string, unknown>) | null = null;

/** Stamp the currently-mounted scene name (called by SceneManager on each swap). Attached to anr reports. */
export function setActiveScene(name: string): void { activeScene = name; }

/** Read the currently-mounted scene name (e.g. for tagging mem/cpu reports outside the anr path). */
export function getActiveScene(): string { return activeScene; }

/** Register a getter for extra ANR context (GPU/texture counters). Called once by MemoryMonitor. */
export function setAnrContextProvider(fn: (() => Record<string, unknown>) | null): void { anrContextProvider = fn; }

/** Longest single scene.update() call seen recently, if any exceeded LONG_FRAME_MS. Cleared once stale. */
let lastLongFrame: { ms: number; scene: string; ts: number } | null = null;
const LONG_FRAME_MS = 200;      // frames this slow are worth remembering even outside a full ANR
const LONG_FRAME_STALE_MS = 60_000; // don't attach a stale sample from long before the freeze

/**
 * Called once per tick by SceneManager with how long the just-finished scene.update() call took.
 * Only frames slower than LONG_FRAME_MS are kept (cheap: no-op comparison on the fast path).
 */
export function recordFrameSample(ms: number): void {
  if (ms < LONG_FRAME_MS) return;
  if (!lastLongFrame || ms >= lastLongFrame.ms) lastLongFrame = { ms: Math.round(ms), scene: activeScene, ts: Date.now() };
}

/**
 * Longest scene *construction* (`new XScene(...)`) seen recently, if any exceeded LONG_FRAME_MS.
 * `recordFrameSample` only times each tick's `scene.update()` call — it has no visibility into the
 * synchronous work a scene's constructor does while building its own UI (layout, text, list rows)
 * *before* it's ever mounted and ticked. A run of prod ANRs (25-54s, LobbyScene/FriendsScene/
 * LeaderboardScene) all came back with `longFrameMs` absent, meaning the freeze wasn't inside a
 * tracked update() call — construction is the other synchronous path a `goto()` navigation runs,
 * and it was completely dark. Cleared once stale, same as lastLongFrame.
 */
let lastLongConstruct: { ms: number; scene: string; ts: number } | null = null;

/**
 * Called by PixiAppViews around every `new XxxScene(...)` call, with how long the constructor took.
 * Only constructions slower than LONG_FRAME_MS are kept (cheap: no-op comparison on the fast path).
 */
export function recordConstructSample(scene: string, ms: number): void {
  if (ms < LONG_FRAME_MS) return;
  if (!lastLongConstruct || ms >= lastLongConstruct.ms) lastLongConstruct = { ms: Math.round(ms), scene, ts: Date.now() };
}

/**
 * Longest `renderer.render()` call seen recently, if any exceeded LONG_FRAME_MS.
 * PIXI's `Application` registers its own render call on the shared ticker at `UPDATE_PRIORITY.LOW`,
 * strictly *after* `SceneManager`'s `onTick` (registered at default/NORMAL priority) — so the actual
 * GPU draw-call submission and any synchronous Text-canvas rasterization it triggers happen completely
 * outside the window `recordFrameSample` covers. A batch of prod ANRs (85c3448, 2026-07-18) came back
 * with *both* `longFrameMs` and `longConstructMs` absent despite 5-30s stalls — this is the one
 * remaining synchronous path a `goto()`/steady-state frame runs that was still dark.
 */
let lastLongRender: { ms: number; scene: string; ts: number } | null = null;

/** Called by the renderer.render() wrapper installed in app.ts, with how long the call took. */
export function recordRenderSample(ms: number): void {
  if (ms < LONG_FRAME_MS) return;
  if (!lastLongRender || ms >= lastLongRender.ms) lastLongRender = { ms: Math.round(ms), scene: activeScene, ts: Date.now() };
}

// ── Long Tasks correlation (Long Tasks API, Chromium-only) ─────────────────────────────────────
// recordFrameSample / recordConstructSample / recordRenderSample only see OUR OWN code (scene
// update/construct/render calls). The Long Tasks API instead observes ANY main-thread task
// >=50ms regardless of source — third-party code, browser-internal layout/style work, or (nested
// inside whichever task happens to be running) a synchronous GC pause. Its value here is less
// "what ran long" and more a falsifiable test: if a multi-second `stallMs` has NO overlapping long
// tasks at all, the main thread wasn't executing JS during that window — pointing at true thread
// suspension (an OS/browser tab-freeze edge case the visibilitychange latch below doesn't catch)
// rather than at slow or GC-heavy script.
const longTaskLog: { start: number; dur: number }[] = [];
const LONGTASK_RETAIN_MS = 120_000;

/** True once the Long Tasks observer is confirmed running. Only then can "zero long tasks in the
 *  stall window" be trusted as real evidence (vs. an unsupported browser silently seeing nothing).
 *  Read directly by watchers.ts's installAnrWatchdog — a live ES-module binding, not a snapshot. */
export let longTaskObserverActive = false;

export function installLongTaskObserver(): void {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!PO || !PO.supportedEntryTypes?.includes?.('longtask')) return;
  try {
    new PO((list) => {
      const origin = performance.timeOrigin;
      for (const e of list.getEntries()) longTaskLog.push({ start: Math.round(origin + e.startTime), dur: Math.round(e.duration) });
      const cutoff = Date.now() - LONGTASK_RETAIN_MS;
      while (longTaskLog.length && longTaskLog[0].start < cutoff) longTaskLog.shift();
    }).observe({ type: 'longtask', buffered: true });
    longTaskObserverActive = true;
  } catch { /* unsupported in this browser build; never fatal */ }
}

/** Total duration + count of observed long tasks overlapping [since, now] — see installLongTaskObserver. */
function longTasksSince(since: number): { longTaskMs: number; longTaskCount: number } | Record<string, never> {
  if (!longTaskLog.length) return {};
  let ms = 0, count = 0;
  for (const t of longTaskLog) if (t.start + t.dur >= since) { ms += t.dur; count++; }
  return count ? { longTaskMs: Math.round(ms), longTaskCount: count } : {};
}

// ── Heap delta across a stall (Chromium-only `performance.memory`) ─────────────────────────────
// A large drop in used-heap across the stall window is the closest same-run signal that a major
// GC pause ran during the freeze (heap size as reported here doesn't shrink any other way);
// no drop despite a long stall argues against the GC-pause theory for that occurrence.
let lastHeapSampleMB: number | null = null;
function heapDelta(): Record<string, unknown> {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const used = mem?.usedJSHeapSize;
  if (typeof used !== 'number') return {};
  const usedMB = Math.round((used / 1_048_576) * 10) / 10;
  const prev = lastHeapSampleMB;
  lastHeapSampleMB = usedMB;
  return prev == null ? { heapMB: usedMB } : { heapMB: usedMB, heapDeltaMB: Math.round((usedMB - prev) * 10) / 10 };
}

/** Assembled ANR context: active scene + registered provider + longest own-code frame/construct/
 *  render samples + Long Tasks correlation + heap delta + recent breadcrumbs. Called by watchers.ts's
 *  installAnrWatchdog when a stall crosses the threshold. */
export function anrContext(stallSince?: number): Record<string, unknown> {
  let extra: Record<string, unknown> = {};
  try { extra = anrContextProvider?.() ?? {}; } catch { /* provider must never break the report */ }
  const lf = lastLongFrame;
  const longFrame = lf && Date.now() - lf.ts <= LONG_FRAME_STALE_MS
    ? { longFrameMs: lf.ms, longFrameScene: lf.scene }
    : {};
  const lc = lastLongConstruct;
  const longConstruct = lc && Date.now() - lc.ts <= LONG_FRAME_STALE_MS
    ? { longConstructMs: lc.ms, longConstructScene: lc.scene }
    : {};
  const lr = lastLongRender;
  const longRender = lr && Date.now() - lr.ts <= LONG_FRAME_STALE_MS
    ? { longRenderMs: lr.ms, longRenderScene: lr.scene }
    : {};
  const longTasks = stallSince != null ? longTasksSince(stallSince) : {};
  // Attach the same recent breadcrumbs used on crash/exit reports — the last net-layer activity
  // (api/gateway) right before the freeze is often the only lead when longFrame comes back empty
  // (i.e. the block wasn't inside a tracked scene.update() call).
  const crumbs = recentClientLogs(BREADCRUMB_N).map((e) => `[${e.level}${e.tag ? ':' + e.tag : ''}] ${e.msg}`);
  return {
    ...(activeScene ? { scene: activeScene } : {}),
    ...extra, ...longFrame, ...longConstruct, ...longRender, ...longTasks, ...heapDelta(),
    ...(crumbs.length ? { crumbs } : {}),
  };
}
