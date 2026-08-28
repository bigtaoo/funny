// View transforms: viewport tile bounds, zoom level switching (center-stable), camera centering,
// isometric pan clamping, and screen→tile hit conversion.
import { tileToScreen, screenToTile, screenToTileF, visibleTileBounds } from '../../../render/isoGrid';
import { HUD_H } from '../logic/constants';
import type { WorldMapRendererCore } from './core';
import type { WorldMapRendererPool } from './pool';

export interface ViewportHandlers {
  viewportCenter(): { cx: number; cy: number; r: number };
  setZoom(z: 1 | 2 | 3): void;
  centerAt(tx: number, ty: number): void;
  clampPan(): void;
  screenToTile(sx: number, sy: number): { x: number; y: number };
}

export class WorldMapRendererViewport implements ViewportHandlers {
  constructor(
    private readonly core: WorldMapRendererCore,
    private readonly pool: WorldMapRendererPool,
    /** Full pool+city+overlay refresh (WorldMapRenderer.invalidatePool()) — setZoom() needs it
     *  after rebuilding the pool, same as the pre-conversion `this.invalidatePool()` mixin call did. */
    private readonly refreshMap: () => void,
  ) {}

  viewportCenter(): { cx: number; cy: number; r: number } {
    const ctx = this.core.ctx;
    const tp = ctx.tp;
    const b = visibleTileBounds(ctx.w, ctx.h - HUD_H - ctx.topInset, ctx.panX, ctx.panY - ctx.topInset, tp);
    const cx = Math.floor((b.minTx + b.maxTx) / 2);
    const cy = Math.floor((b.minTy + b.maxTy) / 2);
    const r  = Math.ceil(Math.max(b.maxTx - b.minTx, b.maxTy - b.minTy) / 2) + 4;
    return { cx: Math.max(0, Math.min(ctx.mapW - 1, cx)), cy: Math.max(0, Math.min(ctx.mapH - 1, cy)), r };
  }

  setZoom(z: 1 | 2 | 3): void {
    const ctx = this.core.ctx;
    if (ctx.zoom === z) return;
    // Keep map center stable across zoom levels: read which (fractional) tile is
    // under the screen center under the old projection, then re-pan so that same
    // tile lands on screen center under the new tile size.
    const oldTp = ctx.tp;
    const screenCx = ctx.w / 2;
    const screenCy = (ctx.topInset + ctx.h - HUD_H) / 2;
    const frac = screenToTileF(screenCx - ctx.panX, screenCy - ctx.panY, oldTp);
    ctx.zoom = z;
    const newCenterScreen = tileToScreen(frac.x, frac.y, ctx.tp);
    ctx.panX = screenCx - newCenterScreen.x;
    ctx.panY = screenCy - newCenterScreen.y;
    this.clampPan();
    this.pool.buildPool();
    this.refreshMap();
    ctx.panels.renderHud();
    // After switching zoom, re-fetch viewport data at the new LOD (different levels require different endpoints / field sets)
    void ctx.net.loadMapViewport();
  }

  centerAt(tx: number, ty: number): void {
    const ctx = this.core.ctx;
    const tp = ctx.tp;
    const s = tileToScreen(tx, ty, tp);
    ctx.panX = ctx.w / 2 - s.x;
    ctx.panY = (ctx.topInset + ctx.h - HUD_H) / 2 - s.y;
    this.clampPan();
  }

  /**
   * Isometric pan bounds. The map's four corners (0,0)/(mapW,0)/(0,mapH)/(mapW,mapH)
   * project to a diamond in screen space whose axis-aligned bounding box is what pan
   * must stay within (plus a small buffer) — replaces the old orthogonal `mapW*tp`
   * bound, which under-constrained panning once tiles stopped being axis-aligned squares.
   */
  clampPan(): void {
    const ctx = this.core.ctx;
    const tp = ctx.tp;
    // Visible band is [topInset, h - HUD_H] — the header bar reserves topInset at the top,
    // same as HUD_H at the bottom.
    const top = ctx.topInset;
    const bottom = ctx.h - HUD_H;
    const bandH = bottom - top;
    const corners = [
      tileToScreen(0, 0, tp), tileToScreen(ctx.mapW, 0, tp),
      tileToScreen(0, ctx.mapH, tp), tileToScreen(ctx.mapW, ctx.mapH, tp),
    ];
    const minSx = Math.min(...corners.map((c) => c.x));
    const maxSx = Math.max(...corners.map((c) => c.x));
    const minSy = Math.min(...corners.map((c) => c.y));
    const maxSy = Math.max(...corners.map((c) => c.y));
    // Keep the viewport inside the map — no buffer past the edge (the camera should not
    // leave the map). When the map's projected span is smaller than the viewport on an axis,
    // there is nowhere to pan to, so lock it centered instead of letting it drift off-screen.
    if (maxSx - minSx <= ctx.w) {
      ctx.panX = ctx.w / 2 - (minSx + maxSx) / 2;
    } else {
      ctx.panX = Math.min(-minSx, Math.max(ctx.w - maxSx, ctx.panX));
    }
    if (maxSy - minSy <= bandH) {
      ctx.panY = top + bandH / 2 - (minSy + maxSy) / 2;
    } else {
      ctx.panY = Math.min(top - minSy, Math.max(bottom - maxSy, ctx.panY));
    }
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    const ctx = this.core.ctx;
    return screenToTile(sx - ctx.panX, sy - ctx.panY, ctx.tp);
  }
}
