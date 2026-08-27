// City building sprites: player-base cities (DB tiles, fog-gated, name/level label) and NPC cities
// (the world's published node list, map-wide), pooled and culled per viewport.
import * as PIXI from 'pixi.js-legacy';
import { BASE_FOOTPRINT, citySpriteTiles, cityGroundFwdPx, cityPlotMaskPoints } from '@nw/shared';
import { getCityTextureForLevel, getCityContentTopFracForLevel, isCityAtlasReady } from '../../../render/atlas/cityAtlasLoader';
import { getPlayerBaseTextureForLevel, getPlayerBaseContentTopFracForLevel } from '../../../render/atlas/playerBaseAtlasLoader';
import { tileToScreen, visibleTileBounds, ISO_RATIO } from '../../../render/isoGrid';
import { SECT_BASE_TINT, ALLY_SECT_BASE_TINT } from '../logic/tileStyle';
import { HUD_H, BASE_SPRITE_TILES } from '../logic/constants';
import { t } from '../../../i18n';
import { makeText } from '../../../render/pixiText';
import { drawShieldDome, drawShieldGlow } from './shieldFx';
import type { WorldMapRendererCore } from './core';
import type { WorldMapRendererPool } from './pool';

export interface CityHandlers {
  refreshCityLayer(): void;
}

export class WorldMapRendererCity implements CityHandlers {
  constructor(
    private readonly core: WorldMapRendererCore,
    private readonly pool: WorldMapRendererPool,
  ) {}

  /**
   * Position and populate city building sprites for all base tiles currently
   * in the viewport. Each city occupies a 3×3-tile sprite centered on the base
   * tile — the image hovers above the tile pool layer so it never gets covered
   * by adjacent tiles.
   *
   * Name/level label (2026-08-01, replaces the old filled/hollow "level-within-tier"
   * dot cluster — that overloaded one small glyph with both ownership color AND level
   * progress, which players found unreadable): a plain text tag floating above the
   * building reading "{ownerName} Lv.{n}" — one rule for every base, own included
   * (ctx.cb.playerName for mine, tile.ownerName for everyone else's). Ownership itself is
   * already conveyed by the tile's own color wash (ownerTint) — the label doesn't need
   * to repeat it, so its ink color is just a secondary echo of the same mapping.
   */
  refreshCityLayer(): void {
    const ctx = this.core.ctx;
    if (!isCityAtlasReady()) {
      ctx.cityLayer.visible = false;
      return;
    }
    ctx.cityLayer.visible = true;

    const tp = ctx.tp;
    const b = visibleTileBounds(ctx.w, ctx.h - HUD_H, ctx.panX, ctx.panY, tp);
    const x0 = b.minTx - 2;
    const y0 = b.minTy - 2;
    const visW = (b.maxTx - b.minTx) + 4;
    const visH = (b.maxTy - b.minTy) + 4;

    const seen = new Set<string>();

    for (let dy = 0; dy < visH; dy++) {
      for (let dx = 0; dx < visW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        if (tx < 0 || ty < 0 || tx >= ctx.mapW || ty >= ctx.mapH) continue;

        const cacheKey = `${tx}:${ty}`;
        const tile = ctx.tileCache.get(cacheKey);
        // A base occupies 9 tiles (ADR-025); draw the single city sprite only on the CENTER anchor,
        // so the 8 ring cells don't each spawn an overlapping 3×3 sprite.
        if (tile?.type !== 'base' || !this.pool.isBaseAnchor(tx, ty)) continue;

        seen.add(cacheKey);

        const lv = tile.level ?? 1;
        // Every DB base tile reaching this loop belongs to a real player account — own or another
        // player's; NPC cities are handled entirely by the separate cityNodes() loop
        // below, never here. So always render from the "stationery fortress" playerbase_atlas,
        // keyed by desk building level (see TileDoc.deskLevel), not `tile.level` — that's the
        // tile's terrain-generated level, frozen at spawn/relocation and never updated afterward,
        // so it drifts arbitrarily far from the account's real progress. This used to be
        // `tile.mine ? ... : null`, so viewing any OTHER player's base fell back to the tier-based
        // city_atlas keyed off that stale terrain level — e.g. a brand-new Lv.1 account whose spawn
        // tile happened to land on a high terrain-level cell rendered as a max-tier fortress to
        // everyone else (reported 2026-08-12). The `?? getCityTextureForLevel` fallback below now
        // only matters while the playerbase atlas PNG hasn't finished decoding yet.
        const playerBaseTex = getPlayerBaseTextureForLevel(tile.deskLevel ?? 1);
        const tex = playerBaseTex ?? getCityTextureForLevel(lv);
        if (!tex) continue;
        // Which atlas actually supplied `tex` (see the fallback above) decides whose contentTop
        // metadata applies to the HP bar offset below.
        const contentTopFrac = playerBaseTex
          ? getPlayerBaseContentTopFracForLevel(tile.deskLevel ?? 1)
          : getCityContentTopFracForLevel(lv);

        // Reuse or create city container
        let cityC = ctx.citySprites.get(cacheKey);
        if (!cityC) {
          const sprite = new PIXI.Sprite(tex);
          sprite.name = 'img';
          sprite.anchor.set(0.5, 1); // bottom-center: the castle base rests on the plot, not centered on it
          const plotMask = new PIXI.Graphics();
          plotMask.name = 'plotMask';
          sprite.mask = plotMask;
          const label = makeText('', {
            fontFamily: 'monospace', fontWeight: 'bold', align: 'center',
            stroke: 0xfff8f0, strokeThickness: 3,
          });
          label.name = 'label';
          label.anchor.set(0.5, 1);
          const hpGfx = new PIXI.Graphics();  // damaged-base HP bar, hovers above the building
          hpGfx.name = 'hpbar';
          const shieldFx = new PIXI.Graphics();  // protection-shield dome (S8-8 UI fix, 2026-08-08)
          shieldFx.name = 'shieldFx';
          // Rotating dashed ring + sparkles (2026-08-08 follow-up, borrowed from daydayup's
          // additive-glow shield accents) — separate Graphics so it can run additive blend
          // without also blowing out the dome's "glass" fill/stroke above.
          const shieldGlowFx = new PIXI.Graphics();
          shieldGlowFx.name = 'shieldGlowFx';
          shieldGlowFx.blendMode = PIXI.BLEND_MODES.ADD;
          // One-shot pop when protection lapses (2026-08-08 follow-up, borrowed from daydayup's
          // shield_break flash) — empty/inert until a shield actually breaks.
          const shieldBreakFx = new PIXI.Graphics();
          shieldBreakFx.name = 'shieldBreakFx';
          shieldBreakFx.blendMode = PIXI.BLEND_MODES.ADD;
          cityC = new PIXI.Container();
          cityC.addChild(sprite);
          cityC.addChild(plotMask);
          cityC.addChild(label);
          cityC.addChild(hpGfx);
          // Topmost, in draw order dome → glow → break-pop: the pop briefly reads over everything.
          cityC.addChild(shieldFx);
          cityC.addChild(shieldGlowFx);
          cityC.addChild(shieldBreakFx);
          ctx.cityLayer.addChild(cityC);
          ctx.citySprites.set(cacheKey, cityC);
        }

        // Position bottom-center at the plot's own front vertex (see cityGroundFwdPx — single source
        // of truth shared with the node-city branch below and with map-editor). The atlas art is
        // bottom-aligned (pack_city_atlas.js sits every building's foot on the cell's bottom edge), so
        // the bottom-center anchor lands the foot on the plot uniformly for every frame.
        const s = tileToScreen(tx, ty, tp);
        const groundFwd = cityGroundFwdPx(BASE_FOOTPRINT, tp, ISO_RATIO);
        cityC.x = ctx.panX + s.x;
        cityC.y = ctx.panY + s.y + groundFwd;
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

        // Redraw the name/level label. Same reserved vertical slot as the HP bar below
        // (whether or not the bar is actually showing this frame) so the label doesn't
        // jump up/down as a siege starts or ends.
        const label = cityC.getChildByName('label') as PIXI.Text;
        // Mirror the texture-selection branch above: the player-facing level for ANY base tile here
        // is the desk building level (1-10, updated on every desk upgrade), not `tile.level` — that
        // field is the tile's terrain-generation level, written once at spawn/relocation and never
        // touched again by desk upgrades (server/worldsvc/src/core/spawn.ts). This used to fall back
        // to `lv` for other players' bases too, which left their label (and, separately, their
        // sprite — see above) stuck on the stale terrain level instead of tracking their real
        // progress. `?? 1`, not `?? lv`: the server only ever writes `deskLevel` once a desk upgrade
        // completes (city/buildings.ts) — a base whose desk is still at its untouched starting level
        // has no `deskLevel` field at all, and the desk building itself always starts at level 1
        // (shared/src/slg/city.ts's buildingLevel default), never at the terrain-generated `level`.
        const labelLv = tile.deskLevel ?? 1;
        const levelStr = t('city.lvlLabel').replace('{lvl}', String(labelLv));
        const ownerStr = tile.mine ? ctx.cb.playerName : (tile.ownerName ?? '');
        label.text = ownerStr ? `${ownerStr} ${levelStr}` : levelStr;
        label.style.fontSize = Math.round(Math.max(9, Math.min(20, tp * 0.16)));
        label.style.fill = tile.mine ? 0x2266cc
          : tile.ally ? 0x2e8b40
          : tile.sectmate ? SECT_BASE_TINT
          : tile.allySect ? ALLY_SECT_BASE_TINT
          : tile.occupied ? 0xcc2222
          : 0x888888;
        const reservedBarH = Math.max(3, tp * 0.07) + Math.max(2, tp * 0.04);
        label.position.set(0, -sprite.height * (1 - contentTopFrac) - reservedBarH - 2);

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

        // S8-8 UI fix (2026-08-08): the capital-protection shield (slg_shield_8h/24h, TileDoc.protectedUntil)
        // took effect server-side but had no visual — a shielded base looked identical to an unshielded one.
        // Any base still under protection (own or another player's — WorldMapInput already hides the attack
        // button for a protected enemy tile, so seeing the shield at a glance is useful there too) gets a
        // translucent bubble dome over the building, with a slow breathing pulse so it reads as "active" at
        // a glance rather than a flat static overlay.
        const shieldFx = cityC.getChildByName('shieldFx') as PIXI.Graphics;
        const shieldGlowFx = cityC.getChildByName('shieldGlowFx') as PIXI.Graphics;
        if ((tile.protectedUntil ?? 0) > Date.now()) {
          const cx = 0;
          const cy = -sprite.height * (1 - contentTopFrac) * 0.5;
          const rx = sprite.width * 0.42;
          const ry = sprite.height * (1 - contentTopFrac) * 0.62;
          const geom = { cx, cy, rx, ry, tp };
          // Cache the local-space geometry so lifecycle.update can re-animate this bubble every
          // frame (spin/breathe) without recomputing sprite layout — see WorldMapContext.shieldGeom.
          ctx.shieldGeom.set(cacheKey, geom);
          drawShieldDome(shieldFx, geom, ctx.shieldAnimT);
          drawShieldGlow(shieldGlowFx, geom, ctx.shieldAnimT);
        } else {
          // Was protected as of the last redraw and just dropped out — pop a one-shot break
          // flash at the same spot (2026-08-08 follow-up, borrowed from daydayup's shield_break).
          const priorGeom = ctx.shieldGeom.get(cacheKey);
          if (priorGeom) ctx.shieldBreakFx.set(cacheKey, { ...priorGeom, age: 0 });
          shieldFx.clear();
          shieldGlowFx.clear();
          ctx.shieldGeom.delete(cacheKey);
        }
      }
    }

    // NPC cities (ADR-034 §3: province capitals / graded / world-center nodes). Unlike player bases (DB
    // tiles, above) these are part of the world's terrain, so they render map-wide (no fog gate, like
    // strongholds) with a per-LEVEL image sized to the city's footprint (3/5/7/9 by tier). Keyed
    // 'node:<id>' so they never collide with base '<x>:<y>' keys.
    //
    // The node list comes from core.cityNodes() — the SERVER's list for this world when the entry fetch has
    // landed, the seed-derived allCityNodes() only as a fallback (see core.ts for why the seed alone is not
    // enough once a map template has been hand-edited). Nothing here reads the footprint tiles: each city
    // is exactly one sprite masked to its own plot, which is also why tileGraphics/tiles.ts stamps no
    // per-tile building on `familyKeep`/`center` city ground.
    for (const node of this.core.cityNodes()) {
      if (node.x < x0 || node.x >= x0 + visW || node.y < y0 || node.y >= y0 + visH) continue;
      const tex = getCityTextureForLevel(node.level);
      if (!tex) continue;
      const key = `node:${node.id}`;
      seen.add(key);
      let cityC = ctx.citySprites.get(key);
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
        // ADR-074 P1: durability bar. NOT inside the plot mask — the mask clips the building art to its
        // own plot diamond, and a bar hovering above the roof would be clipped away with it.
        const hpbar = new PIXI.Graphics();
        hpbar.name = 'hpbar';
        cityC.addChild(hpbar);
        ctx.cityLayer.addChild(cityC);
        ctx.citySprites.set(key, cityC);
      }
      const s = tileToScreen(node.x, node.y, tp);
      const groundFwd = cityGroundFwdPx(node.footprint, tp, ISO_RATIO);
      cityC.x = ctx.panX + s.x;
      cityC.y = ctx.panY + s.y + groundFwd;
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

      // ADR-074 P1 durability bar. Only when damaged, same restraint as the player-base bar above: 64
      // permanently-full bars would be pure clutter, and a city at full durability is not under siege.
      // The bar is a RATIO only — the absolute numbers live in the info panel, because the durability
      // curve is base-dominated (26,000 + 900/level, see SLG_CITY_SIEGE_DESIGN §6.5) and a bar alone
      // cannot convey that a level-10 capital's wall is only ~22% deeper than a level-3 city's.
      const cityHp = cityC.getChildByName('hpbar') as PIXI.Graphics;
      cityHp.clear();
      if (node.durabilityMax && node.durability != null && node.durability < node.durabilityMax) {
        const ratio = Math.max(0, Math.min(1, node.durability / node.durabilityMax));
        const barW = spriteTiles * tp * 0.5;
        const barH = Math.max(3, tp * 0.07);
        const bx = -barW / 2;
        // Above the ACTUAL art, not the sprite's full cell: `citySpriteTiles` sizes the sprite from the
        // plot footprint, and every frame has transparent padding above its silhouette, so anchoring to
        // -sprite.height floats the bar hundreds of px over the roof — off-screen entirely for a 7x7 city.
        // Measured on a Lv.6 city before this fix: the bar rendered above the viewport and looked absent.
        // Same treatment (and the same `getCityContentTopFracForLevel`) as the player-base bar above, whose
        // own 2026-07-22 bug report was this exact symptom for short buildings.
        const contentTop = getCityContentTopFracForLevel(node.level);
        const by = -sprite.height * (1 - contentTop) - barH - Math.max(2, tp * 0.04);
        cityHp.lineStyle(0.8, 0x3a2a1a, 0.85);
        cityHp.beginFill(0x2a1e12, 0.8);
        cityHp.drawRect(bx, by, barW, barH);
        cityHp.endFill();
        const fill = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
        cityHp.lineStyle(0);
        cityHp.beginFill(fill, 0.95);
        cityHp.drawRect(bx, by, barW * ratio, barH);
        cityHp.endFill();
      }
    }

    // Destroy sprites that have scrolled off-screen
    for (const [key, cityC] of ctx.citySprites) {
      if (!seen.has(key)) {
        ctx.cityLayer.removeChild(cityC);
        cityC.destroy({ children: true });
        ctx.citySprites.delete(key);
      }
    }
  }
}
