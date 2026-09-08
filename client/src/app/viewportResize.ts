// The lobby's viewport-resize half of PixiAppViews, extracted 2026-09-08 when the ADR-083 paint-gate
// wiring pushed that file past the 500-line convention. It is a form② split: the screen-intent
// facade ("show me the shop") and "the window changed shape" share nothing but the runtime handles
// and the current layout, and this half is the only one of the two with a listener, a timer and
// state of its own to get wrong.
//
// PixiAppViews keeps ownership of `layout` (~40 show*() call sites read it) and is handed each new
// one through `onLayout`; this class owns everything else — the no-change guard, the immediate
// re-fit, and the coalescing window in front of the expensive rebuild.
import * as PIXI from 'pixi.js-legacy';
import type { IPlatform } from '../platform/IPlatform';
import { invalidateRender } from '../render/renderPolicy';
import { ScalingManager, createLayout } from '../layout/ScalingManager';
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

/** Watches `window.resize` while the lobby is up: re-fits the canvas at once, rebuilds later. */
export class ViewportResizer {
  /** Last size actually applied, so a resize event that reports no change can be dropped outright.
   *  Seeded from the live screen in the constructor rather than left at 0: the boot size IS an
   *  applied size, and starting at 0 would wave the first no-op resize event straight through. */
  private appliedW: number;
  private appliedH: number;

  /** Pending trailing rebuild (see onResize). Cleared by stop() so it can never land off-lobby. */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly platform: IPlatform,
    private readonly app: PIXI.Application,
    private readonly scaling: ScalingManager,
    /** Hand the freshly fitted layout back to the facade — called on every real size change. */
    private readonly onLayout: (layout: ILayout) => void,
    /** Rebuild whatever is on screen. Called once per coalescing window, never inside the event. */
    private readonly onSettled: () => void,
  ) {
    const { width, height } = platform.getScreenSize();
    this.appliedW = width;
    this.appliedH = height;
  }

  /** Start watching (the lobby is on screen). Idempotent — `addEventListener` dedupes the handler. */
  listen(): void {
    window.addEventListener('resize', this.onResize);
  }

  /**
   * Stop watching — every non-lobby screen calls this first.
   *
   * Cancelling the pending rebuild is load-bearing now that it is deferred: a rotation immediately
   * followed by a tap into another screen would otherwise leave a queued showLobby() that fires
   * ~180ms later and yanks the player back to the lobby from wherever they had just navigated to.
   */
  stop(): void {
    window.removeEventListener('resize', this.onResize);
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
   * and each of those used to rebuild the lobby for nothing.
   */
  private readonly onResize = (): void => {
    const { width, height } = this.platform.getScreenSize();
    if (width === this.appliedW && height === this.appliedH) return;
    this.appliedW = width;
    this.appliedH = height;

    const insets = this.platform.getSafeAreaInsets?.();
    this.app.renderer.resize(width, height);
    // The backbuffer just changed size; nothing in the scene graph did, so the paint gate needs
    // telling (render/renderPolicy.ts).
    invalidateRender();
    const layout = createLayout(width, height, Side.Bottom, insets);
    this.onLayout(layout);
    this.scaling.resize(width, height, layout, insets);

    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.onSettled();
    }, REBUILD_COALESCE_MS);
  };
}
