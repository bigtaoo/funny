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
  if (orient === 'landscape') return new LandscapeLayout(localSide);
  // Portrait design height follows the *safe* drawable area so the game fills the
  // notch-free region without letterbox (ScalingManager offsets the layer to match).
  const availW = Math.max(1, screenW - insets.left - insets.right);
  const availH = Math.max(1, screenH - insets.top - insets.bottom);
  return new PortraitLayout(availW, availH, localSide);
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
export class ScalingManager {
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
    this.bgLayer   = new PIXI.Container();
    this.gameLayer = new PIXI.Container();

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
  }
}
