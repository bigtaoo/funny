import * as PIXI from 'pixi.js-legacy';
import { ILayout } from './ILayout';
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
 * MVP: always creates Side.Bottom layout.
 */
export function createLayout(screenW: number, screenH: number): ILayout {
  const orient = detectOrientation(screenW, screenH);
  return orient === 'landscape'
    ? new LandscapeLayout(Side.Bottom)
    : new PortraitLayout(Side.Bottom);
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

  constructor(
    private readonly app: PIXI.Application,
    layout: ILayout,
  ) {
    this.layout    = layout;
    this.bgLayer   = new PIXI.Container();
    this.gameLayer = new PIXI.Container();

    app.stage.addChild(this.bgLayer);
    app.stage.addChild(this.gameLayer);

    const { width, height } = app.screen;
    this.applyScaling(width, height);
  }

  /** Update the layout and recalculate scaling. Call on orientation change or resize. */
  resize(screenW: number, screenH: number, newLayout: ILayout): void {
    this.layout = newLayout;
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

    // Contain: fit the design space fully within the screen
    const gameScale = Math.min(screenW / dw, screenH / dh);
    this.gameLayer.scale.set(gameScale);
    this.gameLayer.x = Math.round((screenW - dw * gameScale) / 2);
    this.gameLayer.y = Math.round((screenH - dh * gameScale) / 2);

    // Cover: fill the screen (may clip design edges)
    const bgScale = Math.max(screenW / dw, screenH / dh);
    this.bgLayer.scale.set(bgScale);
    this.bgLayer.x = Math.round((screenW - dw * bgScale) / 2);
    this.bgLayer.y = Math.round((screenH - dh * bgScale) / 2);
  }
}
