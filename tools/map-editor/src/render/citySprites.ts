// Per-level city building sprites (city_atlas art) — the same visuals the game renders
// (DESIGN.md §6.3 art-parity). Split out of index.ts (2026-08-02 pass 2).
import * as PIXI from 'pixi.js-legacy';
import { citySpriteTiles, cityGroundFwdPx, cityPlotMaskPoints } from '@nw/shared/slg';
import { BASE_SPRITE_TILES } from '../constants';
import { camera, cityStore } from '../editor';
import { citySpriteLayer } from '../stage';
import { getCityTextureForLevel, isCityAtlasReady } from './cityAtlasLoader';
import { ISO_RATIO } from '../tiles/isoGrid';

/**
 * Rebuilds every city sprite from cityStore.nodes. Cheap (~70 nodes) and deliberately NOT called on
 * every terrain-brush tick: cities don't move while painting, so this only runs on seed/zoom/city-
 * position changes.
 *
 * Sprite width = citySpriteTiles(footprint, BASE_SPRITE_TILES) tiles — LINEAR in footprint so every
 * city fills its own plot the same way a player base fills its 3×3 (footprint 3 → 3.2 tiles).
 * Placement math lives in @nw/shared (citySpriteTiles / cityGroundFwdPx) — single source of truth
 * shared with the game client's WorldMapRenderer city layer, so the two can't drift out of lockstep.
 */
export function refreshCitySprites(): void {
  citySpriteLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  if (!isCityAtlasReady()) return;
  for (const node of cityStore.nodes) {
    const tex = getCityTextureForLevel(node.level);
    if (!tex) continue;
    const sp = new PIXI.Sprite(tex);
    // Bottom-center anchor at the plot's own front vertex (cityGroundFwdPx — matches the game client's
    // WorldMapRenderer city layer): the atlas art is bottom-aligned (pack_city_atlas.js sits every
    // building's foot on the cell's bottom edge), so the anchor lands the foot on the plot uniformly.
    sp.anchor.set(0.5, 1);
    const s = camera.layerOf(node.x, node.y);
    sp.x = s.x;
    sp.y = s.y + cityGroundFwdPx(node.footprint, camera.tp, ISO_RATIO);
    sp.zIndex = node.x + node.y;
    const spriteTiles = citySpriteTiles(node.footprint, BASE_SPRITE_TILES);
    sp.width = spriteTiles * camera.tp;
    sp.height = spriteTiles * camera.tp;

    // Clip to the plot's own diamond (cityPlotMaskPoints, @nw/shared): the sprite is deliberately ~7%
    // wider than the footprint and its own diamond tapers to a point at the front vertex, so without
    // this mask the sprite bleeds onto a neighbouring resource tile — ambiguous to a player deciding
    // whether that tile is still capturable. Matches the game client's WorldMapRenderer city layer.
    const plotMask = new PIXI.Graphics();
    plotMask.x = sp.x;
    plotMask.y = sp.y;
    plotMask.beginFill(0xffffff);
    plotMask.drawPolygon(cityPlotMaskPoints(node.footprint, camera.tp, ISO_RATIO, spriteTiles * camera.tp));
    plotMask.endFill();
    sp.mask = plotMask;
    citySpriteLayer.addChild(plotMask, sp);
  }
}
