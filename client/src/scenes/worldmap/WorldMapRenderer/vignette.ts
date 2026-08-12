// Base-damage vignette (D-CITY-8): a screen-edge red flash when the player's own main-base
// durability is deducted by a settled siege hit (WorldMapNet.applyTileUpdate detects the hp
// drop and calls flashDamageVignette). Mirrors the battle scene's vignette (GameRenderer/events.ts)
// — same layered-border-strip technique and fade curve, adapted to the world map's screen size.
import type { WorldMapRendererCore } from './core';

const VIGNETTE_FADE = 0.55; // seconds to fully fade out — matches the battle scene's feel

export interface VignetteHandlers {
  flashDamageVignette(): void;
  drawVignette(): void;
  updateVignette(dt: number): void;
}

export class WorldMapRendererVignette implements VignetteHandlers {
  constructor(private readonly core: WorldMapRendererCore) {}

  flashDamageVignette(): void {
    this.core.ctx.vignetteAlpha = 1.0;
    this.drawVignette();
  }

  updateVignette(dt: number): void {
    if (this.core.ctx.vignetteAlpha <= 0) return;
    this.core.ctx.vignetteAlpha = Math.max(0, this.core.ctx.vignetteAlpha - dt / VIGNETTE_FADE);
    this.drawVignette();
  }

  drawVignette(): void {
    const ctx = this.core.ctx;
    const g = ctx.vignetteGfx;
    g.clear();
    if (ctx.vignetteAlpha <= 0) return;

    const W = ctx.w;
    const H = ctx.h;
    const color = 0xcc0000;

    // Simulate radial vignette with layered border strips: each layer thinner and more
    // opaque, stacking toward the screen edge.
    const N = 12;
    const maxW     = 140;
    const maxAlpha = 0.09;

    g.alpha = ctx.vignetteAlpha;
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
}
