// Tile pool (L1 detail / L2 simplified): a modulo-wrapped grid of Graphics slots covering the
// isometric visible region, plus per-slot draw, 3×3-base anchor detection, and owner identity.
import * as PIXI from 'pixi.js-legacy';
import { proceduralTile, type ProceduralTile } from '@nw/shared';
import { tileToScreen, visibleTileBounds } from '../../../render/isoGrid';
import { HUD_H } from '../constants';
import { ownerTint, terrainFill, terrainTextureName, proceduralTileColor } from '../tileStyle';
import { drawTileL1, drawTileL2 } from '../tileGraphics';
import type { PoolSlot } from '../zoom';
import type { WorldTileView } from '../../../net/WorldApiClient';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface PoolHandlers {
  buildPool(): void;
  invalidatePool(): void;
  refreshPool(): void;
  drawTileSlot(slot: PoolSlot, tx: number, ty: number): void;
  isBaseAnchor(tx: number, ty: number): boolean;
  ownerKeyOf(t: WorldTileView): string;
}

export function PoolMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<PoolHandlers> {
  return class extends Base {
    buildPool(): void {
      // Destroy old slots.
      for (const s of this.ctx.pool) s.g.destroy();
      this.ctx.pool = [];
      this.ctx.poolContainer.removeChildren();
      if (this.ctx.zoom === 3) {
        // L3 uses the batched Graphics path — pool stays empty.
        this.ctx.poolContainer.visible = false;
        this.ctx.mapGfxL3.visible = true;
        this.ctx.l3Dirty = true;
        return;
      }
      this.ctx.poolContainer.visible = true;
      this.ctx.mapGfxL3.visible = false;
      const { poolW, poolH } = this.ctx.zc;
      for (let i = 0; i < poolW * poolH; i++) {
        const g = new PIXI.Graphics();
        this.ctx.pool.push({ g, tx: -999999, ty: -999999 });
        this.ctx.poolContainer.addChild(g);
      }
    }

    /** Mark all pool slots stale and refresh — called after data changes. */
    invalidatePool(): void {
      if (this.ctx.zoom === 3) { this.ctx.l3Dirty = true; this.renderOverlay(); return; }
      for (const s of this.ctx.pool) { s.tx = -999999; s.ty = -999999; }
      this.refreshPool();
      this.renderOverlay();
    }

    /** Modulo-wrap pool update: reposition all slots, redraw only those whose
     *  tile content changed (i.e. that scrolled to a new map position). */
    refreshPool(): void {
      this.refreshCityLayer();
      if (this.ctx.zoom === 3) return;
      const { tile: tp, poolW, poolH } = this.ctx.zc;
      // Isometric visible region is a rotated (diamond) area in tile space — the pool
      // covers its axis-aligned bounding box, so poolW/poolH (widened in makeZoomCfgs)
      // must be paired with an origin computed the same way rather than a naive
      // `-panX / tp`.
      const b = visibleTileBounds(this.ctx.w, this.ctx.h - HUD_H, this.ctx.panX, this.ctx.panY, tp);
      const x0 = b.minTx - 1;
      const y0 = b.minTy - 1;
      for (let dy = 0; dy < poolH; dy++) {
        for (let dx = 0; dx < poolW; dx++) {
          const tx = x0 + dx;
          const ty = y0 + dy;
          const si = (((ty % poolH) + poolH) % poolH) * poolW + (((tx % poolW) + poolW) % poolW);
          const slot = this.ctx.pool[si]!;
          const s = tileToScreen(tx, ty, tp);
          slot.g.x = this.ctx.panX + s.x;
          slot.g.y = this.ctx.panY + s.y;
          if (slot.tx === tx && slot.ty === ty) continue;
          slot.tx = tx; slot.ty = ty;
          this.drawTileSlot(slot, tx, ty);
        }
      }
    }

    /** Redraw a single pool slot for the given map position. */
    drawTileSlot(slot: PoolSlot, tx: number, ty: number): void {
      const g = slot.g;
      g.clear();
      // Remove any sprite children added by the previous draw (resource motifs).
      for (let i = g.children.length - 1; i >= 0; i--) {
        const c = g.children[i];
        if (c instanceof PIXI.Sprite) { g.removeChild(c); c.destroy({ children: false }); }
      }
      const tp = this.ctx.tp;
      const inBounds = tx >= 0 && ty >= 0 && tx < this.ctx.mapW && ty < this.ctx.mapH;
      if (!inBounds) { g.visible = false; return; }
      g.visible = true;

      const tile = this.ctx.tileCache.get(`${tx}:${ty}`);
      // Uncached tiles (outside the fetched viewport / never claimed) still have a deterministic
      // terrain identity — proceduralTile() is computable on either end (§14.2). Without this the
      // texture/motif layers fell back to 'neutral'→grass on every uncached tile, hiding the whole
      // map's variety (obstacles / gates / center / biome resources) under one repeated doodle.
      const proc: ProceduralTile | null = tile ? null : proceduralTile(this.ctx.cb.worldId, tx, ty);
      // Terrain fill and ownership are now two separate signals (see ownerTint/terrainFill).
      const fill = tile ? terrainFill(tile) : proceduralTileColor(this.ctx.cb.worldId, tx, ty);
      const owner = tile ? ownerTint(tile) : null;
      const fogged = tile?.visible === false;

      if (this.ctx.zoom === 1) {
        const isAnchor = tile?.type === 'base' && this.isBaseAnchor(tx, ty);
        const effType = tile?.type ?? proc?.type ?? 'neutral';
        // River/mountain art kind: prefer the server tile's obstacleKind (§24 — carried from the per-world
        // terrain baseline, so map-editor-painted rivers/mountains win); fall back to proceduralTile only for
        // tiles the server didn't send a kind for (no baseline row → deterministic procedural terrain).
        const obstacleKind = effType === 'obstacle'
          ? (tile?.obstacleKind ?? (proc ?? proceduralTile(this.ctx.cb.worldId, tx, ty)).obstacleKind)
          : undefined;
        const texName = terrainTextureName(effType, tx, ty, obstacleKind);
        drawTileL1(g, tile ?? null, fill, owner, fogged, tp, isAnchor, texName, proc, tx, ty, this.ctx.cb.worldId);
      } else {
        drawTileL2(g, fill, owner, fogged, tp);
      }
    }

    /**
     * Is (tx,ty) the CENTER anchor of a 3×3 base (ADR-025)? True iff the tile and all 4 orthogonal
     * neighbors are base tiles of the same owner — only the center of a 3×3 satisfies this, so ring
     * cells return false. Used to draw the city sprite/icon exactly once per base.
     *
     * The strict 3×3 requirement is intentional: worldsvc guarantees every capital is a complete
     * same-owner 3×3 (join places all 9 cells; getMe/joinWorld purge any legacy/corrupt base). A tile
     * that fails this test therefore signals bad data rather than a shape we should tolerate here.
     */
    isBaseAnchor(tx: number, ty: number): boolean {
      const c = this.ctx.tileCache.get(`${tx}:${ty}`);
      if (c?.type !== 'base') return false;
      const ownerKey = this.ownerKeyOf(c);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const n = this.ctx.tileCache.get(`${tx + dx}:${ty + dy}`);
        if (n?.type !== 'base' || this.ownerKeyOf(n) !== ownerKey) return false;
      }
      return true;
    }

    /** Stable-ish owner identity for anchor detection: prefer ownerPublicId, else the mine/ally/enemy class. */
    ownerKeyOf(t: WorldTileView): string {
      return t.ownerPublicId ?? (t.mine ? 'me' : t.ally ? 'ally' : t.occupied ? 'enemy' : 'none');
    }
  };
}
