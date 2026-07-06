// Map editor rasterization (DESIGN.md §6.2 "两者都是覆盖在 proceduralTile() 之上的编辑层"): turns the
// editor's overlays (river/mountain terrain-grid cells + city point nodes) into a flat MapTemplateTile
// diff against the proceduralTile() baseline, so a "publish" action can push exactly the changed tiles
// via the existing §24 saveTilesDiff endpoint. One-way bake: the editor's own JSON export/import
// round-trips the terrain grid for re-editing (see state/terrainGrid.ts/cities.ts) — this module never
// needs to invert tiles back into grid cells/cities.
import { SLG_MAP_H, SLG_MAP_W, type ObstacleKind, type ResourceType, type TileType } from './core';
import { biomeAt, proceduralTile, type MapTemplateTile } from './mapgen';
import { worldSeed } from './noise';

export interface MapEditTileInput {
  x: number;
  y: number;
  type: 'river' | 'mountain';
}

export interface MapEditCityInput {
  x: number;
  y: number;
  level: number;
  footprint: number;
  kind: 'capital' | 'gateCity' | 'worldCenter' | 'garrison';
}

function _cityTileType(kind: MapEditCityInput['kind']): TileType {
  return kind === 'worldCenter' ? 'center' : 'familyKeep';
}

interface _Override {
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** Preserved for obstacle overrides so a painted river/mountain keeps its art kind through publish (§2.2: same passability, distinct art). */
  obstacleKind?: ObstacleKind;
}

/**
 * Rasterizes the editor's terrain-grid + city overlays into a tile-level diff against `proceduralTile(worldId, ...)`.
 * Only returns tiles whose resulting type/level/resType actually differ from the baseline (§24 "只上发本次
 * 改动的格子") — untouched terrain is never included. City nodes are applied after terrain tiles so a
 * dragged city footprint always wins over any terrain it now overlaps.
 */
export function rasterizeMapEdits(
  worldId: string,
  tiles: readonly MapEditTileInput[],
  cities: readonly MapEditCityInput[],
): MapTemplateTile[] {
  const seed = worldSeed(worldId);
  const overrides = new Map<string, _Override>();

  for (const tile of tiles) {
    if (tile.x < 0 || tile.x >= SLG_MAP_W || tile.y < 0 || tile.y >= SLG_MAP_H) continue;
    // river/mountain share the same impassable 'obstacle' type + level 1 (§2.2), but keep the painted
    // art kind so the tile renders as what the user actually painted rather than the position-hash flip.
    overrides.set(`${tile.x}:${tile.y}`, { type: 'obstacle', level: 1, obstacleKind: tile.type });
  }

  for (const city of cities) {
    const half = Math.floor(city.footprint / 2);
    const type = _cityTileType(city.kind);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = city.x + dx;
        const y = city.y + dy;
        if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue;
        overrides.set(`${x}:${y}`, { type, level: city.level, resType: type === 'familyKeep' ? biomeAt(x, y, seed) : undefined });
      }
    }
  }

  const diffs: MapTemplateTile[] = [];
  for (const [key, tile] of overrides) {
    const [xs, ys] = key.split(':');
    const x = Number(xs);
    const y = Number(ys);
    const base = proceduralTile(worldId, x, y);
    if (base.type !== tile.type || base.level !== tile.level || base.resType !== tile.resType || base.obstacleKind !== tile.obstacleKind) {
      diffs.push({ x, y, type: tile.type, level: tile.level, ...(tile.resType ? { resType: tile.resType } : {}), ...(tile.obstacleKind ? { obstacleKind: tile.obstacleKind } : {}) });
    }
  }
  return diffs;
}
