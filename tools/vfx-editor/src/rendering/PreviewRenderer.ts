/**
 * PreviewRenderer.ts — PixiJS preview that paints the effect via the game's own
 * interpret() (single source of truth, DESIGN §8). Same pixi.js-legacy as the
 * game so the on-screen result is what the runtime draws.
 *
 * The renderer owns a centered Graphics; each frame the caller passes (def, t,
 * color, seed) and we clear + interpret into it. A faint grid/crosshair marks
 * the origin; an optional reference-unit silhouette gauges relative scale.
 */
import * as PIXI from 'pixi.js-legacy';
import { interpret } from '@vfx/interpret';
import { EffectDef } from '@vfx/types';

const REF_UNIT_R = 14; // ~28px footprint, the game's unit scale

export class PreviewRenderer {
  private app: PIXI.Application;
  private stageRoot: PIXI.Container;
  private grid: PIXI.Graphics;
  private refUnit: PIXI.Graphics;
  private fx: PIXI.Graphics;
  private ro: ResizeObserver;

  constructor(private readonly mount: HTMLElement) {
    this.app = new PIXI.Application({
      backgroundColor: 0x0e0e18,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: mount.clientWidth || 600,
      height: mount.clientHeight || 400,
    });
    mount.appendChild(this.app.view as unknown as HTMLCanvasElement);

    this.stageRoot = new PIXI.Container();
    this.app.stage.addChild(this.stageRoot);

    this.grid = new PIXI.Graphics();
    this.refUnit = new PIXI.Graphics();
    this.refUnit.visible = false;
    this.fx = new PIXI.Graphics();
    this.stageRoot.addChild(this.grid, this.refUnit, this.fx);

    this.layout();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(mount);
  }

  /** Re-center everything and redraw the static grid for the current size. */
  private layout(): void {
    const w = this.mount.clientWidth || 600;
    const h = this.mount.clientHeight || 400;
    this.app.renderer.resize(w, h);
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    this.stageRoot.position.set(cx, cy);

    this.grid.clear();
    // Concentric reference rings every 25px + axis crosshair.
    this.grid.lineStyle(1, 0x2a2a40, 1);
    for (let r = 25; r <= Math.max(w, h); r += 25) this.grid.drawCircle(0, 0, r);
    this.grid.lineStyle(1, 0x3a3a58, 1);
    this.grid.moveTo(-w, 0); this.grid.lineTo(w, 0);
    this.grid.moveTo(0, -h); this.grid.lineTo(0, h);

    this.refUnit.clear();
    this.refUnit.lineStyle(1.5, 0x6e6e8a, 0.8);
    this.refUnit.drawCircle(0, 0, REF_UNIT_R);
    this.refUnit.moveTo(0, -REF_UNIT_R); this.refUnit.lineTo(0, -REF_UNIT_R - 6);
  }

  setReferenceUnit(on: boolean): void { this.refUnit.visible = on; }

  /** Paint one frame. t already clamped/wrapped by the caller. */
  render(def: EffectDef | null, t: number, color: number, seed: number): void {
    this.fx.clear();
    if (!def) return;
    interpret(def.layers, Math.min(1, Math.max(0, t)), this.fx, color, seed);
  }

  destroy(): void {
    this.ro.disconnect();
    this.app.destroy(true);
  }
}
