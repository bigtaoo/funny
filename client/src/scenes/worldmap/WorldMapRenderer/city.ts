// City building sprites: player-base cities (DB tiles, fog-gated, level-within-tier dots) and
// deterministic procedural NPC cities (seed-derived, map-wide), pooled and culled per viewport.
import * as PIXI from 'pixi.js-legacy';
import { BASE_FOOTPRINT, citySpriteTiles, cityGroundFwdPx, cityPlotMaskPoints } from '@nw/shared';
import { getCityTextureForLevel, getCityContentTopFracForLevel, isCityAtlasReady } from '../../../render/cityAtlasLoader';
import { getPlayerBaseTextureForLevel, getPlayerBaseContentTopFracForLevel } from '../../../render/playerBaseAtlasLoader';
import { tileToScreen, visibleTileBounds, ISO_RATIO } from '../../../render/isoGrid';
import { HUD_H, BASE_SPRITE_TILES } from '../constants';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface CityHandlers {
  refreshCityLayer(): void;
}

export function CityMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<CityHandlers> {
  return class extends Base {
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
          // The requester's own base renders from the separate "stationery fortress" playerbase_atlas,
          // keyed by desk building level rather than the tile's terrain-generated `level` (see
          // TileDoc.deskLevel). Other players' bases and NPC map cities keep the shared city_atlas below.
          const playerBaseTex = tile.mine ? getPlayerBaseTextureForLevel(tile.deskLevel ?? 1) : null;
          const tex = playerBaseTex ?? getCityTextureForLevel(lv);
          if (!tex) continue;
          // Which atlas actually supplied `tex` (see the fallback above) decides whose contentTop
          // metadata applies to the HP bar offset below.
          const contentTopFrac = playerBaseTex
            ? getPlayerBaseContentTopFracForLevel(tile.deskLevel ?? 1)
            : getCityContentTopFracForLevel(lv);

          // Reuse or create city container
          let cityC = this.ctx.citySprites.get(cacheKey);
          if (!cityC) {
            const sprite = new PIXI.Sprite(tex);
            sprite.name = 'img';
            sprite.anchor.set(0.5, 1); // bottom-center: the castle base rests on the plot, not centered on it
            const plotMask = new PIXI.Graphics();
            plotMask.name = 'plotMask';
            sprite.mask = plotMask;
            const dotGfx = new PIXI.Graphics();
            dotGfx.name = 'dots';
            const hpGfx = new PIXI.Graphics();  // damaged-base HP bar, hovers above the building
            hpGfx.name = 'hpbar';
            cityC = new PIXI.Container();
            cityC.addChild(sprite);
            cityC.addChild(plotMask);
            cityC.addChild(dotGfx);
            cityC.addChild(hpGfx);
            this.ctx.cityLayer.addChild(cityC);
            this.ctx.citySprites.set(cacheKey, cityC);
          }

          // Position bottom-center at the plot's own front vertex (see cityGroundFwdPx — single source
          // of truth shared with the node-city branch below and with map-editor). The atlas art is
          // bottom-aligned (pack_city_atlas.js sits every building's foot on the cell's bottom edge), so
          // the bottom-center anchor lands the foot on the plot uniformly for every frame.
          const s = tileToScreen(tx, ty, tp);
          const groundFwd = cityGroundFwdPx(BASE_FOOTPRINT, tp, ISO_RATIO);
          cityC.x = this.ctx.panX + s.x;
          cityC.y = this.ctx.panY + s.y + groundFwd;
          cityC.zIndex = tx + ty;

          // Resize sprite: keep the atlas art's own square aspect (it already draws each
          // building in isometric perspective on its own implied ground plane, per
          // cityAtlasLoader.ts) rather than squashing it into the 3×3 diamond footprint's
          // flatter bounding box — width still matches BASE_SPRITE_TILES*tp so buildings
          // line up with the footprint; height keeps the art's natural proportion. Whether
          // this still reads well is a v1 question for the follow-up diamond-art pass.
          const sprite = cityC.getChildByName('img') as PIXI.Sprite;
          if (sprite.texture !== tex) sprite.texture = tex;
          const baseSpriteTiles = citySpriteTiles(BASE_FOOTPRINT, BASE_SPRITE_TILES);
          sprite.width  = baseSpriteTiles * tp;
          sprite.height = baseSpriteTiles * tp;

          // Clip the sprite to its own plot (see cityPlotMaskPoints): a sprite this wide is ~7% wider
          // than the plot's own diamond, and the diamond itself tapers to a point at the front vertex —
          // without this mask that extra width and the un-tapered front corners visibly bleed onto
          // neighbouring resource tiles, leaving players unsure whether that tile is still capturable.
          const plotMask = cityC.getChildByName('plotMask') as PIXI.Graphics;
          plotMask.clear();
          plotMask.beginFill(0xffffff);
          plotMask.drawPolygon(cityPlotMaskPoints(BASE_FOOTPRINT, tp, ISO_RATIO, baseSpriteTiles * tp));
          plotMask.endFill();

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
            const by    = dotR + Math.max(2, tp * 0.05);   // just below the sprite's bottom edge (bottom-anchored → edge at local y=0)
            dots.lineStyle(1, inkColor, 0.85);
            for (let d = 0; d < maxInTier; d++) {
              const cx = bx + d * gap;
              dots.beginFill(d < lvInTier ? inkColor : 0xfff8f0, d < lvInTier ? 0.9 : 0.85);
              dots.drawCircle(cx, by, dotR);
              dots.endFill();
            }
          }

          // ADR-026 §1: damaged-base HP bar. The tile-level bar (tileGraphics.drawHpBar) is drawn on
          // the anchor tile in the pool layer but gets fully covered by this 3×3 city sprite, so a base
          // under siege would otherwise show no durability at all. Redraw it here on the city layer,
          // hovering just above the building. Only when damaged (hp < maxHp) — full bases stay uncluttered;
          // hp absent = full HP per the WorldTileView contract, so the guard also skips those.
          const hpbar = cityC.getChildByName('hpbar') as PIXI.Graphics;
          hpbar.clear();
          if (tile.maxHp && tile.hp != null && tile.hp < tile.maxHp) {
            const ratio = Math.max(0, Math.min(1, tile.hp / tile.maxHp));
            const barW = baseSpriteTiles * tp * 0.6;
            const barH = Math.max(3, tp * 0.07);
            const bxh = -barW / 2;
            // Above the ACTUAL building silhouette, not the sprite's full (mostly-empty, for short
            // buildings) cell: sprite is bottom-anchored, so local y = -sprite.height is the cell's top
            // edge and -sprite.height*(1-contentTopFrac) is where the art itself starts (see
            // cityAtlasLoader.getCityContentTopFracForLevel — a lv1 camp's art only fills the bottom
            // ~50% of its cell, so the old flat "0.9 of full height" floated the bar a tile-height above
            // the roof for short buildings; 2026-07-22 bug report).
            const gap = Math.max(2, tp * 0.04);
            const byh = -sprite.height * (1 - contentTopFrac) - barH - gap;
            hpbar.lineStyle(0.8, 0x3a2a1a, 0.85);
            hpbar.beginFill(0x2a1e12, 0.8);
            hpbar.drawRect(bxh, byh, barW, barH);
            hpbar.endFill();
            const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
            hpbar.lineStyle(0);
            hpbar.beginFill(fillColor, 0.95);
            hpbar.drawRect(bxh, byh, barW * ratio, barH);
            hpbar.endFill();
          }
        }
      }

      // Procedural NPC cities (ADR-034 §3: province capitals / graded / gate / world-center nodes). Unlike
      // player bases (DB tiles, above), these are deterministic terrain features derived locally from the
      // seed — so they render map-wide (no fog gate, like keeps/strongholds) with a per-LEVEL image sized to
      // the city's footprint (3/5/7/9 by tier). Keyed 'node:<id>' so they never collide with base '<x>:<y>' keys.
      for (const node of this.cityNodes()) {
        if (node.x < x0 || node.x >= x0 + visW || node.y < y0 || node.y >= y0 + visH) continue;
        const tex = getCityTextureForLevel(node.level);
        if (!tex) continue;
        const key = `node:${node.id}`;
        seen.add(key);
        let cityC = this.ctx.citySprites.get(key);
        if (!cityC) {
          const sprite = new PIXI.Sprite(tex);
          sprite.name = 'img';
          sprite.anchor.set(0.5, 1); // bottom-center: rest the city base on the plot
          const plotMask = new PIXI.Graphics();
          plotMask.name = 'plotMask';
          sprite.mask = plotMask;
          cityC = new PIXI.Container();
          cityC.addChild(sprite);
          cityC.addChild(plotMask);
          this.ctx.cityLayer.addChild(cityC);
          this.ctx.citySprites.set(key, cityC);
        }
        const s = tileToScreen(node.x, node.y, tp);
        const groundFwd = cityGroundFwdPx(node.footprint, tp, ISO_RATIO);
        cityC.x = this.ctx.panX + s.x;
        cityC.y = this.ctx.panY + s.y + groundFwd;
        cityC.zIndex = node.x + node.y;
        const sprite = cityC.getChildByName('img') as PIXI.Sprite;
        if (sprite.texture !== tex) sprite.texture = tex;
        const spriteTiles = citySpriteTiles(node.footprint, BASE_SPRITE_TILES);
        sprite.width = spriteTiles * tp;
        sprite.height = spriteTiles * tp;

        // Clip to the node's own plot — see the base-city branch note above (cityPlotMaskPoints).
        const plotMask = cityC.getChildByName('plotMask') as PIXI.Graphics;
        plotMask.clear();
        plotMask.beginFill(0xffffff);
        plotMask.drawPolygon(cityPlotMaskPoints(node.footprint, tp, ISO_RATIO, spriteTiles * tp));
        plotMask.endFill();
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
  };
}
