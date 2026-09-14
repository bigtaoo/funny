// The viewport-resize half of PixiAppViews, extracted 2026-09-08 when the ADR-083 paint-gate
// wiring pushed that file past the 500-line convention. It is a form② split: the screen-intent
// facade ("show me the shop") and "the window changed shape" share nothing but the runtime handles
// and the current layout, and this half is the only one of the two with a listener, a timer and
// state of its own to get wrong.
//
// PixiAppViews keeps ownership of `layout` (~40 show*() call sites read it) and is handed each new
// one through `onLayout`; this class owns everything else — the no-change guard, the immediate
// re-fit, and the coalescing window in front of the expensive rebuild.
//
// ## 2026-09-10: the re-fit went global; 2026-09-14: so did the rebuild
//
// It used to be one lifetime for both halves, attached in `showLobby()` and detached by every other
// screen. So outside the lobby — the login screen, the settings screen, a whole battle — a rotation
// or an inset change reached NOTHING: `renderer.resize` was never called, the canvas kept the CSS
// size it was built at, and `toDesignSpace` kept mapping taps through a transform computed for the
// old viewport. The 2026-09-10 pass made the cheap half unconditional:
//
//   - Re-fit (`renderer.resize` + `createLayout` + `scaling.resize`) is a few numbers and a
//     backbuffer resize. It must happen for whatever is on screen, so it is installed once at
//     construction and never removed.
//   - Rebuild (tear down and reconstruct the current scene) allocates a whole scene graph, so it
//     keeps the coalescing window in front of it.
//
// The rebuild half stayed lobby-only for four more days, which left every other screen correctly
// fitted but still laid out against the design rect it was built with — a portrait shop stretched
// across a landscape canvas. It is now fired for whatever is on screen, and WHICH screens accept it
// is PixiAppViews's call (`mount` vs `mountVolatile`), not this file's: this class has no idea what
// a scene is, and the arm/disarm lifetime it used to carry was really a statement about scenes.
// What is left here is the event plumbing — two sources, the no-change guard, and the timer.
import * as PIXI from 'pixi.js-legacy';
import type { IPlatform } from '../platform/IPlatform';
import type { SafeAreaInsets } from '../layout/ILayout';
import { invalidateRender } from '../render/renderPolicy';
import { ScalingManager, createLayout, insetsEqual } from '../layout/ScalingManager';
import { Side } from '../game';
import type { ILayout } from '../layout/ILayout';

/**
 * Coalescing window for the scene rebuild. One physical device rotation fires `resize` repeatedly
 * over roughly a quarter second (iOS reports the viewport progressively *through* the rotation
 * animation), and the pre-2026-08-24 handler ran a full teardown-and-rebuild of the lobby on every
 * one of them. Long enough to swallow a whole rotation; short enough to be imperceptible when a
 * desktop user drags a window edge.
 */
const REBUILD_COALESCE_MS = 180;

/** Re-fits the canvas for any viewport change; asks for a scene rebuild once things settle. */
export class ViewportResizer {
  /** Last size actually applied, so a resize event that reports no change can be dropped outright.
   *  Seeded from the live screen in the constructor rather than left at 0: the boot size IS an
   *  applied size, and starting at 0 would wave the first no-op resize event straight through. */
  private appliedW: number;
  private appliedH: number;
  /** Last insets actually applied, for the same reason — and load-bearing in its own right: an
   *  inset can change while the viewport size does not (WebKit settling `viewport-fit=cover` after
   *  first paint, iOS handing over the real inset when a rotation animation ends). Comparing only
   *  width/height dropped exactly those events, which are the ones the inset subscription below
   *  exists to deliver. */
  private appliedInsets: SafeAreaInsets | undefined;

  /** Pending trailing rebuild (see onViewportChanged). */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unsubscribe for the platform's inset-change feed, if it has one. */
  private unsubInsets: (() => void) | null = null;

  constructor(
    private readonly platform: IPlatform,
    private readonly app: PIXI.Application,
    private readonly scaling: ScalingManager,
    /** Hand the freshly fitted layout back to the facade — called on every real viewport change. */
    private readonly onLayout: (layout: ILayout) => void,
    /**
     * The viewport has settled: rebuild whatever is on screen, if that screen can be rebuilt.
     * Called once per coalescing window, never inside the event itself. Deciding whether there is
     * anything to do is the callback's job — see PixiAppViews's `respawn`.
     */
    private readonly onSettled: () => void,
  ) {
    const { width, height } = platform.getScreenSize();
    this.appliedW = width;
    this.appliedH = height;
    this.appliedInsets = platform.getSafeAreaInsets?.();
  }

  /**
   * Start watching the viewport. Called once, from PixiAppViews's constructor — the canvas has to
   * track the window on every screen, not just the lobby.
   *
   * Two sources, deliberately: `window.resize` covers size changes, and the platform's inset feed
   * (`IPlatform.onSafeAreaInsetsChanged`, a ResizeObserver on env()-sized probes on web) covers the
   * inset changes that arrive WITHOUT one. Platforms without the feed keep the resize-only
   * behaviour. Idempotent — `addEventListener` dedupes the same handler reference.
   */
  install(): void {
    window.addEventListener('resize', this.onViewportChanged);
    this.unsubInsets ??= this.platform.onSafeAreaInsetsChanged?.(this.onViewportChanged) ?? null;
  }

  /** Tear the whole thing down (tests / a future multi-app shell). Not used in the normal app life. */
  uninstall(): void {
    window.removeEventListener('resize', this.onViewportChanged);
    this.unsubInsets?.();
    this.unsubInsets = null;
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
  }

  /**
   * Viewport changed: re-fit the canvas now, rebuild the current screen once things settle.
   *
   * The split matters. Re-fitting (renderer.resize + layout + scaling) is cheap and must be immediate
   * or the canvas visibly lags the viewport; rebuilding a scene allocates a whole scene graph and is
   * the expensive half. Previously both ran synchronously on every event, so a single rotation cost N
   * full scene rebuilds — N rounds of texture churn at the exact moment a mobile WebView is already
   * paying for a drawing-buffer reallocation, and on a memory-capped in-app WebView that is a plausible
   * way to get the renderer process killed outright rather than merely made slow.
   *
   * The no-change guard in front is worth as much again: mobile browsers fire `resize` for things that
   * are not resizes at all (chrome bars sliding, the on-screen keyboard, scroll-driven toolbar hiding),
   * and each of those used to rebuild the scene for nothing. It compares insets as well as size, so
   * "same window, different notch inset" counts as a change rather than being swallowed.
   */
  private readonly onViewportChanged = (): void => {
    const { width, height } = this.platform.getScreenSize();
    const insets = this.platform.getSafeAreaInsets?.();
    if (width === this.appliedW && height === this.appliedH && insetsEqual(insets, this.appliedInsets)) return;
    this.appliedW = width;
    this.appliedH = height;
    this.appliedInsets = insets;

    this.app.renderer.resize(width, height);
    // The backbuffer just changed size; nothing in the scene graph did, so the paint gate needs
    // telling (render/renderPolicy.ts).
    invalidateRender();
    const layout = createLayout(width, height, Side.Bottom, insets);
    this.onLayout(layout);
    this.scaling.resize(width, height, layout, insets);

    // A rotation immediately followed by a tap into another screen is safe without a cancel hook:
    // the timer only says "the viewport settled", and what gets rebuilt is resolved by the callback
    // when it fires — by then that is the screen the player actually navigated to.
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.onSettled();
    }, REBUILD_COALESCE_MS);
  };
}
