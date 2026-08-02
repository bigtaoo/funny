// Camera state — the on-screen tile width (`tp`, the sole zoom knob) plus the world-space pan
// offset, and all the math that reads them. Split out of index.ts (2026-08-02): `tp`/`panX`/`panY`
// were three module-level `let`s with ~40 read/write sites scattered through the entry point, which
// is what blocked splitting the file any further.
//
// Deliberately free of PIXI and DOM so it can be unit-tested directly (test/camera.test.ts): the
// stage sync (`worldLayer.position`) is an `onChange` hook the render layer installs at boot rather
// than a write baked into clampPan().
import { SLG_MAP_H, SLG_MAP_W } from '@nw/shared/slg';
import { DEFAULT_TP, VIEW_H, VIEW_W, ZOOM_MAX, ZOOM_MIN } from '../constants';
import { screenToTile, screenToTileF, tileToScreen, visibleTileBounds } from '../render/isoGrid';
import type { TilePoint } from './terrainGrid';

export interface ScreenPoint {
  sx: number;
  sy: number;
}

export class Camera {
  /** On-screen tile width in px — the sole "zoom" knob. Visible cell count ∝ tp⁻²; the default is
   * synced to the game client's L1 detail density (VIEW_W/11) so the editor's tile count matches
   * what players see, not ~2× more. */
  tp = DEFAULT_TP;
  panX = 0;
  panY = 0;

  /** Fired after any pan/zoom change so the render layer can sync `worldLayer.position`. A hook
   * rather than a direct PIXI write, so this class stays pure and testable. */
  onChange: (() => void) | null = null;

  /**
   * Keeps the projected map inside the viewport: when the map is smaller than the view on an axis
   * it is centered on that axis, otherwise the pan is clamped so no blank space shows past an edge.
   */
  clampPan(): void {
    const corners = [
      tileToScreen(0, 0, this.tp), tileToScreen(SLG_MAP_W, 0, this.tp),
      tileToScreen(0, SLG_MAP_H, this.tp), tileToScreen(SLG_MAP_W, SLG_MAP_H, this.tp),
    ];
    const minSx = Math.min(...corners.map((c) => c.x));
    const maxSx = Math.max(...corners.map((c) => c.x));
    const minSy = Math.min(...corners.map((c) => c.y));
    const maxSy = Math.max(...corners.map((c) => c.y));
    this.panX = maxSx - minSx <= VIEW_W ? VIEW_W / 2 - (minSx + maxSx) / 2 : Math.min(-minSx, Math.max(VIEW_W - maxSx, this.panX));
    this.panY = maxSy - minSy <= VIEW_H ? VIEW_H / 2 - (minSy + maxSy) / 2 : Math.min(-minSy, Math.max(VIEW_H - maxSy, this.panY));
    this.onChange?.();
  }

  /** Drag-pan by a screen-space delta (already clamped on the way out). */
  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
  }

  /** Puts the map's midpoint at the middle of the viewport. */
  centerOnMap(): void {
    const s = tileToScreen(SLG_MAP_W / 2, SLG_MAP_H / 2, this.tp);
    this.panX = VIEW_W / 2 - s.x;
    this.panY = VIEW_H / 2 - s.y;
    this.clampPan();
  }

  /**
   * Zooms to `nextTp` (clamped to [ZOOM_MIN, ZOOM_MAX] and rounded), keeping the tile currently
   * under `anchor` — the cursor for a wheel gesture, the viewport center otherwise — pinned in
   * place. Returns false and changes nothing when the clamped target equals the current zoom, so
   * callers can skip a full viewport rebuild.
   */
  setZoom(nextTp: number, anchor?: ScreenPoint): boolean {
    const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(nextTp)));
    if (target === this.tp) return false;
    const ax = anchor?.sx ?? VIEW_W / 2;
    const ay = anchor?.sy ?? VIEW_H / 2;
    const frac = screenToTileF(ax - this.panX, ay - this.panY, this.tp);
    this.tp = target;
    const s = tileToScreen(frac.x, frac.y, this.tp);
    this.panX = ax - s.x;
    this.panY = ay - s.y;
    this.clampPan();
    return true;
  }

  /** Screen position (viewport coordinates, pan included) of tile (tx, ty)'s center. */
  screenOf(tx: number, ty: number): { x: number; y: number } {
    const s = tileToScreen(tx, ty, this.tp);
    return { x: s.x + this.panX, y: s.y + this.panY };
  }

  /** Pan-relative screen offset of tile (tx, ty) — what the PIXI layers, which carry the pan on
   * `worldLayer.position`, actually want. */
  layerOf(tx: number, ty: number): { x: number; y: number } {
    return tileToScreen(tx, ty, this.tp);
  }

  /** The tile under a viewport-space point, clamped into the map. */
  tileAt(sx: number, sy: number): TilePoint {
    const t = screenToTile(sx - this.panX, sy - this.panY, this.tp);
    return {
      x: Math.max(0, Math.min(SLG_MAP_W - 1, t.x)),
      y: Math.max(0, Math.min(SLG_MAP_H - 1, t.y)),
    };
  }

  /**
   * Tile range to render, in map bounds. Covers a viewport grown by VIEW_PAD_FACTOR so short pans
   * don't reveal blank space before the next render lands.
   */
  visibleRange(padFactor: number): { x0: number; x1: number; y0: number; y1: number } {
    const padW = VIEW_W * padFactor;
    const padH = VIEW_H * padFactor;
    const b = visibleTileBounds(padW, padH, this.panX + (padW - VIEW_W) / 2, this.panY + (padH - VIEW_H) / 2, this.tp);
    return {
      x0: Math.max(0, b.minTx),
      x1: Math.min(SLG_MAP_W - 1, b.maxTx),
      y0: Math.max(0, b.minTy),
      y1: Math.min(SLG_MAP_H - 1, b.maxTy),
    };
  }
}
