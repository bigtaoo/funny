// View transforms: viewport tile bounds, zoom level switching (center-stable), camera centering,
// isometric pan clamping, and screen→tile hit conversion.
import { tileToScreen, screenToTile, screenToTileF, visibleTileBounds } from '../../../render/isoGrid';
import { HUD_H } from '../constants';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface ViewportHandlers {
  viewportCenter(): { cx: number; cy: number; r: number };
  setZoom(z: 1 | 2 | 3): void;
  centerAt(tx: number, ty: number): void;
  clampPan(): void;
  screenToTile(sx: number, sy: number): { x: number; y: number };
}

export function ViewportMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<ViewportHandlers> {
  return class extends Base {
    viewportCenter(): { cx: number; cy: number; r: number } {
      const tp = this.ctx.tp;
      const b = visibleTileBounds(this.ctx.w, this.ctx.h - HUD_H - this.ctx.topInset, this.ctx.panX, this.ctx.panY - this.ctx.topInset, tp);
      const cx = Math.floor((b.minTx + b.maxTx) / 2);
      const cy = Math.floor((b.minTy + b.maxTy) / 2);
      const r  = Math.ceil(Math.max(b.maxTx - b.minTx, b.maxTy - b.minTy) / 2) + 4;
      return { cx: Math.max(0, Math.min(this.ctx.mapW - 1, cx)), cy: Math.max(0, Math.min(this.ctx.mapH - 1, cy)), r };
    }

    setZoom(z: 1 | 2 | 3): void {
      if (this.ctx.zoom === z) return;
      // Keep map center stable across zoom levels: read which (fractional) tile is
      // under the screen center under the old projection, then re-pan so that same
      // tile lands on screen center under the new tile size.
      const oldTp = this.ctx.tp;
      const screenCx = this.ctx.w / 2;
      const screenCy = (this.ctx.topInset + this.ctx.h - HUD_H) / 2;
      const frac = screenToTileF(screenCx - this.ctx.panX, screenCy - this.ctx.panY, oldTp);
      this.ctx.zoom = z;
      const newCenterScreen = tileToScreen(frac.x, frac.y, this.ctx.tp);
      this.ctx.panX = screenCx - newCenterScreen.x;
      this.ctx.panY = screenCy - newCenterScreen.y;
      this.clampPan();
      this.buildPool();
      this.invalidatePool();
      this.ctx.panels.renderHud();
      // After switching zoom, re-fetch viewport data at the new LOD (different levels require different endpoints / field sets)
      void this.ctx.net.loadMapViewport();
    }

    centerAt(tx: number, ty: number): void {
      const tp = this.ctx.tp;
      const s = tileToScreen(tx, ty, tp);
      this.ctx.panX = this.ctx.w / 2 - s.x;
      this.ctx.panY = (this.ctx.topInset + this.ctx.h - HUD_H) / 2 - s.y;
      this.clampPan();
    }

    /**
     * Isometric pan bounds. The map's four corners (0,0)/(mapW,0)/(0,mapH)/(mapW,mapH)
     * project to a diamond in screen space whose axis-aligned bounding box is what pan
     * must stay within (plus a small buffer) — replaces the old orthogonal `mapW*tp`
     * bound, which under-constrained panning once tiles stopped being axis-aligned squares.
     */
    clampPan(): void {
      const tp = this.ctx.tp;
      // Visible band is [topInset, h - HUD_H] — the header bar reserves topInset at the top,
      // same as HUD_H at the bottom.
      const top = this.ctx.topInset;
      const bottom = this.ctx.h - HUD_H;
      const bandH = bottom - top;
      const corners = [
        tileToScreen(0, 0, tp), tileToScreen(this.ctx.mapW, 0, tp),
        tileToScreen(0, this.ctx.mapH, tp), tileToScreen(this.ctx.mapW, this.ctx.mapH, tp),
      ];
      const minSx = Math.min(...corners.map((c) => c.x));
      const maxSx = Math.max(...corners.map((c) => c.x));
      const minSy = Math.min(...corners.map((c) => c.y));
      const maxSy = Math.max(...corners.map((c) => c.y));
      // Keep the viewport inside the map — no buffer past the edge (the camera should not
      // leave the map). When the map's projected span is smaller than the viewport on an axis,
      // there is nowhere to pan to, so lock it centered instead of letting it drift off-screen.
      if (maxSx - minSx <= this.ctx.w) {
        this.ctx.panX = this.ctx.w / 2 - (minSx + maxSx) / 2;
      } else {
        this.ctx.panX = Math.min(-minSx, Math.max(this.ctx.w - maxSx, this.ctx.panX));
      }
      if (maxSy - minSy <= bandH) {
        this.ctx.panY = top + bandH / 2 - (minSy + maxSy) / 2;
      } else {
        this.ctx.panY = Math.min(top - minSy, Math.max(bottom - maxSy, this.ctx.panY));
      }
    }

    screenToTile(sx: number, sy: number): { x: number; y: number } {
      return screenToTile(sx - this.ctx.panX, sy - this.ctx.panY, this.ctx.tp);
    }
  };
}
