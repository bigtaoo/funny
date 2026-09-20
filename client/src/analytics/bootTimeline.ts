/**
 * Boot timeline (ANALYTICS_DESIGN §5.1b) — how long this game takes to open, and where those
 * seconds actually go.
 *
 * Until 2026-09-20 the startup path emitted **nothing**: the first analytics event of a session was
 * `session_start`, tracked from `analytics.init()`, which only runs once `createAppCore` is being
 * constructed — i.e. after the bundle has downloaded, after the PIXI renderer exists and after the
 * L0 asset gate has resolved. Everything before that point was invisible, so "the players who opened
 * the page and never made it into the game" could only be counted by hand off reverse-proxy logs,
 * and "it takes ages to load on mobile data" could not be answered with a number at all.
 *
 * Three events, deliberately separate rather than one summary, because the gaps between their counts
 * are the measurement:
 *
 * | event | fired when | the question it answers |
 * |---|---|---|
 * | `boot` | our first line of JS runs | how much of the wait is network + bundle, before we exist |
 * | `first_frame` | the canvas is painted for the first time | when the blank page stops being blank |
 * | `load_time` | the first real screen is up | the total, split per phase |
 *
 * `boot` ÷ `load_time` per platform is the share of launches that abandon **during loading** —
 * a cohort that leaves no other trace, since it never reaches a scene, a screen_view or a click.
 *
 * **What these still cannot see**: a launch that is abandoned before the consent dialog is answered
 * never sends anything at all (`analytics/index.ts` `pending` holds pre-consent events in memory and
 * drops them if consent never comes). The denominator for *that* cohort is the server-side launch
 * counter on `GET /analytics/config` (ANALYTICS_DESIGN §3.6b) — not this file.
 */
import { track } from './index';

export type BootPhase =
  /** Our bundle's first executed line (`startApp`). On web everything before it is network + parse. */
  | 'script'
  /** PIXI Application constructed — a GPU context exists and the ticker is running. */
  | 'renderer'
  /** The L0 asset gate opens (`preloadBoot`). */
  | 'preload_start'
  /** The L0 asset gate closes; from here the app is free to build a scene. */
  | 'preload_done'
  /** First completed `renderer.render()` — the first pixels the player sees. */
  | 'first_frame'
  /** `core.start()` has returned: the first real screen is constructed. */
  | 'ready';

/** Offsets from the time origin, in ms. First write per phase wins (see {@link markBoot}). */
const marks = new Map<BootPhase, number>();
/** Extra props handed in with a phase (e.g. the asset count), merged into `load_time`. */
let extras: Record<string, unknown> = {};

/**
 * Wall-clock at module evaluation — the fallback time origin for runtimes without navigation
 * timing. On WeChat this is as early as anything we can observe: the mini-game package is already
 * on disk and `wx` hands us a running JS context, so "download the app" is not part of our number.
 */
const moduleLoadedAt = Date.now();

/**
 * True where `performance.now()` is measured from **navigation start** rather than from whenever the
 * runtime felt like starting its clock — i.e. a browser with a document. There, `performance.now()`
 * read at our first line already includes DNS, TLS, the HTML response and the bundle download, which
 * is the part of the wait we would otherwise never see. WeChat has no document; its timeline starts
 * at `moduleLoadedAt` instead, and `origin` on every event says which of the two a number is.
 */
function navOrigin(): boolean {
  return typeof document !== 'undefined' && typeof performance !== 'undefined' && typeof performance.now === 'function';
}

function elapsed(): number {
  return navOrigin() ? performance.now() : Date.now() - moduleLoadedAt;
}

const origin = (): 'nav' | 'script' => (navOrigin() ? 'nav' : 'script');

const round = (n: number): number => Math.round(n);

/** Difference between two marks, or undefined when either end was never reached. */
function span(from: BootPhase, to: BootPhase): number | undefined {
  const a = marks.get(from);
  const b = marks.get(to);
  return a === undefined || b === undefined ? undefined : b - a;
}

/**
 * Network breakdown of everything that happened before our first line, straight out of the
 * Navigation Timing entry. Web only — `undefined` on WeChat, where none of it applies.
 *
 * `nav_type` is load-bearing and belongs with the rest: a reload or a back-forward restore hits a
 * warm HTTP cache and reads several times faster than a cold `navigate`. Mixing them into one
 * average produces a p50 that describes nobody.
 */
function navigationTiming(): Record<string, unknown> {
  if (!navOrigin() || typeof performance.getEntriesByType !== 'function') return {};
  let nav: PerformanceNavigationTiming | undefined;
  try {
    nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  } catch {
    return {};
  }
  if (!nav) return {};
  const out: Record<string, unknown> = {
    nav_type: nav.type,
    dns_ms: round(nav.domainLookupEnd - nav.domainLookupStart),
    tcp_ms: round(nav.connectEnd - nav.connectStart),
    ttfb_ms: round(nav.responseStart - nav.requestStart),
    html_ms: round(nav.responseEnd - nav.responseStart),
  };
  // secureConnectionStart is 0 on plain HTTP and on a reused connection; only then is there no TLS
  // handshake to attribute, and reporting a full connectEnd-sized "tls_ms" there would be a lie.
  if (nav.secureConnectionStart > 0) out.tls_ms = round(nav.connectEnd - nav.secureConnectionStart);
  return { ...out, ...scriptResourceTiming() };
}

/**
 * What the JS bundle itself cost: wall time from the first script request to the last script
 * response, and the transferred size.
 *
 * `transferSize` is 0 for a cache hit **and** for a cross-origin response without
 * `Timing-Allow-Origin`, so the size is reported only when it is non-zero — an absent `js_kb` means
 * "not measurable here", never "zero bytes".
 */
function scriptResourceTiming(): Record<string, unknown> {
  let entries: PerformanceResourceTiming[];
  try {
    entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(
      (e) => e.initiatorType === 'script',
    );
  } catch {
    return {};
  }
  if (entries.length === 0) return {};
  const start = Math.min(...entries.map((e) => e.startTime));
  const end = Math.max(...entries.map((e) => e.responseEnd));
  const bytes = entries.reduce((sum, e) => sum + (e.transferSize || 0), 0);
  const out: Record<string, unknown> = { js_ms: round(end - start), js_files: entries.length };
  if (bytes > 0) out.js_kb = round(bytes / 1024);
  return out;
}

/**
 * Record a boot phase and, for the three phases that have an event, report it.
 *
 * First write per phase wins: `first_frame` is called from the renderer hook on **every** frame and
 * must stay a map lookup after the first one, and a re-entered boot (the E2E harness builds a second
 * app core in the same page) must not overwrite the real timeline with its own.
 *
 * Every event here is tracked before `analytics.init()` has run. That is safe by construction —
 * `track()` buffers anything queued before the SDK is ready and replays it (see `pending` in
 * `analytics/index.ts`) — and it is also the whole point: an event that waited for init could not
 * describe the time before init.
 */
export function markBoot(phase: BootPhase, extra: Record<string, unknown> = {}): void {
  if (marks.has(phase)) return;
  marks.set(phase, round(elapsed()));
  extras = { ...extras, ...extra };

  if (phase === 'script') {
    track('boot', { origin: origin(), to_script_ms: marks.get('script'), ...navigationTiming() });
  } else if (phase === 'first_frame') {
    track('first_frame', {
      origin: origin(),
      total_ms: marks.get('first_frame'),
      renderer_ms: span('script', 'renderer'),
      since_renderer_ms: span('renderer', 'first_frame'),
    });
  } else if (phase === 'ready') {
    track('load_time', {
      origin: origin(),
      total_ms: marks.get('ready'),
      // The phases, in the order they happen. Each is undefined when its own gate never ran, rather
      // than 0 — a missing phase and an instant one are different findings.
      to_script_ms: marks.get('script'),
      renderer_ms: span('script', 'renderer'),
      first_frame_ms: marks.get('first_frame'),
      preload_ms: span('preload_start', 'preload_done'),
      scene_ms: span('preload_done', 'ready'),
      ...extras,
    });
  }
}

/** ms since the time origin (navigation start on web, module load elsewhere). */
export function bootElapsedMs(): number {
  return round(elapsed());
}

/** Test seam: drop the recorded timeline so a second boot can be measured in the same process. */
export function resetBootTimeline(): void {
  marks.clear();
  extras = {};
}
