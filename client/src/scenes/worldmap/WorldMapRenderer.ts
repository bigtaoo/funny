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
    this.ctx.panels.renderHud();
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
    this.ctx.panels.renderHud();
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
        this.ctx.panels.renderTrainPanel();
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
