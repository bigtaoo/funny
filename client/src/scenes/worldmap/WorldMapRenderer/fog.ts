// Overlay stack drawn above the tile pool: the L3 batched overview, the off-map cloud/mist veil,
// and the interactive overlay (selected-tile highlight, capital stars, march arrows).
import { ISO_RATIO, tileToScreen, diamondPath, visibleTileBounds, clipConvexToRect } from '../../../render/isoGrid';
import { HUD_H } from '../constants';
import { ENEMY_BASE_TINT, CLOUD_COLOR, tileColor, proceduralTileColor } from '../tileStyle';
import { drawStar } from '../tileGraphics';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface FogHandlers {
  renderMapL3(): void;
  renderFog(): void;
  renderOverlay(): void;
  renderMap(): void;
}

export function FogMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<FogHandlers> {
  return class extends Base {
    renderMapL3(): void {
      this.ctx.l3Dirty = false;
      const g = this.ctx.mapGfxL3;
      g.clear();
      const tp = 20;
      const { w, h, panX, panY } = this.ctx;
      const mapH = h - HUD_H;
      const b = visibleTileBounds(w, mapH, panX, panY, tp);

      // Group tiles by fill color for batched rendering (coords = each tile's diamond center).
      const groups = new Map<number, number[]>(); // color → [cx,cy, cx,cy, ...]
      for (let ty = Math.max(0, b.minTy); ty <= Math.min(this.ctx.mapH - 1, b.maxTy); ty++) {
        for (let tx = Math.max(0, b.minTx); tx <= Math.min(this.ctx.mapW - 1, b.maxTx); tx++) {
          const tile = this.ctx.tileCache.get(`${tx}:${ty}`);
          let color = tile ? tileColor(tile) : proceduralTileColor(this.ctx.cb.worldId, tx, ty);
          if (tile?.visible === false) color = (color & 0x7f7f7f) | 0x404040; // darken fogged
          if (!groups.has(color)) groups.set(color, []);
          const s = tileToScreen(tx, ty, tp);
          groups.get(color)!.push(panX + s.x, panY + s.y);
        }
      }
      const diamond = diamondPath(tp - 1);
      for (const [color, coords] of groups) {
        g.lineStyle(0);
        g.beginFill(color, 0.88);
        for (let i = 0; i < coords.length; i += 2) {
          const cx = coords[i]!, cy = coords[i + 1]!;
          const pts: number[] = new Array(diamond.length);
          for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
          g.drawPolygon(pts);
        }
        g.endFill();
      }
    }

    /**
     * Cloud/mist veil over everything outside the map's tile area. The map's tile rectangle
     * (0..mapW-1 × 0..mapH-1) projects to a screen-space parallelogram; we fill the whole
     * viewport with cloud and punch that parallelogram out as a hole, then lay a soft thick
     * stroke along its edge so the map fades into mist rather than ending on a hard diamond.
     * Redrawn from renderOverlay(), which fires on every pan / zoom / data change.
     *
     * The map is up to 1500×1500, so the projected parallelogram is enormous — its outer
     * vertices sit hundreds of thousands of px past the viewport. Feeding that raw polygon
     * to beginHole() makes PIXI's earcut hole triangulation fail, leaving the cloud rect a
     * solid fill that blanks the whole map (the "SLG map went blank" regression). So we first
     * clip the parallelogram to the viewport rect: the hole then has bounded coordinates, and
     * when the map fully covers the viewport (camera centered on a big map) the clip collapses
     * to the rect itself → hole == fill → no veil shows, exactly as intended.
     */
    renderFog(): void {
      const g = this.ctx.fogGfx;
      g.clear();
      const tp = this.ctx.tp;
      const mapViewH = this.ctx.h - HUD_H;
      const hw = tp / 2;
      const hh = (tp * ISO_RATIO) / 2;
      const px = this.ctx.panX;
      const py = this.ctx.panY;
      // Outer vertices of the tile-area parallelogram (extreme corner tiles' outer diamond points).
      const top    = tileToScreen(0, 0, tp);
      const right  = tileToScreen(this.ctx.mapW - 1, 0, tp);
      const bottom = tileToScreen(this.ctx.mapW - 1, this.ctx.mapH - 1, tp);
      const left   = tileToScreen(0, this.ctx.mapH - 1, tp);
      const holePts = [
        { x: px + top.x,        y: py + top.y - hh },
        { x: px + right.x + hw, y: py + right.y },
        { x: px + bottom.x,     y: py + bottom.y + hh },
        { x: px + left.x - hw,  y: py + left.y },
      ];
      const clipped = clipConvexToRect(holePts, this.ctx.w, mapViewH);
      g.beginFill(CLOUD_COLOR, 0.97);
      g.drawRect(0, 0, this.ctx.w, mapViewH);
      // Only punch a hole when the map actually intersects the viewport; a degenerate clip
      // (< 3 vertices) means the map is entirely off-screen, so the veil covers everything.
      if (clipped.length >= 3) {
        const flat: number[] = [];
        for (const p of clipped) { flat.push(p.x, p.y); }
        g.beginHole();
        g.drawPolygon(flat);
        g.endHole();
      }
      g.endFill();
      // Misty rim: a soft thick stroke along the true map boundary (the un-clipped parallelogram,
      // so the stroke follows real map edges; the mapClip mask trims whatever falls off-screen).
      const hole = [holePts[0]!.x, holePts[0]!.y, holePts[1]!.x, holePts[1]!.y, holePts[2]!.x, holePts[2]!.y, holePts[3]!.x, holePts[3]!.y];
      g.lineStyle(Math.max(6, tp * 0.55), CLOUD_COLOR, 0.4);
      g.drawPolygon(hole);
      g.lineStyle(Math.max(3, tp * 0.22), CLOUD_COLOR, 0.55);
      g.drawPolygon(hole);
      g.lineStyle(0);
    }

    renderOverlay(): void {
      this.renderFog();
      const g = this.ctx.overlayGfx;
      g.clear();
      const tp = this.ctx.tp;

      // Selected tile highlight — diamond outline centered on the tile (was a square
      // anchored at its top-left corner; tileToScreen gives the diamond center instead).
      if (this.ctx.selectedTile) {
        const { x: tx, y: ty } = this.ctx.selectedTile;
        const s = tileToScreen(tx, ty, tp);
        const cx = this.ctx.panX + s.x;
        const cy = this.ctx.panY + s.y;
        const pts = diamondPath(tp).map((v, i) => v + (i % 2 === 0 ? cx : cy));
        g.lineStyle(2, 0xffcc00, 1);
        g.beginFill(0xffff00, 0.15);
        g.drawPolygon(pts);
        g.endFill();
      }

      // Capital star markers (10 nations).
      const starR = Math.max(6, tp * 0.45);
      for (const n of this.ctx.nations) {
        const s = tileToScreen(n.x, n.y, tp);
        const cx = this.ctx.panX + s.x;
        const cy = this.ctx.panY + s.y;
        if (cx < -tp || cy < -tp || cx > this.ctx.w + tp || cy > this.ctx.h - HUD_H + tp) continue;
        drawStar(g, cx, cy, starR, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
      }

      // March arrows (L1/L2 only; L3 is too zoomed-out for detail).
      if (this.ctx.zoom < 3) {
        const now = Date.now();
        for (const march of this.ctx.marches) {
          const fromXY = this.ctx.parseTileStrict(march.fromTile);
          const toXY = this.ctx.parseTileStrict(march.toTile);
          if (!fromXY || !toXY) continue; // skip malformed/out-of-bounds endpoints (no origin-crossing stray line)
          const [fx, fy] = fromXY;
          const [tx2, ty2] = toXY;
          const from = tileToScreen(fx, fy, tp);
          const to = tileToScreen(tx2, ty2, tp);
          const fpx = this.ctx.panX + from.x;
          const fpy = this.ctx.panY + from.y;
          const px  = this.ctx.panX + to.x;
          const py  = this.ctx.panY + to.y;
          const enemy = march.mine === false;
          const col = enemy ? ENEMY_BASE_TINT
            : march.kind === 'return'   ? 0x44cc88
            : march.kind === 'attack'   ? 0xcc3333
            : march.kind === 'reinforce'? 0x44aacc
            : march.kind === 'scout'    ? 0x9b59b6
            : 0x00b8f0; // occupy/sweep: azure — more blue-leaning than the earlier teal, distinct from reinforce's muted blue-gray
          // Full-length route trace — bold and opaque enough to read at a glance (was 1.5-2.5px @ 0.22-0.3 alpha, nearly invisible).
          g.lineStyle(enemy ? 8 : 5, col, enemy ? 0.85 : 0.8);
          g.moveTo(fpx, fpy);
          g.lineTo(px, py);
          g.lineStyle(0);

          // Progress along the path (§ real-time march animation): a march has no visible token
          // until this shipped — departAt/arriveAt were only used for HUD countdown text before.
          // Clamp guards a not-yet-departed or already-arrived march (poll lag) from drawing off-path.
          const span = march.arriveAt - march.departAt;
          const frac = span > 0 ? Math.min(1, Math.max(0, (now - march.departAt) / span)) : 1;
          const hx = fpx + (px - fpx) * frac;
          const hy = fpy + (py - fpy) * frac;
          const ang = Math.atan2(py - fpy, px - fpx);

          // Troop token: a filled diamond riding the route, oriented in the travel direction.
          const tokR = enemy ? 6 : 5;
          g.lineStyle(enemy ? 2 : 1.5, col, 0.95);
          g.beginFill(col, enemy ? 0.85 : 0.7);
          g.drawPolygon([
            hx + Math.cos(ang) * tokR,        hy + Math.sin(ang) * tokR,
            hx + Math.cos(ang + 2.4) * tokR,  hy + Math.sin(ang + 2.4) * tokR,
            hx + Math.cos(ang + Math.PI) * tokR * 0.5, hy + Math.sin(ang + Math.PI) * tokR * 0.5,
            hx + Math.cos(ang - 2.4) * tokR,  hy + Math.sin(ang - 2.4) * tokR,
          ]);
          g.endFill();
          g.lineStyle(0);

          // Directed chevron head at the destination (kept as the route's endpoint marker).
          const headLen = enemy ? 11 : 9;
          const spread = 0.45; // radians off the shaft on each side
          g.lineStyle(enemy ? 3 : 2, col, 0.5);
          g.moveTo(px - Math.cos(ang - spread) * headLen, py - Math.sin(ang - spread) * headLen);
          g.lineTo(px, py);
          g.lineTo(px - Math.cos(ang + spread) * headLen, py - Math.sin(ang + spread) * headLen);
          g.lineStyle(0);
        }
      }
    }

    /** Legacy entry point — called from action handlers after data changes. */
    renderMap(): void {
      this.invalidatePool();
    }
  };
}
