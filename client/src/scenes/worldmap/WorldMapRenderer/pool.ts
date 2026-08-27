// Tile pool (L1 detail / L2 simplified): a modulo-wrapped grid of Graphics slots covering the
// isometric visible region, plus per-slot draw, 3×3-base anchor detection, and owner identity.
//
// 2026-08-12 composition conversion note: the old PoolMixin also called `this.refreshCityLayer()`
// (city.ts) and `this.renderOverlay()` (fog.ts) from buildPool/invalidatePool/refreshPool — while
// city.ts called back into this file's `isBaseAnchor()`, and fog.ts's `renderMap()` called back
// into `invalidatePool()`. That made pool.ts the hub of BOTH of this chain's bidirectional pairs.
// Per ../WorldMapRenderer.ts's file-header comment, the fix hoists those outbound calls to the
// assembly: this class now owns ONLY tile-pool invalidation/repositioning (isBaseAnchor stays
// here — city.ts still calls it, a one-directional City → Pool dependency — but pool no longer
// calls back into city or fog at all). WorldMapRenderer.invalidatePool()/refreshPool() sequence
// `pool.*` + `city.refreshCityLayer()` + `fog.renderOverlay()` explicitly instead.
import * as PIXI from 'pixi.js-legacy';
import { proceduralTile, type ProceduralTile } from '@nw/shared';
import { tileToScreen, visibleTileBounds } from '../../../render/isoGrid';
import { HUD_H } from '../logic/constants';
import { ownerTint, terrainFill, terrainTextureName, proceduralTileColor } from '../logic/tileStyle';
import { drawTileL1, drawTileL2 } from '../tileGraphics';

/**
 * A single pooled tile object — one PIXI.Graphics reused for many map positions.
 *
 * Lived in `zoom.ts` next to `ZoomCfg` until ADR-071 4b (2026-08-27): it was that file's ONLY reason
 * to import PIXI, and it kept the zoom arithmetic out of the gated pure layer. It belongs here anyway
 * — this is the file that builds and draws the pool.
 */
export interface PoolSlot {
  g: PIXI.Graphics;
  tx: number; // map tile currently displayed (-1 = unassigned)
  ty: number;
}
import type { WorldTileView } from '../../../net/WorldApiClient';
import type { WorldMapRendererCore } from './core';

export interface PoolHandlers {
  buildPool(): void;
  invalidatePool(): void;
  refreshPool(): void;
  drawTileSlot(slot: PoolSlot, tx: number, ty: number): void;
  isBaseAnchor(tx: number, ty: number): boolean;
  ownerKeyOf(t: WorldTileView): string;
  ownerHasBoundary(owner: number, tx: number, ty: number): boolean;
}

export class WorldMapRendererPool implements PoolHandlers {
  constructor(private readonly core: WorldMapRendererCore) {}

  buildPool(): void {
    const ctx = this.core.ctx;
    // Destroy old slots.
    for (const s of ctx.pool) s.g.destroy();
    ctx.pool = [];
    ctx.poolContainer.removeChildren();
    if (ctx.zoom === 3) {
      // L3 uses the batched Graphics path — pool stays empty.
      ctx.poolContainer.visible = false;
      ctx.mapGfxL3.visible = true;
      ctx.l3Dirty = true;
      return;
    }
    ctx.poolContainer.visible = true;
    ctx.mapGfxL3.visible = false;
    // Depth-sort slots by their tile's screen row (see refreshPool's zIndex assignment). PIXI only
    // re-sorts when a zIndex actually changes, i.e. once per pan step, over ~600 slots at L1 — not
    // per frame.
    ctx.poolContainer.sortableChildren = true;
    const { poolW, poolH } = ctx.zc;
    for (let i = 0; i < poolW * poolH; i++) {
      const g = new PIXI.Graphics();
      ctx.pool.push({ g, tx: -999999, ty: -999999 });
      ctx.poolContainer.addChild(g);
    }
  }

  /**
   * Mark all pool slots stale and reposition — called after data changes. Only the tile-pool's
   * own concern (city-layer/overlay refresh is the caller's job now, see the file-header note —
   * WorldMapRenderer.invalidatePool() sequences this + refreshCityLayer() + renderOverlay()).
   */
  invalidatePool(): void {
    const ctx = this.core.ctx;
    if (ctx.zoom === 3) { ctx.l3Dirty = true; return; }
    for (const s of ctx.pool) { s.tx = -999999; s.ty = -999999; }
    this.refreshPool();
  }

  /** Modulo-wrap pool update: reposition all slots, redraw only those whose
   *  tile content changed (i.e. that scrolled to a new map position). */
  refreshPool(): void {
    const ctx = this.core.ctx;
    if (ctx.zoom === 3) return;
    const { tile: tp, poolW, poolH } = ctx.zc;
    // Isometric visible region is a rotated (diamond) area in tile space — the pool
    // covers its axis-aligned bounding box, so poolW/poolH (widened in makeZoomCfgs)
    // must be paired with an origin computed the same way rather than a naive
    // `-panX / tp`.
    const b = visibleTileBounds(ctx.w, ctx.h - HUD_H, ctx.panX, ctx.panY, tp);
    const x0 = b.minTx - 1;
    const y0 = b.minTy - 1;
    for (let dy = 0; dy < poolH; dy++) {
      for (let dx = 0; dx < poolW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        const si = (((ty % poolH) + poolH) % poolH) * poolW + (((tx % poolW) + poolW) % poolW);
        const slot = ctx.pool[si]!;
        const s = tileToScreen(tx, ty, tp);
        slot.g.x = ctx.panX + s.x;
        slot.g.y = ctx.panY + s.y;
        // Isometric painter's order. The pool is a modulo-wrap torus, so a slot's index in
        // poolContainer.children has nothing to do with its screen depth — which tile drew on
        // top of which was effectively arbitrary AND flipped as you panned. Harmless while every
        // tile's art stayed inside its own diamond, but structure sprites (watchtower/blocker)
        // and landmark buildings rise well above it: a back-row tower could paint over the row
        // in front of it. zIndex = tx+ty is the tile's screen-Y rank (screen y ∝ (tx+ty)), so
        // sorting on it makes nearer rows paint last (2026-08-15, "瞭望塔和拒马乱糟糟" pass).
        slot.g.zIndex = tx + ty;
        if (slot.tx === tx && slot.ty === ty) continue;
        slot.tx = tx; slot.ty = ty;
        this.drawTileSlot(slot, tx, ty);
      }
    }
  }

  /** Redraw a single pool slot for the given map position. */
  drawTileSlot(slot: PoolSlot, tx: number, ty: number): void {
    const ctx = this.core.ctx;
    const g = slot.g;
    g.clear();
    // Reset children left by the previous draw. Sprites (resource motifs, feature buildings) are
    // per-draw and get destroyed; anything else is a POOLED child that outlives the draw — today just
    // the `Lv.N` BitmapText, which is kept alive on purpose so panning does not allocate a text object
    // per tile per frame — so it is only hidden here. Hiding rather than skipping matters: drawTileL2
    // (and the L3 batch path) never touch that child at all, so without this a label would survive a
    // zoom-out and float over a tile drawn with no motif under it.
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      if (c instanceof PIXI.Sprite) { g.removeChild(c); c.destroy({ children: false }); }
      else c.visible = false;
    }
    const tp = ctx.tp;
    const inBounds = tx >= 0 && ty >= 0 && tx < ctx.mapW && ty < ctx.mapH;
    if (!inBounds) { g.visible = false; return; }
    g.visible = true;

    const tile = ctx.tileCache.get(`${tx}:${ty}`);
    // Uncached tiles (outside the fetched viewport / never claimed) still have a deterministic
    // terrain identity — proceduralTile() is computable on either end (§14.2). Without this the
    // texture/motif layers fell back to 'neutral'→grass on every uncached tile, hiding the whole
    // map's variety (obstacles / gates / center / biome resources) under one repeated doodle.
    const proc: ProceduralTile | null = tile ? null : proceduralTile(ctx.cb.worldId, tx, ty);
    // Terrain fill and ownership are now two separate signals (see ownerTint/terrainFill).
    const fill = tile ? terrainFill(tile) : proceduralTileColor(ctx.cb.worldId, tx, ty);
    const owner = tile ? ownerTint(tile) : null;
    const fogged = tile?.visible === false;
    // Only draw the owner border where this tile actually touches a differently-owned (or
    // unowned) neighbor — a solid block of same-owner territory would otherwise repeat the
    // same diamond outline on every tile, reading as a dense grid instead of a territory wash
    // (reported: "地图看起来有些混乱"). Unowned tiles keep border=true (unused by drawTileL1/L2
    // since they skip the whole owner block when owner==null).
    const ownerBorder = owner == null ? true : this.ownerHasBoundary(owner, tx, ty);

    if (ctx.zoom === 1) {
      const isAnchor = tile?.type === 'base' && this.isBaseAnchor(tx, ty);
      const effType = tile?.type ?? proc?.type ?? 'neutral';
      // River/mountain art kind: prefer the server tile's obstacleKind (§24 — carried from the per-world
      // terrain baseline, so map-editor-painted rivers/mountains win); fall back to proceduralTile only for
      // tiles the server didn't send a kind for (no baseline row → deterministic procedural terrain).
      const obstacleKind = effType === 'obstacle'
        ? (tile?.obstacleKind ?? (proc ?? proceduralTile(ctx.cb.worldId, tx, ty)).obstacleKind)
        : undefined;
      const texName = terrainTextureName(effType, tx, ty, obstacleKind);
      drawTileL1(g, tile ?? null, fill, owner, fogged, tp, isAnchor, texName, proc, tx, ty, ctx.cb.worldId, ownerBorder);
    } else {
      drawTileL2(g, fill, owner, fogged, tp, ownerBorder);
    }
  }

  /**
   * Does this owned tile touch a boundary — a directly-adjacent tile with a different
   * `ownerTint` value (including an unowned/uncached neighbor)? Same 4-neighbor `tileCache`
   * lookup pattern as {@link isBaseAnchor}. Missing/uncached neighbors (outside vision or never
   * fetched) count as a boundary — better to draw an extra border than silently merge two
   * territories that might not actually be contiguous. A same-owner interior tile (all 4
   * neighbors share this exact tint, e.g. MINE_TINT vs MINE_BASE_TINT still differ so a
   * capital's own outline is preserved) skips the border and keeps only the wash.
   */
  ownerHasBoundary(owner: number, tx: number, ty: number): boolean {
    const ctx = this.core.ctx;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const n = ctx.tileCache.get(`${tx + dx}:${ty + dy}`);
      if (!n) return true;
      if (ownerTint(n) !== owner) return true;
    }
    return false;
  }

  /**
   * Is (tx,ty) the CENTER anchor of a 3×3 base (ADR-025)? True iff the tile and all 4 orthogonal
   * neighbors are base tiles of the same owner — only the center of a 3×3 satisfies this, so ring
   * cells return false. Used to draw the city sprite/icon exactly once per base.
   *
   * The strict 3×3 requirement is intentional: worldsvc guarantees every capital is a complete
   * same-owner 3×3 (join places all 9 cells; getMe/joinWorld purge any legacy/corrupt base). A tile
   * that fails this test therefore signals bad data rather than a shape we should tolerate here.
   *
   * Fast path for the player's OWN base (2026-07-27 bug: "my base flickers then disappears"):
   * refreshCityLayer() re-runs this check on every redraw (5s march poll, live tile pushes, zoom
   * changes), each time re-reading all 4 neighbor cells fresh from tileCache. getMap() responses for
   * overlapping/out-of-order viewport refetches can leave a neighbor cell transiently stale or absent
   * even though the center is still solidly cached as our own base — the neighbor-based check has no
   * way to distinguish that from real corruption, so it fails and the sprite gets torn down by the
   * cleanup pass below (city.ts) until a fully-consistent read comes back around. ctx.me.mainBaseTile
   * is authoritative and doesn't depend on neighbor-cell cache freshness, so trust it directly instead
   * of re-deriving the same fact from four separately-fetched cache entries.
   */
  isBaseAnchor(tx: number, ty: number): boolean {
    const ctx = this.core.ctx;
    const c = ctx.tileCache.get(`${tx}:${ty}`);
    if (c?.type !== 'base') return false;
    if (c.mine && ctx.me?.mainBaseTile) {
      const [bx, by] = ctx.parseTileId(ctx.me.mainBaseTile);
      if (bx === tx && by === ty) return true;
    }
    const ownerKey = this.ownerKeyOf(c);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const n = ctx.tileCache.get(`${tx + dx}:${ty + dy}`);
      if (n?.type !== 'base' || this.ownerKeyOf(n) !== ownerKey) return false;
    }
    return true;
  }

  /** Stable-ish owner identity for anchor detection: prefer ownerPublicId, else the mine/ally/sectmate/enemy class. */
  ownerKeyOf(t: WorldTileView): string {
    return t.ownerPublicId ?? (t.mine ? 'me' : t.ally ? 'ally' : t.sectmate ? 'sectmate' : t.occupied ? 'enemy' : 'none');
  }
}
