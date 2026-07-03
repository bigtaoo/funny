import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { WorldApiError } from '../../net/WorldApiClient';
import { proceduralTile } from '@nw/shared';
import { loadResAtlas, getResTexture, isResAtlasReady } from '../../render/resAtlasLoader';
import { loadCityAtlas, getCityTexture, isCityAtlasReady } from '../../render/cityAtlasLoader';
import { loadTerrainAtlas, getTerrainTexture, isTerrainAtlasReady } from '../../render/terrainAtlasLoader';
import { loadBuildingAtlas, getBuildingTexture, isBuildingAtlasReady } from '../../render/buildingAtlasLoader';
import { ISO_RATIO, tileToScreen, screenToTile, screenToTileF, diamondPath, diamondVertices, visibleTileBounds } from '../../render/isoGrid';
import { DEFAULT_MAP_SIZE, HUD_H, MARGIN, CONFIRM_H, BASE_SPRITE_TILES, TRAIN_INK_PER, TRAIN_SPEEDUP_PER_COIN, TRAIN_BATCH_MAX, TRAIN_PRESETS, RELOCATE_COST, WATCHTOWER_COST_METAL, WATCHTOWER_COST_PAPER } from './constants';
import { TERRAIN_COLORS, RES_COLORS, MINE_TINT, MINE_BASE_TINT, ENEMY_TINT, ENEMY_BASE_TINT, ALLY_TINT, ALLY_BASE_TINT, FOG_COLOR, CLOUD_COLOR, ALLY_SECT_BORDER, ownerTint, terrainFill, terrainTextureName, tileColor, proceduralTileColor } from './tileStyle';
import { makeZoomCfgs } from './zoom';
import { drawTileL1, drawTileL2, drawResMotif, drawResMotifFallback, drawCityIcon, drawHpBar, placeBuildingSprite, drawStar } from './tileGraphics';
import type { IconKind } from '../../render/icons';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../../net/proto/transport';
import type { ProceduralTile } from '@nw/shared';
import type { TerrainTextureName } from '../../render/terrainAtlasLoader';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldMapContext, WorldMapCallbacks, DeployKind } from './WorldMapContext';

export class WorldMapRenderer {
  constructor(private readonly ctx: WorldMapContext) {}

  build(): void {
    const { w, h } = this.ctx;

    // Paper background
    const bg = buildPaperBackground('worldmap', w, h, { marginLine: false });
    this.ctx.container.addChild(bg);

    // Map area (clip to above-HUD area)
    const mapClip = new PIXI.Container();
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, 0, w, h - HUD_H).endFill();
    mapClip.mask = mask;
    mapClip.addChild(mask);
    this.ctx.container.addChild(mapClip);

    // L3 overview graphics (underneath pool)
    this.ctx.mapGfxL3 = new PIXI.Graphics();
    mapClip.addChild(this.ctx.mapGfxL3);

    // Tile pool container (L1/L2)
    this.ctx.poolContainer = new PIXI.Container();
    mapClip.addChild(this.ctx.poolContainer);

    // City building sprites (above tiles, below overlay). sortableChildren + zIndex
    // (set per-sprite in refreshCityLayer) gives isometric-correct back-to-front draw order.
    this.ctx.cityLayer = new PIXI.Container();
    this.ctx.cityLayer.sortableChildren = true;
    mapClip.addChild(this.ctx.cityLayer);

    // Off-map cloud veil (above tiles/cities, below the interactive overlay so march
    // arrows / capital stars / selection — all on-map — always read on top).
    this.ctx.fogGfx = new PIXI.Graphics();
    mapClip.addChild(this.ctx.fogGfx);

    // Overlay: capitals, march arrows, selected tile highlight
    this.ctx.overlayGfx = new PIXI.Graphics();
    mapClip.addChild(this.ctx.overlayGfx);

    // HUD bar
    this.ctx.hudLayer = new PIXI.Container();
    this.ctx.container.addChild(this.ctx.hudLayer);

    this.ctx.modalLayer = new PIXI.Container();
    this.ctx.container.addChild(this.ctx.modalLayer);

    this.ctx.toastLayer = new PIXI.Container();
    this.ctx.container.addChild(this.ctx.toastLayer);

    // Loading cover — top-most so the half-built / untextured map never peeks through.
    this.buildLoadingOverlay();

    this.buildPool();
    this.renderHud();
    this.invalidatePool();
  }

  /**
   * The first-paint loading cover: an opaque notebook-paper sheet + a hand-drawn
   * spinning ink ring + localized "loading map…" caption. Hidden by hideLoading()
   * once the map atlases have settled (see constructor). Sized to the full scene so
   * nothing underneath — flat color tiles, fog, half-loaded city sprites — shows.
   */

  buildLoadingOverlay(): void {
    const { w, h } = this.ctx;
    const layer = new PIXI.Container();

    const sheet = buildPaperBackground('worldmap-loading', w, h, { marginLine: false });
    layer.addChild(sheet);

    const cx = w / 2;
    const cy = (h - HUD_H) / 2;

    // Broken ink ring (open arc) — rotated each frame in update() while active.
    const spinner = new PIXI.Graphics();
    spinner.lineStyle(3, 0x3a3a3a, 0.9);
    spinner.arc(0, 0, 22, -Math.PI * 0.15, Math.PI * 1.25);
    spinner.position.set(cx, cy);
    layer.addChild(spinner);

    const label = new PIXI.Text(t('world.loading'), {
      fontFamily: 'sans-serif', fontSize: 18, fill: 0x3a3a3a,
    });
    label.anchor.set(0.5);
    label.position.set(cx, cy + 50);
    layer.addChild(label);

    this.ctx.container.addChild(layer);
    this.ctx.loadingLayer = layer;
    this.ctx.loadingSpinner = spinner;
  }

  /** Remove the first-paint loading cover (idempotent); clears the safety timeout. */

  hideLoading(): void {
    if (this.ctx.loadingTimeout) { clearTimeout(this.ctx.loadingTimeout); this.ctx.loadingTimeout = null; }
    if (this.ctx.loadingLayer) {
      this.ctx.loadingLayer.destroy({ children: true });
      this.ctx.loadingLayer = null;
      this.ctx.loadingSpinner = null;
    }
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  viewportCenter(): { cx: number; cy: number; r: number } {
    const tp = this.ctx.tp;
    const b = visibleTileBounds(this.ctx.w, this.ctx.h - HUD_H, this.ctx.panX, this.ctx.panY, tp);
    const cx = Math.floor((b.minTx + b.maxTx) / 2);
    const cy = Math.floor((b.minTy + b.maxTy) / 2);
    const r  = Math.ceil(Math.max(b.maxTx - b.minTx, b.maxTy - b.minTy) / 2) + 4;
    return { cx: Math.max(0, Math.min(this.ctx.mapW - 1, cx)), cy: Math.max(0, Math.min(this.ctx.mapH - 1, cy)), r };
  }

  // ── Zoom control ───────────────────────────────────────────────────────────

  setZoom(z: 1 | 2 | 3): void {
    if (this.ctx.zoom === z) return;
    // Keep map center stable across zoom levels: read which (fractional) tile is
    // under the screen center under the old projection, then re-pan so that same
    // tile lands on screen center under the new tile size.
    const oldTp = this.ctx.tp;
    const screenCx = this.ctx.w / 2;
    const screenCy = (this.ctx.h - HUD_H) / 2;
    const frac = screenToTileF(screenCx - this.ctx.panX, screenCy - this.ctx.panY, oldTp);
    this.ctx.zoom = z;
    const newCenterScreen = tileToScreen(frac.x, frac.y, this.ctx.tp);
    this.ctx.panX = screenCx - newCenterScreen.x;
    this.ctx.panY = screenCy - newCenterScreen.y;
    this.clampPan();
    this.buildPool();
    this.invalidatePool();
    this.renderHud();
    // After switching zoom, re-fetch viewport data at the new LOD (different levels require different endpoints / field sets)
    void this.ctx.net.loadMapViewport();
  }

  // ── Tile pool (L1 / L2) ────────────────────────────────────────────────────

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

  /**
   * Position and populate city building sprites for all base tiles currently
   * in the viewport. Each city occupies a 3×3-tile sprite centered on the base
   * tile — the image hovers above the tile pool layer so it never gets covered
   * by adjacent tiles.
   *
   * Programmatic level-within-tier distinction: filled / hollow dots below the
   * city image indicate how far into the current tier the city has upgraded.
   *   Tier 1 (lv 1-2):  ● ○  /  ● ●
   *   Tier 2 (lv 3-5):  ● ○ ○  /  ● ● ○  /  ● ● ●
   *   (etc.)
   */

  refreshCityLayer(): void {
    if (!isCityAtlasReady()) {
      this.ctx.cityLayer.visible = false;
      return;
    }
    this.ctx.cityLayer.visible = true;

    const tp = this.ctx.tp;
    const b = visibleTileBounds(this.ctx.w, this.ctx.h - HUD_H, this.ctx.panX, this.ctx.panY, tp);
    const x0 = b.minTx - 2;
    const y0 = b.minTy - 2;
    const visW = (b.maxTx - b.minTx) + 4;
    const visH = (b.maxTy - b.minTy) + 4;

    const seen = new Set<string>();

    for (let dy = 0; dy < visH; dy++) {
      for (let dx = 0; dx < visW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        if (tx < 0 || ty < 0 || tx >= this.ctx.mapW || ty >= this.ctx.mapH) continue;

        const cacheKey = `${tx}:${ty}`;
        const tile = this.ctx.tileCache.get(cacheKey);
        // A base occupies 9 tiles (ADR-025); draw the single city sprite only on the CENTER anchor,
        // so the 8 ring cells don't each spawn an overlapping 3×3 sprite.
        if (tile?.type !== 'base' || !this.isBaseAnchor(tx, ty)) continue;

        seen.add(cacheKey);

        const lv = tile.level ?? 1;
        const tier = lv <= 2 ? 1 : lv <= 5 ? 2 : lv <= 8 ? 3 : 4;
        const tex = getCityTexture(tier as 1 | 2 | 3 | 4);
        if (!tex) continue;

        // Reuse or create city container
        let cityC = this.ctx.citySprites.get(cacheKey);
        if (!cityC) {
          const sprite = new PIXI.Sprite(tex);
          sprite.name = 'img';
          sprite.anchor.set(0.5);
          const dotGfx = new PIXI.Graphics();
          dotGfx.name = 'dots';
          cityC = new PIXI.Container();
          cityC.addChild(sprite);
          cityC.addChild(dotGfx);
          this.ctx.cityLayer.addChild(cityC);
          this.ctx.citySprites.set(cacheKey, cityC);
        }

        // Position at tile diamond center; depth-sort so bases further back (smaller
        // tx+ty) never overdraw ones nearer camera when their sprites overlap.
        const s = tileToScreen(tx, ty, tp);
        cityC.x = this.ctx.panX + s.x;
        cityC.y = this.ctx.panY + s.y;
        cityC.zIndex = tx + ty;

        // Resize sprite: keep the atlas art's own square aspect (it already draws each
        // building in isometric perspective on its own implied ground plane, per
        // cityAtlasLoader.ts) rather than squashing it into the 3×3 diamond footprint's
        // flatter bounding box — width still matches BASE_SPRITE_TILES*tp so buildings
        // line up with the footprint; height keeps the art's natural proportion. Whether
        // this still reads well is a v1 question for the follow-up diamond-art pass.
        const sprite = cityC.getChildByName('img') as PIXI.Sprite;
        if (sprite.texture !== tex) sprite.texture = tex;
        sprite.width  = BASE_SPRITE_TILES * tp;
        sprite.height = BASE_SPRITE_TILES * tp;

        // Redraw level-within-tier dots
        const dots = cityC.getChildByName('dots') as PIXI.Graphics;
        dots.clear();
        const inkColor = tile.mine ? 0xcc2222 : (tile.ally ? 0x2e8b40 : (tile.occupied ? 0x2266cc : 0x888888));
        const tierStarts = [0, 0, 2, 5, 8] as const;
        const tierSizes  = [0, 2, 3, 3, 2] as const;
        const maxInTier = tierSizes[tier];
        const lvInTier  = lv - tierStarts[tier]; // 1-indexed
        if (maxInTier > 1) {
          const dotR  = Math.max(2.5, tp * 0.09);
          const gap   = dotR * 2.7;
          const totalW = maxInTier * gap - gap + 2 * dotR;
          const bx    = -totalW / 2 + dotR;
          const by    = (BASE_SPRITE_TILES / 2) * tp + dotR;   // just below the sprite's bottom edge
          dots.lineStyle(1, inkColor, 0.85);
          for (let d = 0; d < maxInTier; d++) {
            const cx = bx + d * gap;
            dots.beginFill(d < lvInTier ? inkColor : 0xfff8f0, d < lvInTier ? 0.9 : 0.85);
            dots.drawCircle(cx, by, dotR);
            dots.endFill();
          }
        }
      }
    }

    // Destroy sprites that have scrolled off-screen
    for (const [key, cityC] of this.ctx.citySprites) {
      if (!seen.has(key)) {
        this.ctx.cityLayer.removeChild(cityC);
        cityC.destroy({ children: true });
        this.ctx.citySprites.delete(key);
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
      const texName = terrainTextureName(tile?.type ?? proc?.type ?? 'neutral', tx, ty);
      drawTileL1(g, tile ?? null, fill, owner, fogged, tp, isAnchor, texName, proc);
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

  /**
   * L1 detail tile: paper terrain + motif, then ownership wash/border, then level/sect/watchtower markers.
   * `g`'s local origin is the tile's DIAMOND CENTER (set by refreshPool via isoGrid.tileToScreen),
   * not the old top-left square corner — every marker below is positioned relative to that center.
   */

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

  // ── Overlay (march arrows, capitals, selected tile) ────────────────────────
  // Drawn into a separate Graphics above the tile pool. Fast to redraw (~few dozen objects).

  /**
   * Cloud/mist veil over everything outside the map's tile area. The map's tile rectangle
   * (0..mapW-1 × 0..mapH-1) projects to a screen-space parallelogram; we fill the whole
   * viewport with cloud and punch that parallelogram out as a hole, then lay a soft thick
   * stroke along its edge so the map fades into mist rather than ending on a hard diamond.
   * Redrawn from renderOverlay(), which fires on every pan / zoom / data change.
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
    const hole = [
      px + top.x,          py + top.y - hh,
      px + right.x + hw,   py + right.y,
      px + bottom.x,       py + bottom.y + hh,
      px + left.x - hw,    py + left.y,
    ];
    g.beginFill(CLOUD_COLOR, 0.97);
    g.drawRect(0, 0, this.ctx.w, mapViewH);
    g.beginHole();
    g.drawPolygon(hole);
    g.endHole();
    g.endFill();
    // Misty rim: a soft thick stroke straddling the map boundary, blurring the hard tile edge.
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
          : 0xcc8844;
        g.lineStyle(enemy ? 2.5 : 1.5, col, enemy ? 0.75 : 0.55);
        g.moveTo(fpx, fpy);
        g.lineTo(px, py);
        // Directed chevron head at the destination (was a plain dot): a march has a heading
        // (attack / return / …), so the tip should encode direction. Drawn slightly bolder and
        // more opaque than the shaft so it reads at a glance. Zero-length march → ang=0 (harmless).
        const ang = Math.atan2(py - fpy, px - fpx);
        const headLen = enemy ? 11 : 9;
        const spread = 0.45; // radians off the shaft on each side
        g.lineStyle(enemy ? 3 : 2, col, 0.9);
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

  /** Draw a 5-point star (capital marker). Filled when the nation is owned. */

  renderHud(): void {
    const hud = this.ctx.hudLayer;
    tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
    const { w, h } = this.ctx;

    // HUD background
    const panel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    panel.y = h - HUD_H;
    hud.addChild(panel);

    // Back button
    const backW = 88, backH = 34;
    const backBtn = sketchPanel(backW, backH, { fill: C.dark, border: C.accent, seed: seedFor(5, 3, backW) });
    backBtn.x = 8; backBtn.y = h - HUD_H + 8;
    hud.addChild(backBtn);
    const backLbl = txt(t('world.back'), 13, C.light);
    backLbl.anchor.set(0.5, 0.5);
    backLbl.x = backBtn.x + backW / 2; backLbl.y = backBtn.y + backH / 2;
    hud.addChild(backLbl);
    this.ctx.backRect = { x: backBtn.x, y: backBtn.y, w: backW, h: backH };

    // Resources row
    if (this.ctx.me?.joined) {
      const troops = this.ctx.me.troops ?? 0;
      const troopCap = this.ctx.me.troopCap ?? 0;
      const territory = this.ctx.me.territoryCount ?? 0;
      const infos = [
        `${t('world.troops')} ${troops}/${troopCap}`,
        `${t('world.territory')} ${territory}`,
      ];
      let ix = 106;
      const resRowY = h - HUD_H + 18;
      for (const info of infos) {
        const lbl = txt(info, 11, C.dark);
        lbl.x = ix; lbl.y = resRowY;
        hud.addChild(lbl);
        ix += lbl.width + 14;
      }

      // Resource counts: hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
      // replacing the earlier emoji glyphs that broke the notebook art style. Falls back to
      // emoji only while the atlas is still decoding (getResTexture null).
      const res = this.ctx.me.resources ?? {};
      const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
      const RES_ICON = 18;
      for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
        if (res[rt] === undefined) continue;
        const tex = getResTexture(rt);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = ix; sp.y = resRowY - 4;
          hud.addChild(sp);
          ix += RES_ICON + 1;
          const cnt = txt(`${res[rt]}`, 11, C.dark);
          cnt.x = ix; cnt.y = resRowY;
          hud.addChild(cnt);
          ix += cnt.width + 12;
        } else {
          const lbl = txt(`${RES_EMOJI[rt]}${res[rt]}`, 11, C.dark);
          lbl.x = ix; lbl.y = resRowY;
          hud.addChild(lbl);
          ix += lbl.width + 14;
        }
      }
    }

    // Active marches panel — own marches only
    // (G5: this.marches may also hold in-vision enemy marches, which can't be recalled).
    this.ctx.marchRowRects = [];
    const myMarches = this.ctx.marches.filter((m) => m.mine !== false);
    const MARCH_PANEL_X = 8;
    const MARCH_ROW_H = 22;
    const RECALL_W = 50;
    // Section header always visible when player has joined
    if (this.ctx.me?.joined) {
      const headerTxt = myMarches.length > 0
        ? `${t('world.marchList')} (${myMarches.length})`
        : t('world.marchList');
      const marchHeader = txt(headerTxt, 10, C.mid);
      marchHeader.x = MARCH_PANEL_X; marchHeader.y = h - HUD_H + 52;
      hud.addChild(marchHeader);
    }
    if (myMarches.length > 0) {
      const now = Date.now();
      const ROW_Y0 = h - HUD_H + 68;
      for (let i = 0; i < myMarches.length; i++) {
        const m = myMarches[i];
        const [tx, ty] = this.ctx.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        // Hand-drawn march-kind glyph (icons.ts) replacing the earlier emoji, to match the
        // notebook art style. attack→swords, reinforce→shield, scout→scope, return→loop, occupy→flag.
        const MARCH_KIND_ICON: Record<string, IconKind> = {
          attack: 'swords', reinforce: 'armor', scout: 'scope', return: 'replay', occupy: 'flag',
        };
        const rowY = ROW_Y0 + i * MARCH_ROW_H;
        const kindIc = buildIcon(MARCH_KIND_ICON[m.kind] ?? 'flag', 14, C.dark);
        kindIc.x = MARCH_PANEL_X; kindIc.y = rowY + 1;
        hud.addChild(kindIc);
        const rowLbl = txt(`(${tx},${ty})  ${remaining}s`, 11, C.dark);
        rowLbl.x = MARCH_PANEL_X + 17; rowLbl.y = rowY + 2;
        hud.addChild(rowLbl);

        // Recall button (only for non-return marches)
        if (m.kind !== 'return') {
          const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
          recallBtn.x = MARCH_PANEL_X + 140; recallBtn.y = rowY + 1;
          hud.addChild(recallBtn);
          const recallLbl = txt(t('world.recall'), 10, C.light);
          recallLbl.anchor.set(0.5, 0.5);
          recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
          hud.addChild(recallLbl);
          this.ctx.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
          });
        } else {
          this.ctx.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: null,
          });
        }
      }
    }

    // Train / Family / Auction buttons (right side)
    const btnW = 70;

    // Action buttons (right side, vertically centred in HUD)
    const btnH = 36;
    const btnY = h - HUD_H + (HUD_H - btnH) / 2;

    // Train button — only meaningful once the player has a base.
    if (this.ctx.me?.joined) {
      const trainBtn = sketchPanel(btnW, btnH, { fill: C.red, border: C.accent, seed: seedFor(2, 0, btnW) });
      trainBtn.x = w - btnW * 3 - 22; trainBtn.y = btnY;
      hud.addChild(trainBtn);
      const inQ = (this.ctx.me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
      const trainLbl = txt(inQ > 0 ? `${t('world.train')} (${inQ})` : t('world.train'), 13, C.light);
      trainLbl.anchor.set(0.5, 0.5);
      trainLbl.x = trainBtn.x + btnW / 2; trainLbl.y = trainBtn.y + btnH / 2;
      hud.addChild(trainLbl);
      this.ctx.trainBtnRect = { x: trainBtn.x, y: trainBtn.y, w: btnW, h: btnH };
    } else {
      this.ctx.trainBtnRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    const famBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
    famBtn.x = w - btnW * 2 - 14; famBtn.y = btnY;
    hud.addChild(famBtn);
    const famLbl = txt(t('world.family'), 13, C.light);
    famLbl.anchor.set(0.5, 0.5);
    famLbl.x = famBtn.x + btnW / 2; famLbl.y = famBtn.y + btnH / 2;
    hud.addChild(famLbl);
    this.ctx.famBtnRect = { x: famBtn.x, y: famBtn.y, w: btnW, h: btnH };

    const aucBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, btnW) });
    aucBtn.x = w - btnW - 6; aucBtn.y = btnY;
    hud.addChild(aucBtn);
    const aucLbl = txt(t('world.auction'), 13, C.light);
    aucLbl.anchor.set(0.5, 0.5);
    aucLbl.x = aucBtn.x + btnW / 2; aucLbl.y = aucBtn.y + btnH / 2;
    hud.addChild(aucLbl);
    this.ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: btnW, h: btnH };

    // World info button — floats top-right over the map (nations / season / shop).
    const infoW = 76, infoH = 34;
    const infoBtn = sketchPanel(infoW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, infoW) });
    infoBtn.x = w - infoW - 8; infoBtn.y = 8;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 13, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + infoW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.ctx.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: infoW, h: infoH };

    // Zoom cycle button — top-left over the map, cycles L1→L2→L3→L1.
    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomW = 76, zoomH = 34;
    const zoomBtn = sketchPanel(zoomW, zoomH, { fill: C.dark, border: C.accent, seed: seedFor(4, 2, zoomW) });
    zoomBtn.x = 8; zoomBtn.y = 8;
    hud.addChild(zoomBtn);
    // Hand-drawn magnifier glyph + the ×N label, centred as a group (replaces the 🔍 emoji).
    const zIcon = buildIcon('zoom', 16, C.light);
    const zTxt = txt(zoomLabels[this.ctx.zoom] ?? '', 13, C.light);
    zTxt.anchor.set(0, 0.5);
    const zGrpW = 16 + 4 + zTxt.width;
    const zGx = zoomBtn.x + (zoomW - zGrpW) / 2;
    zIcon.x = zGx; zIcon.y = zoomBtn.y + (zoomH - 16) / 2;
    zTxt.x = zGx + 20; zTxt.y = zoomBtn.y + zoomH / 2;
    hud.addChild(zIcon); hud.addChild(zTxt);
    this.ctx.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: zoomW, h: zoomH };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  showModal(lines: string[], buttons: { label: string; action: () => void }[]): void {
    const ml = this.ctx.modalLayer;
    ml.removeChildren();

    const { w, h } = this.ctx;
    const mw = Math.min(300, w - 32);
    const mh = CONFIRM_H;
    const mx = (w - mw) / 2;
    const my = (h - HUD_H - mh) / 2;

    // Dimmer
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let ly = my + 14;
    for (const line of lines) {
      const lbl = txt(line, 13, C.dark);
      lbl.anchor.set(0.5, 0);
      lbl.x = mx + mw / 2; lbl.y = ly;
      ml.addChild(lbl);
      ly += 20;
    }

    this.ctx.modalBtnRects = [];
    const btnW = Math.min(100, (mw - MARGIN * (buttons.length + 1)) / buttons.length);
    let bx = mx + (mw - (btnW + MARGIN) * buttons.length + MARGIN) / 2;
    const by = my + mh - 40;
    for (const btn of buttons) {
      const bp = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      // '✕' cancel buttons render the hand-drawn close glyph instead of the bare dingbat.
      if (btn.label === '✕') {
        const ic = buildIcon('close', 16, C.light);
        ic.x = bx + btnW / 2 - 8; ic.y = by + 6;
        ml.addChild(ic);
      } else {
        const bl = txt(btn.label, 12, C.light);
        bl.anchor.set(0.5, 0.5);
        bl.x = bx + btnW / 2; bl.y = by + 14;
        ml.addChild(bl);
      }
      this.ctx.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: 28 }, action: btn.action });
      bx += btnW + MARGIN;
    }

    // Close on dim
    this.ctx.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  closeModal(): void {
    this.ctx.modalLayer.removeChildren();
    this.ctx.modalBtnRects = [];
    this.ctx.modalDimRect = null;
    this.ctx.selectedTile = null;
    this.ctx.trainPanelOpen = false;
    this.renderMap();
  }

  showToast(msg: string, color: number = C.dark): void {
    const tl = this.ctx.toastLayer;
    tl.removeChildren();
    const { w, h } = this.ctx;
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = w / 2; lbl.y = h - HUD_H - 50;
    tl.addChild(lbl);
    this.ctx.toastTimer = 2500;
  }

  // ── Tile actions ───────────────────────────────────────────────────────────

  showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    const me = this.ctx.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const avail = Math.max(0, Math.floor(me.troops ?? 0));
    const kindLabel = kind === 'attack' ? t('world.actAttack')
      : kind === 'reinforce' ? t('world.actReinforce')
      : kind === 'sweep' ? t('world.actSweep')
      : t('world.actOccupy');
    const send = (qty: number): void => { void this.ctx.net.doMarch(tx, ty, kind, qty); };
    this.showModal(
      [t('world.deployTitle').replace('{avail}', String(avail)), `${kindLabel} → (${tx}, ${ty})`],
      [
        { label: t('world.deployQuarter'), action: () => send(Math.floor(avail / 4)) },
        { label: t('world.deployHalf'), action: () => send(Math.floor(avail / 2)) },
        { label: t('world.deployAll'), action: () => send(avail) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  // ── Siege team picker (G3-2c §16.2) ────────────────────────────────────────────────
  // A siege march must attach an attack formation template (team) — committed troops = sum of full HP of all units in the team, derived by the server (overrides the troop count). Empty team list → guide the player to manage teams.

  openTrainPanel(): void {
    if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.ctx.trainPanelOpen = true;
    this.ctx.panelRepaint = 0;
    void this.ctx.net.refreshMe().then(() => { if (this.ctx.trainPanelOpen) this.renderTrainPanel(); });
    this.renderTrainPanel();
  }

  /** A small filled button registered in modalBtnRects. */

  panelButton(
    label: string, x: number, y: number, bw: number, bh: number,
    fill: number, action: () => void,
  ): void {
    const ml = this.ctx.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, 11, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.ctx.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  renderTrainPanel(): void {
    const me = this.ctx.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.ctx.modalLayer;
    tearDownChildren(ml); // repainted once/sec while open (queue countdowns) → free Text textures
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const pw = Math.min(340, w - 24);
    const ph = 300;
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(7, 7, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, ty: number, size = 12, color: number = C.dark, cx = px + 14, anchorX = 0): PIXI.Text => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = cx; lbl.y = ty;
      ml.addChild(lbl);
      return lbl;
    };

    let ly = py + 12;
    // Title
    const title = txt(t('world.trainTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = ly;
    ml.addChild(title);
    ly += 26;

    // Resources + yield — hand-drawn motif icon (res_atlas, reused from the map tiles) + count,
    // replacing the earlier emoji glyphs. Falls back to emoji while the atlas is still decoding.
    const res = me.resources ?? {};
    const yield_ = me.yieldRate ?? {};
    const RES_EMOJI: Record<string, string> = { ink: '🖋️', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '⭐' };
    const RES_ICON = 16;
    const layoutResRow = (types: string[], rowY: number): void => {
      let rx = px + 14;
      for (const key of types) {
        const amt = Math.floor(res[key] ?? 0);
        const yr = yield_[key];
        const valStr = yr ? `${amt} (+${Math.round(yr)}/${t('world.resYield')})` : `${amt}`;
        const tex = getResTexture(key);
        if (tex) {
          const sp = new PIXI.Sprite(tex);
          sp.width = sp.height = RES_ICON;
          sp.x = rx; sp.y = rowY - 3;
          ml.addChild(sp);
          rx += RES_ICON + 2;
          rx += addText(valStr, rowY, 11, C.dark, rx).width + 14;
        } else {
          rx += addText(`${RES_EMOJI[key]}${valStr}`, rowY, 11, C.dark, rx).width + 14;
        }
      }
    };
    layoutResRow(['ink', 'paper', 'graphite'], ly);
    ly += 18;
    layoutResRow(['metal', 'sticker'], ly);
    ly += 20;

    // Troops
    const inQ = (me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
    const troops = Math.floor(me.troops ?? 0);
    const cap = Math.floor(me.troopCap ?? 0);
    let troopLine = `${t('world.troops')} ${troops}/${cap}`;
    if (inQ > 0) troopLine += `  ·  ${t('world.trainInQueue').replace('{n}', String(inQ))}`;
    addText(troopLine, ly, 12, C.red);
    ly += 24;

    // Recruit row
    addText(t('world.trainNew'), ly, 12);
    ly += 20;
    const ink = Math.floor(res['ink'] ?? 0);
    const capLeft = Math.max(0, cap - troops - inQ);
    const queueFull = (me.trainingQueue ?? []).length >= 2;
    const bw = (pw - 28 - MARGIN * 2) / 3;
    let bx = px + 14;
    for (const n of TRAIN_PRESETS) {
      const cost = n * TRAIN_INK_PER;
      const ok = !queueFull && capLeft >= n && ink >= cost;
      this.panelButton(
        `+${n}`, bx, ly, bw, 30,
        ok ? C.dark : C.mid,
        () => { if (ok) void this.ctx.net.doTrain(n); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < n ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
      );
      bx += bw + MARGIN;
    }
    // Max preset = min(batch cap, capacity left, ink-affordable)
    const maxQty = Math.min(TRAIN_BATCH_MAX, capLeft, Math.floor(ink / TRAIN_INK_PER));
    const maxOk = !queueFull && maxQty >= 1;
    this.panelButton(
      maxOk ? `${t('world.trainMax')} +${maxQty}` : t('world.trainMax'), bx, ly, bw, 30,
      maxOk ? C.red : C.mid,
      () => { if (maxOk) void this.ctx.net.doTrain(maxQty); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < 1 ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
    );
    ly += 38;

    // Queue
    addText(t('world.trainQueue'), ly, 12);
    ly += 18;
    const queue = me.trainingQueue ?? [];
    if (queue.length === 0) {
      addText(t('world.trainQueueEmpty'), ly, 11, C.mid);
      ly += 18;
    } else {
      const now = Date.now();
      for (const e of queue) {
        const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
        addText(`• ${t('world.trainEntry').replace('{n}', String(e.qty)).replace('{sec}', String(sec))}`, ly, 11, C.dark);
        ly += 18;
      }
      // One-tap coin speedup: enough coins to clear the whole queue.
      const lastDone = queue[queue.length - 1]!.completeAt;
      const remainSec = Math.max(0, Math.ceil((lastDone - now) / 1000));
      const coins = Math.max(1, Math.ceil(remainSec / TRAIN_SPEEDUP_PER_COIN));
      ly += 4;
      this.panelButton(
        t('world.speedup').replace('{coins}', String(coins)),
        px + 14, ly, pw - 28, 28, C.accent,
        () => void this.ctx.net.doSpeedup(coins),
      );
      ly += 34;
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  openInfoPanel(): void {
    this.ctx.trainPanelOpen = false;
    this.renderInfoPanel();
    // Lazy-load shop catalog + fresh nations/season the first time.
    if (this.ctx.shopItems.length === 0) {
      void this.ctx.cb.worldApi.getShopItems()
        .then((items) => { this.ctx.shopItems = items; if (this.ctx.modalDimRect && !this.ctx.trainPanelOpen) this.renderInfoPanel(); })
        .catch(() => { /* offline */ });
    }
    void this.ctx.cb.worldApi.getNations(this.ctx.cb.worldId)
      .then((n) => { this.ctx.nations = n; })
      .catch(() => {});
  }

  /** Localize an SLG shop item by kind + effect (server description is zh-only). */

  shopLabel(it: SlgShopItemView): string {
    const eff = it.effect as Record<string, number>;
    switch (it.kind) {
      case 'troop_speedup': return t('world.shop.speedup').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'resource_pack': return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
      case 'protection':    return t('world.shop.shield').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'battle_pass':   return t('world.shop.battlePass');
      default:              return it.id;
    }
  }

  renderInfoPanel(): void {
    const ml = this.ctx.modalLayer;
    ml.removeChildren();
    this.ctx.modalBtnRects = [];

    const { w, h } = this.ctx;
    const pw = Math.min(360, w - 20);
    const ph = Math.min(380, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(9, 9, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark, anchorX = 0): void => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = tx2; lbl.y = ty;
      ml.addChild(lbl);
    };

    // Title
    const title = txt(t('world.infoTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
    ml.addChild(title);

    // Tabs
    const tabs: { id: 'nations' | 'season' | 'shop'; label: string }[] = [
      { id: 'nations', label: t('world.tabNations') },
      { id: 'season',  label: t('world.tabSeason') },
      { id: 'shop',    label: t('world.tabShop') },
    ];
    const tabW = (pw - 28 - MARGIN * 2) / 3;
    let tx = px + 14;
    const tabY = py + 34;
    for (const tab of tabs) {
      const active = this.ctx.infoTab === tab.id;
      this.panelButton(tab.label, tx, tabY, tabW, 26, active ? C.red : C.dark, () => {
        this.ctx.infoTab = tab.id; this.renderInfoPanel();
      });
      tx += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;

    if (this.ctx.infoTab === 'nations') {
      if (this.ctx.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, ly, 11, C.mid);
      } else {
        for (const n of this.ctx.nations) {
          if (ly > bodyBottom) break;
          const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
          const mine = !!n.ownerId && n.ownerId === this.ctx.cb.accountId;
          const nStar = buildIcon('star', 12, C.gold);
          nStar.x = px + 14; nStar.y = ly - 1;
          ml.addChild(nStar);
          addText(`${name}  (${n.x},${n.y})`, px + 30, ly, 11);
          if (mine) {
            // Owner may rename their capital (server re-checks ownerId).
            const bw = 54;
            this.panelButton(t('world.nationRename'), px + pw - bw - 14, ly - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
          } else {
            const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
            addText(status, px + pw - 14, ly, 11, n.ownerId ? C.red : C.mid, 1);
          }
          ly += 24;
        }
      }
    } else if (this.ctx.infoTab === 'season') {
      const s = this.ctx.season;
      if (!s) {
        addText('—', px + 14, ly, 11, C.mid);
      } else {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, ly, 13, C.red); ly += 22;
        const statusKey = `world.season.${s.status}`;
        addText(t(statusKey as Parameters<typeof t>[0]), px + 14, ly, 11); ly += 18;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, ly, 11); ly += 18;
        if (s.resetAt) {
          const days = Math.max(0, Math.ceil((s.resetAt - Date.now()) / 86400000));
          addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, ly, 11); ly += 18;
        }
      }
    } else {
      // Shop — show current coin balance (SaveData mirror) above the catalog.
      if (this.ctx.cb.getCoins) {
        addText(t('world.shopBalance').replace('{coins}', String(this.ctx.cb.getCoins())), px + 14, ly, 11, C.accent);
        ly += 22;
      }
      const rowH = 30;
      for (const it of this.ctx.shopItems) {
        if (ly + rowH > bodyBottom) break;
        addText(this.shopLabel(it), px + 14, ly + 4, 11);
        addText(t('world.shopCost').replace('{coins}', String(it.cost)), px + 14, ly + 18, 10, C.mid);
        const bw = 56;
        this.panelButton(t('world.shopBuy'), px + pw - bw - 14, ly + 2, bw, 24, C.accent, () => void this.ctx.net.doBuyShopItem(it.id));
        ly += rowH + 2;
      }
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  /** Open a hidden text input to rename an owned capital, then PATCH via worldsvc. */

  openRenameInput(capitalIdx: number, current: string): void {
    if (this.ctx.hiddenInput) { this.ctx.hiddenInput.remove(); this.ctx.hiddenInput = null; }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = current;
    inp.maxLength = 24;
    inp.placeholder = t('world.nationNamePrompt');
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = inp.value.trim();
        inp.remove();
        if (name && name !== current) void this.ctx.net.doRename(capitalIdx, name);
      }
    });
    inp.addEventListener('blur', () => {
      inp.remove();
      if (this.ctx.hiddenInput === inp) this.ctx.hiddenInput = null;
    });
    this.ctx.hiddenInput = inp;
  }

  centerAt(tx: number, ty: number): void {
    const tp = this.ctx.tp;
    const s = tileToScreen(tx, ty, tp);
    this.ctx.panX = this.ctx.w / 2 - s.x;
    this.ctx.panY = (this.ctx.h - HUD_H) / 2 - s.y;
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
    const mapViewH = this.ctx.h - HUD_H;
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
    if (maxSy - minSy <= mapViewH) {
      this.ctx.panY = mapViewH / 2 - (minSy + maxSy) / 2;
    } else {
      this.ctx.panY = Math.min(-minSy, Math.max(mapViewH - maxSy, this.ctx.panY));
    }
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    return screenToTile(sx - this.ctx.panX, sy - this.ctx.panY, this.ctx.tp);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  update(dt: number): void {
    // Spin the loading ring while the first-paint cover is up.
    if (this.ctx.loadingSpinner) {
      this.ctx.loadingAngle += dt * 4;
      this.ctx.loadingSpinner.rotation = this.ctx.loadingAngle;
    }
    if (this.ctx.toastTimer > 0) {
      this.ctx.toastTimer -= dt * 1000;
      if (this.ctx.toastTimer <= 0) this.ctx.toastLayer.removeChildren();
    }
    // L3 overview: flush dirty flag at most once per frame (60fps cap).
    if (this.ctx.l3Dirty && this.ctx.zoom === 3) {
      this.renderMapL3();
    }
    // Tick the train panel's queue countdowns once per second while open.
    if (this.ctx.trainPanelOpen) {
      this.ctx.panelRepaint += dt;
      if (this.ctx.panelRepaint >= 1) {
        this.ctx.panelRepaint = 0;
        this.renderTrainPanel();
      }
    }
  }

  // ── Lifecycle (bootstrap / teardown), split out of the original WorldMapScene ctor+destroy ──

  /** Load the map atlases behind the loading cover, then reveal the map fully textured. */
  bootstrap(): void {
    const atlasLoads = [
      loadTerrainAtlas().catch((err) => console.warn('[WorldMapScene] terrain atlas load failed:', err)),
      loadCityAtlas().catch((err) => console.warn('[WorldMapScene] city atlas load failed:', err)),
      loadResAtlas().catch((err) => console.warn('[WorldMapScene] res atlas load failed:', err)),
      loadBuildingAtlas().catch((err) => console.warn('[WorldMapScene] building atlas load failed:', err)),
    ];
    Promise.allSettled(atlasLoads).then(() => {
      if (this.ctx.destroyed) return;
      this.renderMap();
      this.hideLoading();
    });
    // Safety net: reveal anyway if an atlas hangs, so the player is never stuck on the cover.
    this.ctx.loadingTimeout = setTimeout(() => {
      if (!this.ctx.destroyed) { this.renderMap(); this.hideLoading(); }
    }, 8000);
  }

  destroy(): void {
    if (this.ctx.loadingTimeout) { clearTimeout(this.ctx.loadingTimeout); this.ctx.loadingTimeout = null; }
    if (this.ctx.hiddenInput) { this.ctx.hiddenInput.remove(); this.ctx.hiddenInput = null; }
    for (const s of this.ctx.pool) s.g.destroy();
    this.ctx.pool = [];
    for (const c of this.ctx.citySprites.values()) c.destroy({ children: true });
    this.ctx.citySprites.clear();
  }
}
