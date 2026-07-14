import * as PIXI from 'pixi.js-legacy';
import { ui as C } from '../../render/sketchUi';
import type { Rect } from '../../layout/ILayout';

// ── ScrollIndicator — shared scroll-position indicator ────────────────────────
//
// A lightweight, non-interactive scrollbar for the client's masked scroll regions
// (BattlePass tracks, world-info lists, inventory/roster grids, chat, …). Every
// scrollable page shares one visual language: a faint ink track down the right edge
// of the viewport with a rounded thumb whose length ≈ viewport/content ratio and
// whose position ≈ scroll progress.
//
// Deliberately an indicator only — it does not capture pointer input. Scenes already
// own drag/wheel scrolling; this just shows "there is more, and here's where you are".
// Keeping it stateless (one pure draw call) means it drops onto any scroll region with
// a single line and later restyling is one edit here, not twenty.

export interface ScrollIndicatorOpts {
  /** Thumb + track colour. Default: ink dark (matches page text). */
  color?: number;
  /** Thumb opacity (the track is drawn at a fraction of this). Default 0.42. */
  alpha?: number;
  /** Bar thickness in px. Default 5. */
  width?: number;
  /** Gap between the bar and the viewport's right edge, in px. Default 3. */
  inset?: number;
  /** Minimum thumb length so it stays grabbable-looking on very long content. Default 24. */
  minThumb?: number;
  /** Draw the faint full-height track behind the thumb. Default true. */
  track?: boolean;
}

/**
 * Draw a scroll-position indicator on the right edge of a masked scroll `view`.
 *
 * Call at the END of a scene's render(), after the scroll content + its mask are added,
 * so the bar paints on top:
 *
 *   drawScrollIndicator(this.container, viewportRect, this.scrollY, this.scrollMax);
 *
 * `view` is the same rect used for the content mask. `scrollMax` is `contentHeight -
 * view.h` (the largest valid scrollY). No-op returning null when there's nothing to
 * scroll (scrollMax <= 0) or the viewport is degenerate — so it's safe to call
 * unconditionally.
 *
 * The returned Graphics is already added to `parent`; scenes with a drag fast-path that
 * skips full render can keep the reference and call {@link drawScrollIndicator} again
 * (removing the old one) to update the thumb cheaply.
 */
export function drawScrollIndicator(
  parent: PIXI.Container,
  view: Rect,
  scrollY: number,
  scrollMax: number,
  opts: ScrollIndicatorOpts = {},
): PIXI.Graphics | null {
  const geo = scrollThumbGeometry(view, scrollY, scrollMax, opts);
  if (!geo) return null;

  const color = opts.color ?? C.dark;
  const alpha = opts.alpha ?? 0.42;
  const showTrack = opts.track ?? true;

  const g = new PIXI.Graphics();
  if (showTrack) {
    g.beginFill(color, alpha * 0.28).drawRoundedRect(geo.barX, view.y, geo.width, view.h, geo.r).endFill();
  }
  g.beginFill(color, alpha).drawRoundedRect(geo.barX, geo.thumbY, geo.width, geo.thumbH, geo.r).endFill();
  parent.addChild(g);
  return g;
}

/** Thumb geometry the indicator draws — split out so the layout math is unit-testable
 *  without a renderer. Returns null when there's nothing to scroll. */
export function scrollThumbGeometry(
  view: Rect,
  scrollY: number,
  scrollMax: number,
  opts: ScrollIndicatorOpts = {},
): { barX: number; thumbY: number; thumbH: number; width: number; r: number } | null {
  if (scrollMax <= 0 || view.h <= 0 || view.w <= 0) return null;

  const width = opts.width ?? 5;
  const inset = opts.inset ?? 3;
  const minThumb = opts.minThumb ?? 24;

  const contentH = view.h + scrollMax;
  const thumbH = Math.max(minThumb, Math.min(view.h, Math.round(view.h * (view.h / contentH))));
  const frac = Math.max(0, Math.min(1, scrollY / scrollMax));
  const thumbY = view.y + Math.round((view.h - thumbH) * frac);
  const barX = view.x + view.w - width - inset;
  return { barX, thumbY, thumbH, width, r: width / 2 };
}
