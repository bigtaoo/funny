// The ground layer: real atlas textures, same projection and art as the game client's
// WorldMapRenderer (DESIGN.md §6.3 art-parity). Painting stamps tiles into the persistent terrain
// grid; this module rasterizes that grid plus the city footprints into a tile diff and draws it —
// the same rasterizeMapEdits() that the Publish button uploads, so the WYSIWYG preview and what
// gets published can never drift apart. Split out of index.ts (2026-08-02 pass 2).
import * as PIXI from 'pixi.js-legacy';
import {
  proceduralTile,
  rasterizeMapEdits,
  SLG_MAP_MAX_LEVEL,
  type MapTemplateTile,
  type ObstacleKind,
  type ResourceType,
  type TileType,
} from '@nw/shared/slg';
import { VIEW_PAD_FACTOR } from '../constants';
import { camera, cityStore, terrainStore } from '../editor';
import { t } from '../i18n';
import { baseLayer } from '../stage';
import { cityCountLabel, setStatus, tileCountLabel } from '../ui/status';
import { renderTerrainTitle } from '../ui/panels';
import { drawEditorTile } from './tileGraphics';
import { terrainTextureName } from './tileStyle';

export interface EffectiveTile {
  type: TileType;
  level: number;
  resType?: ResourceType;
  obstacleKind?: ObstacleKind;
}

/** "x:y" → tile override for the current world, refreshed by renderBaseMap(); reused by hover info. */
let diffCache = new Map<string, MapTemplateTile>();

/** "tx:ty" → last-drawn Graphics + a signature of the tile state it reflects; lets renderBaseMap()
 * skip destroying/recreating tiles whose effective terrain hasn't changed since the last render. */
const tileGraphicsCache = new Map<string, { g: PIXI.Graphics; sig: string }>();

/** What a tile actually looks like right now: the editor's override if any, else the procedural baseline. */
export function effectiveTile(worldId: string, x: number, y: number): EffectiveTile {
  return diffCache.get(`${x}:${y}`) ?? proceduralTile(worldId, x, y);
}

export function renderBaseMap(worldId: string): void {
  const t0 = performance.now();
  // City footprints always win over painted terrain (DESIGN.md §6.2) — rasterize just the cities
  // (cheap: bounded by total city footprint area, not the whole painted grid), then overlay the
  // painted terrain grid directly (no distance/segment math needed — the grid already IS the tile
  // state, so this is a straight Map copy rather than a re-rasterization).
  const cityDiffs = rasterizeMapEdits(worldId, [], cityStore.nodes);
  diffCache = new Map(cityDiffs.map((d) => [`${d.x}:${d.y}`, d]));
  const CROSSING_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1);
  for (const [key, kind] of terrainStore.cells) {
    if (diffCache.has(key)) continue;
    const [xs, ys] = key.split(':');
    const x = Number(xs);
    const y = Number(ys);
    // Preview the painted cell as its baked tile: river/mountain keep their art kind; neutral carves the band
    // open; bridge/plankway show the capturable crossing building over the spanned terrain.
    const preview: MapTemplateTile =
      kind === 'river' ? { x, y, type: 'obstacle', level: 1, obstacleKind: 'river' }
      : kind === 'mountain' ? { x, y, type: 'obstacle', level: 1, obstacleKind: 'mountain' }
      : kind === 'neutral' ? { x, y, type: 'neutral', level: 1 }
      : { x, y, type: kind, level: CROSSING_LEVEL }; // bridge | plankway
    diffCache.set(key, preview);
  }

  const { x0, x1, y0, y1 } = camera.visibleRange(VIEW_PAD_FACTOR);

  // Only (re)create Graphics for tiles whose effective terrain actually changed since the last render —
  // reusing everything else turns a brush tick's cost into O(tiles the stroke touched) instead of
  // O(entire padded viewport), which is what made painting laggy (destroy+recreate every visible tile
  // on every mousemove).
  const nextKeys = new Set<string>();
  let count = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const key = `${tx}:${ty}`;
      nextKeys.add(key);
      const tile = effectiveTile(worldId, tx, ty);
      const texName = terrainTextureName(tile.type, tx, ty, tile.obstacleKind);
      const sig = `${tile.type}|${tile.level}|${tile.resType ?? ''}|${tile.obstacleKind ?? ''}|${texName}|${camera.tp}`;
      const cached = tileGraphicsCache.get(key);
      if (cached && cached.sig === sig) {
        count++;
        continue;
      }
      if (cached) {
        baseLayer.removeChild(cached.g);
        cached.g.destroy({ children: true });
      }
      const g = new PIXI.Graphics();
      const s = camera.layerOf(tx, ty);
      g.x = s.x;
      g.y = s.y;
      g.zIndex = tx + ty;
      drawEditorTile(g, tile, texName, camera.tp, tx, ty, worldId);
      baseLayer.addChild(g);
      tileGraphicsCache.set(key, { g, sig });
      count++;
    }
  }
  for (const [key, entry] of tileGraphicsCache) {
    if (!nextKeys.has(key)) {
      baseLayer.removeChild(entry.g);
      entry.g.destroy({ children: true });
      tileGraphicsCache.delete(key);
    }
  }
  const ms = (performance.now() - t0).toFixed(0);
  renderTerrainTitle();
  setStatus(() =>
    t('status.rendered', {
      worldId,
      tiles: tileCountLabel(count),
      ms,
      painted: tileCountLabel(terrainStore.size),
      cities: cityCountLabel(cityStore.nodes.length),
    }),
  );
}
