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
// ## 2026-09-10: the re-fit went global, the rebuild stayed lobby-only
//
// It used to be one lifetime for both halves, attached in `showLobby()` and detached by every other
// screen (`leaveLobby()`). So outside the lobby — the login screen, the settings screen, a whole
// battle — a rotation or an inset change reached NOTHING: `renderer.resize` was never called, the
// canvas kept the CSS size it was built at, and `toDesignSpace` kept mapping taps through a
// transform computed for the old viewport. Rotating inside a match left the game drawn at the old
// shape in the new window.
//
// The two halves have very different costs, and only the expensive one has any reason to be
// lobby-scoped:
//
//   - Re-fit (`renderer.resize` + `createLayout` + `scaling.resize`) is a few numbers and a
//     backbuffer resize. It must happen for whatever is on screen, so it is installed once at
//     construction and never removed.
//   - Rebuild (tear down and reconstruct the current scene) allocates a whole scene graph. Only the
//     lobby can do it at all (`createAppCore.onResized` is gated on `state.inLobby`), so it keeps
//     the arm/disarm lifetime and the coalescing window exactly as before.
//
// A non-lobby scene therefore ends up correctly fitted but still laid out for the design rect it was
// built against. That is a strict improvement on the old behaviour (canvas the wrong size AND taps
// mapped through a stale transform), and rebuilding arbitrary scenes on resize is a separate,
// much larger change — see design/game/UI_DESIGN.md's safe-area row.
import * as PIXI from 'pixi.js-legacy';
import type { IPlatform } from '../platform/IPlatform';
import type { SafeAreaInsets } from '../layout/ILayout';
import { invalidateRender } from '../render/renderPolicy';
import { ScalingManager, createLayout, insetsEqual } from '../layout/ScalingManager';
import { Side } from '../game';
import type { ILayout } from '../layout/ILayout';

/**
 * Coalescing window for the lobby rebuild. One physical device rotation fires `resize` repeatedly
 * over roughly a quarter second (iOS reports the viewport progressively *through* the rotation
 * animation), and the pre-2026-08-24 handler ran a full teardown-and-rebuild of the lobby on every
 * one of them. Long enough to swallow a whole rotation; short enough to be imperceptible when a
 * desktop user drags a window edge.
 */
const REBUILD_COALESCE_MS = 180;

/** Re-fits the canvas for any viewport change; rebuilds the lobby (only) once things settle. */
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

  /** Pending trailing rebuild (see onViewportChanged). Cleared by disarmRebuild() so it can never
   *  land off-lobby. */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** True only while the lobby is on screen — the rebuild half's whole lifetime. */
  private rebuildArmed = false;
  /** Unsubscribe for the platform's inset-change feed, if it has one. */
  private unsubInsets: (() => void) | null = null;

  constructor(
    private readonly platform: IPlatform,
    private readonly app: PIXI.Application,
    private readonly scaling: ScalingManager,
    /** Hand the freshly fitted layout back to the facade — called on every real viewport change. */
    private readonly onLayout: (layout: ILayout) => void,
    /** Rebuild whatever is on screen. Called once per coalescing window, never inside the event. */
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
    this.disarmRebuild();
  }

  /** The lobby is on screen: a settled viewport change may rebuild it. */
  armRebuild(): void {
    this.rebuildArmed = true;
  }

  /**
   * Leaving the lobby — every non-lobby screen calls this first (via `PixiAppViews.leaveLobby`).
   *
   * Cancelling the pending rebuild is load-bearing: a rotation immediately followed by a tap into
   * another screen would otherwise leave a queued showLobby() that fires ~180ms later and yanks the
   * player back to the lobby from wherever they had just navigated to. The canvas re-fit above is
   * NOT affected — it stays live for whatever screen this is going to.
   */
  disarmRebuild(): void {
    this.rebuildArmed = false;
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
  }

  /**
   * Viewport changed: re-fit the canvas now, rebuild the lobby once things settle.
   *
   * The split matters. Re-fitting (renderer.resize + layout + scaling) is cheap and must be immediate
   * or the canvas visibly lags the viewport; rebuilding the lobby allocates a whole scene graph and is
   * the expensive half. Previously both ran synchronously on every event, so a single rotation cost N
   * full scene rebuilds — N rounds of texture churn at the exact moment a mobile WebView is already
   * paying for a drawing-buffer reallocation, and on a memory-capped in-app WebView that is a plausible
   * way to get the renderer process killed outright rather than merely made slow.
   *
   * The no-change guard in front is worth as much again: mobile browsers fire `resize` for things that
   * are not resizes at all (chrome bars sliding, the on-screen keyboard, scroll-driven toolbar hiding),
   * and each of those used to rebuild the lobby for nothing. It compares insets as well as size, so
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

    if (!this.rebuildArmed) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.onSettled();
    }, REBUILD_COALESCE_MS);
  };
}
