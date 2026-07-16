// Base-damage vignette (D-CITY-8): a screen-edge red flash when the player's own main-base
// durability is deducted by a settled siege hit (WorldMapNet.applyTileUpdate detects the hp
// drop and calls flashDamageVignette). Mirrors the battle scene's vignette (GameRenderer/events.ts)
// — same layered-border-strip technique and fade curve, adapted to the world map's screen size.
import * as PIXI from 'pixi.js-legacy';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

const VIGNETTE_FADE = 0.55; // seconds to fully fade out — matches the battle scene's feel

export interface VignetteHandlers {
  flashDamageVignette(): void;
  drawVignette(): void;
  updateVignette(dt: number): void;
}

export function VignetteMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<VignetteHandlers> {
  return class extends Base {
    flashDamageVignette(): void {
      this.ctx.vignetteAlpha = 1.0;
      this.drawVignette();
    }

    updateVignette(dt: number): void {
      if (this.ctx.vignetteAlpha <= 0) return;
      this.ctx.vignetteAlpha = Math.max(0, this.ctx.vignetteAlpha - dt / VIGNETTE_FADE);
      this.drawVignette();
    }

    drawVignette(): void {
      const g = this.ctx.vignetteGfx;
      g.clear();
      if (this.ctx.vignetteAlpha <= 0) return;

      const W = this.ctx.w;
      const H = this.ctx.h;
      const color = 0xcc0000;

      // Simulate radial vignette with layered border strips: each layer thinner and more
      // opaque, stacking toward the screen edge.
      const N = 12;
      const maxW     = 140;
      const maxAlpha = 0.09;

      g.alpha = this.ctx.vignetteAlpha;
      for (let i = 0; i < N; i++) {
        // t=0 → innermost (narrow, faint); t=1 → outermost (wide, opaque)
        const t     = (N - 1 - i) / (N - 1);
        const w     = Math.round(maxW * (t * 0.7 + 0.3)); // range: 0.3–1.0 × maxW
        const alpha = maxAlpha * (t * 0.6 + 0.1);         // range: 0.1–0.7 × maxAlpha
        g.beginFill(color, alpha);
        g.drawRect(0,     0,     W, w);
        g.drawRect(0,     H - w, W, w);
        g.drawRect(0,     0,     w, H);
        g.drawRect(W - w, 0,     w, H);
        g.endFill();
      }
    }
  };
}
