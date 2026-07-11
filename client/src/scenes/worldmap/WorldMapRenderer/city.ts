// City building sprites: player-base cities (DB tiles, fog-gated, level-within-tier dots) and
// deterministic procedural NPC cities (seed-derived, map-wide), pooled and culled per viewport.
import * as PIXI from 'pixi.js-legacy';
import { BASE_FOOTPRINT } from '@nw/shared';
import { getCityTextureForLevel, isCityAtlasReady } from '../../../render/cityAtlasLoader';
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
          const tex = getCityTextureForLevel(lv);
          if (!tex) continue;

          // Reuse or create city container
          let cityC = this.ctx.citySprites.get(cacheKey);
          if (!cityC) {
            const sprite = new PIXI.Sprite(tex);
            sprite.name = 'img';
            sprite.anchor.set(0.5, 1); // bottom-center: the castle base rests on the plot, not centered on it
            const dotGfx = new PIXI.Graphics();
            dotGfx.name = 'dots';
            cityC = new PIXI.Container();
            cityC.addChild(sprite);
            cityC.addChild(dotGfx);
            this.ctx.cityLayer.addChild(cityC);
            this.ctx.citySprites.set(cacheKey, cityC);
          }

          // Position bottom-center between the plot CENTER and its front vertex. The atlas art is now
          // bottom-aligned (pack_city_atlas.js sits every building's foot on the cell's bottom edge),
          // so the bottom-center anchor lands the foot on the plot uniformly for every frame — no more
          // per-frame float from centred art's variable bottom margin. GROUND_FWD nudges the foot 55%
          // of the way toward the front vertex so the castle reads as planted on the plot with only a
          // small forecourt apron, while the foot still stays back far enough that the wide base never
          // covers the front RESOURCE tiles (the tall body rises up-and-back, occluding only BACK tiles
          // — correct isometric depth). 0.55 verified in the Canvas2D A/B harness against the widest
          // frames (lv4 grand citadel, lv2 wooden fort). See design/tools/map-editor.
          const s = tileToScreen(tx, ty, tp);
          const groundFwd = (BASE_FOOTPRINT * tp * ISO_RATIO) / 2 * 0.55; // 55% of center→front-vertex
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
            const by    = dotR + Math.max(2, tp * 0.05);   // just below the sprite's bottom edge (bottom-anchored → edge at local y=0)
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
          cityC = new PIXI.Container();
          cityC.addChild(sprite);
          this.ctx.cityLayer.addChild(cityC);
          this.ctx.citySprites.set(key, cityC);
        }
        const s = tileToScreen(node.x, node.y, tp);
        const groundFwd = (node.footprint * tp * ISO_RATIO) / 2 * 0.55; // 55% center→front-vertex (see base branch note)
        cityC.x = this.ctx.panX + s.x;
        cityC.y = this.ctx.panY + s.y + groundFwd;
        cityC.zIndex = node.x + node.y;
        const sprite = cityC.getChildByName('img') as PIXI.Sprite;
        if (sprite.texture !== tex) sprite.texture = tex;
        // Scale the sprite LINEARLY with footprint so every city fills its own plot the same way a player
        // base fills its 3×3 (footprint 3 → 3.2 tiles, unchanged). Sub-linear √ scaling under-filled the big
        // plots badly — a 9×9 world-center reached only √3×3.2 ≈ 5.5 tiles, leaving most of its 9×9 ground
        // exposed as a big empty apron. The larger sprite still sits within its own (larger) footprint, so
        // the earlier "don't let the mega-city balloon and swallow the map" worry doesn't apply — the plot
        // really is that big.
        const spriteTiles = (node.footprint / BASE_FOOTPRINT) * BASE_SPRITE_TILES;
        sprite.width = spriteTiles * tp;
        sprite.height = spriteTiles * tp;
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
