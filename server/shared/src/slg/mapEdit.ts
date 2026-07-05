// Map editor rasterization (DESIGN.md §6.2 "两者都是覆盖在 proceduralTile() 之上的编辑层"): turns the
// editor's vector overlays (river/mountain paths + city point nodes) into a flat MapTemplateTile diff
// against the proceduralTile() baseline, so a "publish" action can push exactly the changed tiles via
// the existing §24 saveTilesDiff endpoint. One-way bake: the editor's own JSON export/import round-trips
// the vector layer for re-editing (see paths.ts/cities.ts) — this module never needs to invert tiles
// back into paths/cities.
import { SLG_MAP_H, SLG_MAP_W, type ResourceType, type TileType } from './core';
import { biomeAt, proceduralTile, type MapTemplateTile } from './mapgen';
import { worldSeed } from './noise';

export interface MapEditPathInput {
  type: 'river' | 'mountain';
  points: readonly { x: number; y: number }[];
  width: number;
}

export interface MapEditCityInput {
  x: number;
  y: number;
  level: number;
  footprint: number;
  kind: 'capital' | 'gateCity' | 'worldCenter' | 'garrison';
}

/** Perpendicular distance (in tiles) from a point to the nearest point on segment [a,b] — local copy; the
 * editor's own `distToSegment` (tools/map-editor/src/state/paths.ts) serves client-side hit-testing, a
 * different call site not worth sharing across the tool/shared-package boundary. */
function _distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Both river and mountain paths rasterize to the same impassable terrain (DESIGN.md §2.2 "两者都是完全不可通行地形"). */
const _PATH_TILE: { type: TileType; level: number } = { type: 'obstacle', level: 1 };

function _cityTileType(kind: MapEditCityInput['kind']): TileType {
  return kind === 'worldCenter' ? 'center' : 'familyKeep';
}

interface _Override {
  type: TileType;
  level: number;
  resType?: ResourceType;
}

/**
 * Rasterizes the editor's path + city overlays into a tile-level diff against `proceduralTile(worldId, ...)`.
 * Only returns tiles whose resulting type/level/resType actually differ from the baseline (§24 "只上发本次
 * 改动的格子") — untouched terrain is never included. City nodes are applied after paths so a dragged city
 * footprint always wins over any terrain it now overlaps.
 */
export function rasterizeMapEdits(
  worldId: string,
  paths: readonly MapEditPathInput[],
  cities: readonly MapEditCityInput[],
): MapTemplateTile[] {
  const seed = worldSeed(worldId);
  const overrides = new Map<string, _Override>();

  for (const path of paths) {
    const half = path.width / 2;
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i]!;
      const b = path.points[i + 1]!;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - half));
      const x1 = Math.min(SLG_MAP_W - 1, Math.ceil(Math.max(a.x, b.x) + half));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - half));
      const y1 = Math.min(SLG_MAP_H - 1, Math.ceil(Math.max(a.y, b.y) + half));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (_distToSegment(x, y, a.x, a.y, b.x, b.y) <= half) {
            overrides.set(`${x}:${y}`, _PATH_TILE);
          }
        }
      }
    }
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
    if (base.type !== tile.type || base.level !== tile.level || base.resType !== tile.resType) {
      diffs.push({ x, y, type: tile.type, level: tile.level, ...(tile.resType ? { resType: tile.resType } : {}) });
    }
  }
  return diffs;
}
