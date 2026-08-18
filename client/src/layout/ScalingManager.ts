import * as PIXI from 'pixi.js-legacy';
import { ILayout, SafeAreaInsets } from './ILayout';
import { PortraitLayout } from './PortraitLayout';
import { LandscapeLayout } from './LandscapeLayout';
import { Side } from '../game';

export type Orientation = 'portrait' | 'landscape';

/**
 * Detects the current orientation from the actual screen dimensions.
 */
export function detectOrientation(screenW: number, screenH: number): Orientation {
  return screenW > screenH ? 'landscape' : 'portrait';
}

/**
 * Creates the appropriate ILayout for the given screen size.
 *
 * `localSide` decides which side appears at the bottom of the screen:
 * single-player / campaign / netplay host stay Side.Bottom; the netplay
 * joiner (localSide 1 = Side.Top) gets a 180°-flipped layout so their own
 * base, hand and HUD read as "mine" at the bottom (S1-9).
 */
export function createLayout(
  screenW: number,
  screenH: number,
  localSide: Side = Side.Bottom,
  insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 },
): ILayout {
  const orient = detectOrientation(screenW, screenH);
  // Both layouts size their reclaimable axis to the *safe* drawable area so the
  // game fills the notch-free region without letterbox (ScalingManager offsets the
  // layer to match): portrait grows its height, landscape grows its width.
  const availW = Math.max(1, screenW - insets.left - insets.right);
  const availH = Math.max(1, screenH - insets.top - insets.bottom);
  if (orient === 'landscape') return new LandscapeLayout(availW, availH, localSide);
  return new PortraitLayout(availW, availH, localSide);
}

const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

// createLayout()/ScalingManager both default a missing insets arg to all-zero, so an
// undefined reading and an explicit all-zero one are the same layout — compare normalized.
function insetsEqual(a: SafeAreaInsets | undefined, b: SafeAreaInsets | undefined): boolean {
  const na = a ?? ZERO_INSETS;
  const nb = b ?? ZERO_INSETS;
  return na.top === nb.top && na.right === nb.right && na.bottom === nb.bottom && na.left === nb.left;
}

/**
 * WebKit can report `env(safe-area-inset-*)` as 0 on the very first synchronous read after a
 * cold load, before `viewport-fit=cover` has settled — so a boot-time inset read can undercount
 * the notch/status-bar inset. Compares a later ("settled") reading against the boot-time one and
 * returns a freshly computed layout if they differ, or `null` if nothing changed (the common
 * case — callers should skip the rescale then).
 */
export function resettledLayout(
  screenW: number,
  screenH: number,
  initialInsets: SafeAreaInsets | undefined,
  settledInsets: SafeAreaInsets | undefined,
  localSide: Side = Side.Bottom,
): ILayout | null {
  if (!settledInsets || insetsEqual(settledInsets, initialInsets)) return null;
  return createLayout(screenW, screenH, localSide, settledInsets);
}

/**
 * ScalingManager — wraps a PIXI.Application and provides two containers:
 *
 *   bgLayer   — Cover-scaled background (always fills screen).
 *               For MVP this is left empty; the background color is set via
 *               the PIXI.Application backgroundColor instead.
 *
 *   gameLayer — Contain-scaled game content.  All scenes should add their
 *               containers here, NOT directly to app.stage.
 *
 * Call resize() whenever the canvas size changes (browser resize event).
 */
/**
 * Desk surround (2026-08-18) — what fills the letterbox bands.
 *
 * Portrait design height tracks the screen aspect but is floored at 1920 (`PortraitLayout`'s
 * REFERENCE_H, a hard floor: 70 top HUD + 18×84 board + 70 bottom HUD + 268 hand = exactly 1920),
 * so screens *squatter* than 9:16 — every iPad — contain to width and leave side bands: 256px each
 * side on a 12.9" (25% of the panel), 107px on a mini. Phones are unaffected (0 on all of them).
 *
 * Rather than leave those bands as flat dead paper, they get painted as the desk the notebook page
 * is lying on: a kraft-toned surface, a faint grain, and a soft shadow + ink edge along the page
 * boundary. That is the game's own diegetic frame (art-direction.md §〇 — the whole game happens on
 * this notebook), so a centred page on a desk reads as intended instead of as an unfinished port.
 * Nothing inside the design rect moves, so this carries no layout risk; a real iPad layout (letting
 * portrait's design width stretch the way LandscapeLayout's does) is the separate, much riskier
 * option — see design/product/release/store-assets-checklist.md §0.6.
 */
const DESK_FILL  = 0xded3bd; // kraft/manila, a step warmer and darker than ui.paper (0xfaf6ee)
const DESK_GRAIN = 0xc9bda4;
const PAGE_EDGE  = 0x2c2c2a; // ui.dark

export class ScalingManager {
  /**
   * Desk surround behind the page, in SCREEN space (scale 1, origin 0,0) — it has to be screen
   * space because it frames `gameLayer`'s post-scale rect, which no design-space layer can align to
   * (bgLayer is Cover-scaled, gameLayer Contain-scaled — different factors whenever bands exist).
   * Empty and hidden when the game fills the screen, i.e. on every phone.
   */
  readonly deskLayer: PIXI.Graphics;
  /** Background layer (Cover scale — fills screen, may clip). */
  readonly bgLayer:   PIXI.Container;
  /** Game content layer (Contain scale — fully visible, may letterbox). */
  readonly gameLayer: PIXI.Container;

  private layout: ILayout;
  private insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(
    private readonly app: PIXI.Application,
    layout: ILayout,
    insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 },
  ) {
    this.layout    = layout;
    this.insets    = insets;
    this.deskLayer = new PIXI.Graphics();
    this.bgLayer   = new PIXI.Container();
    this.gameLayer = new PIXI.Container();

    // Bottom-most: the page's own paper background covers the design rect anyway, so the desk only
    // ever shows through the bands.
    app.stage.addChild(this.deskLayer);
    app.stage.addChild(this.bgLayer);
    app.stage.addChild(this.gameLayer);

    const { width, height } = app.screen;
    this.applyScaling(width, height);
  }

  /** Update the layout and recalculate scaling. Call on orientation change or resize. */
  resize(screenW: number, screenH: number, newLayout: ILayout, insets?: SafeAreaInsets): void {
    this.layout = newLayout;
    if (insets) this.insets = insets;
    this.applyScaling(screenW, screenH);
  }

  /** Convert screen (CSS pixel) coordinates to design-space coordinates. */
  toDesignSpace(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.gameLayer.x) / this.gameLayer.scale.x,
      y: (screenY - this.gameLayer.y) / this.gameLayer.scale.y,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private applyScaling(screenW: number, screenH: number): void {
    const dw = this.layout.designWidth;
    const dh = this.layout.designHeight;

    // Safe drawable area = screen minus notch / home-indicator insets. The game
    // layer is contained within it, so no UI lands under the notch/home indicator.
    const { top, right, bottom, left } = this.insets;
    const availX = left;
    const availY = top;
    const availW = Math.max(1, screenW - left - right);
    const availH = Math.max(1, screenH - top - bottom);

    // Contain within the safe area. Because the portrait design height tracks the
    // safe-area aspect, this fits to width with no letterbox on tall phones.
    const gameScale = Math.min(availW / dw, availH / dh);
    this.gameLayer.scale.set(gameScale);
    this.gameLayer.x = Math.round(availX + (availW - dw * gameScale) / 2);
    this.gameLayer.y = Math.round(availY + (availH - dh * gameScale) / 2);

    // Cover: fill the ENTIRE screen (including the inset bands) so the notch /
    // home-indicator margins show background rather than a hard edge.
    const bgScale = Math.max(screenW / dw, screenH / dh);
    this.bgLayer.scale.set(bgScale);
    this.bgLayer.x = Math.round((screenW - dw * bgScale) / 2);
    this.bgLayer.y = Math.round((screenH - dh * bgScale) / 2);

    drawDeskSurround(
      this.deskLayer, screenW, screenH,
      this.gameLayer.x, this.gameLayer.y, dw * gameScale, dh * gameScale,
    );
  }
}

/**
 * Paint the desk surround into the letterbox bands and shade the page's edge, in screen space.
 * `pageX/Y/W/H` is the game layer's on-screen rect. Returns whether anything was drawn — a band
 * under 2px is a rounding artefact rather than a visible margin, so phones (which have none at all)
 * draw and composite nothing. Exported for the regression test; ScalingManager is the only caller.
 */
export function drawDeskSurround(
  g: PIXI.Graphics,
  screenW: number, screenH: number,
  pageX: number, pageY: number, pageW: number, pageH: number,
): boolean {
  g.clear();
  const bandX = Math.max(0, pageX);
  const bandY = Math.max(0, pageY);
  g.visible = bandX >= 2 || bandY >= 2;
  if (!g.visible) return false;

  g.beginFill(DESK_FILL).drawRect(0, 0, screenW, screenH).endFill();

  // Faint grain over the bands (the page covers the middle): long strokes at a shallow angle,
  // spaced by band width so the density reads the same on a mini as on a 12.9".
  const step = Math.max(18, Math.round(Math.max(bandX, bandY) / 6));
  g.lineStyle(1, DESK_GRAIN, 0.5);
  for (let y = -screenW; y < screenH + screenW; y += step) {
    g.moveTo(0, y);
    g.lineTo(screenW, y + Math.round(screenW * 0.12));
  }
  g.lineStyle(0);

  // Page shadow: nested rects stepping outward at falling alpha — a soft edge without a blur
  // filter, since this redraws on every resize and must stay trivial.
  const spreadStep = Math.max(2, Math.round(Math.min(bandX || 24, 24) / 3));
  for (let i = 7; i >= 1; i--) {
    const spread = i * spreadStep;
    g.beginFill(PAGE_EDGE, 0.035);
    g.drawRect(pageX - spread, pageY - spread + spread * 0.35, pageW + spread * 2, pageH + spread * 2);
    g.endFill();
  }
  // Ink edge, so the page reads as a sheet with a boundary rather than a lighting gradient.
  g.lineStyle(2, PAGE_EDGE, 0.35);
  g.drawRect(pageX, pageY, pageW, pageH);
  g.lineStyle(0);
  return true;
}
