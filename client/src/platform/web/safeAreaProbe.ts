// `env(safe-area-inset-*)` as a value you can both READ and SUBSCRIBE TO.
//
// Was inline in WebPlatform.getSafeAreaInsets() as a read-only, poll-on-demand probe: a hidden
// zero-sized div whose four paddings are the four `env()` values, measured with getComputedStyle
// whenever somebody asked. That shape has one structural problem — nothing asks. The insets are read
// at boot, once more after the asset gate (`resettledLayout`), and then only on a `window.resize`.
// An inset that changes without a resize (WebKit settling `viewport-fit=cover` late, iOS handing the
// page a real inset after a rotation animation finishes, a status bar appearing over a call) reaches
// nobody, and the 2026-07-28 attempt at the iPhone-13 bug was exactly that: a second guess at WHEN
// to poll, rather than being told.
//
// So the probe is now sized BY the insets instead of padded by them: two hidden boxes, one measuring
// (left, top) and the other (right, bottom), watched by a single ResizeObserver. Any inset change
// resizes a box, which fires the observer, which pushes the new reading to subscribers. Split across
// two boxes so no single change can cancel itself out (one box sized by top+bottom would be blind to
// a 47/34 → 34/47 swap; one axis per corner cannot be).
//
// Each inset is one box's own width/height, so reading and observing use the same two elements and
// cannot drift apart. `env(...)` with an explicit `0px` fallback keeps a browser that has never heard
// of `env()` (or a page without `viewport-fit=cover`) at a clean zero rather than `auto`.
import type { SafeAreaInsets } from '../../layout/ILayout';

const ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** `position:fixed` so the boxes never contribute layout, `visibility:hidden` (NOT `display:none` —
 *  a non-rendered element has no box, so ResizeObserver would never fire for it). */
const PROBE_CSS =
  'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;z-index:-1;' +
  'margin:0;padding:0;border:0;';

interface Probes {
  /** width = left inset, height = top inset. */
  readonly a: HTMLDivElement;
  /** width = right inset, height = bottom inset. */
  readonly b: HTMLDivElement;
}

let probes: Probes | null = null;
/** Subscribers + the single observer feeding them; created on the first subscribe. */
const listeners = new Set<(insets: SafeAreaInsets) => void>();
let observer: ResizeObserver | null = null;
/**
 * The reading subscribers were last TOLD about — owned by the observer alone, deliberately not
 * touched by {@link readSafeAreaInsets}. Sharing one "last value" between the two would make the
 * notification depend on who read last: any caller polling insets (`ViewportResizer` does, on every
 * `window.resize`) would move the baseline forward, and a change that landed between such a read and
 * the observer's callback would compare equal and be dropped — i.e. exactly the notification this
 * module exists to deliver, lost to a race.
 */
let lastNotified: SafeAreaInsets = ZERO;

function ensureProbes(): Probes | null {
  if (probes) return probes;
  if (typeof document === 'undefined' || !document.body) return null;
  const make = (w: string, h: string): HTMLDivElement => {
    const el = document.createElement('div');
    el.style.cssText = `${PROBE_CSS}width:env(safe-area-inset-${w},0px);height:env(safe-area-inset-${h},0px);`;
    document.body.appendChild(el);
    return el;
  };
  probes = { a: make('left', 'top'), b: make('right', 'bottom') };
  return probes;
}

/** Current `env(safe-area-inset-*)` in CSS px; all-zero where there is no DOM or no inset. */
export function readSafeAreaInsets(): SafeAreaInsets {
  const p = ensureProbes();
  if (!p) return ZERO;
  const a = p.a.getBoundingClientRect();
  const b = p.b.getBoundingClientRect();
  return { top: a.height, right: b.width, bottom: b.height, left: a.width };
}

export function insetsDiffer(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return a.top !== b.top || a.right !== b.right || a.bottom !== b.bottom || a.left !== b.left;
}

/**
 * Subscribe to inset changes; returns an unsubscribe.
 *
 * A no-op unsubscribe (and no subscription at all) where there is no DOM or no `ResizeObserver`
 * — every such runtime is one that also has no insets to report. `window.resize` still drives the
 * re-fit there, so the caller degrades to exactly the old behaviour rather than breaking.
 */
export function observeSafeAreaInsets(cb: (insets: SafeAreaInsets) => void): () => void {
  const p = ensureProbes();
  if (!p || typeof ResizeObserver === 'undefined') return () => {};
  listeners.add(cb);
  if (!observer) {
    lastNotified = readSafeAreaInsets();
    observer = new ResizeObserver(() => {
      const now = readSafeAreaInsets();
      // The observer can fire for a box mutation that leaves the VALUES alone; only an actual change
      // is worth waking the layout for (a re-fit resizes the renderer's backbuffer).
      if (!insetsDiffer(lastNotified, now)) return;
      lastNotified = now;
      for (const l of [...listeners]) l(now);
    });
    observer.observe(p.a);
    observer.observe(p.b);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

/** Test-only reset — the probes and the observer are module-level singletons by design. */
export function resetSafeAreaProbeForTests(): void {
  observer?.disconnect();
  observer = null;
  listeners.clear();
  probes?.a.remove();
  probes?.b.remove();
  probes = null;
  lastNotified = ZERO;
}
