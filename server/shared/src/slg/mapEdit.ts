// Map editor rasterization (DESIGN.md §6.2 "both are editing layers overlaid on top of proceduralTile()"): turns the
// editor's overlays (river/mountain terrain-grid cells + city point nodes) into a flat MapTemplateTile
// diff against the proceduralTile() baseline, so a "publish" action can push exactly the changed tiles
// via the existing §24 saveTilesDiff endpoint. One-way bake: the editor's own JSON export/import
// round-trips the terrain grid for re-editing (see state/terrainGrid.ts/cities.ts) — this module never
// needs to invert tiles back into grid cells/cities.
import { SLG_MAP_H, SLG_MAP_MAX_LEVEL, SLG_MAP_W, type ObstacleKind, type ResourceType, type TileType } from './core';
import {
  biomeAt, proceduralCityGroundTiles, proceduralTile, proceduralTileIgnoringCities,
  type MapTemplateTile,
} from './mapgen';
import { worldSeed } from './noise';

/**
 * A painted terrain-grid cell. `river`/`mountain` bake to impassable `obstacle`; `neutral` carves a band
 * open (obstacle → passable land, so designers can shrink a mountain/river); `bridge`/`plankway` place a
 * capturable crossing building over a carved gap (siege-to-pass, gate→bridge/plankway migration).
 */
export interface MapEditTileInput {
  x: number;
  y: number;
  type: 'river' | 'mountain' | 'neutral' | 'bridge' | 'plankway';
}

export interface MapEditCityInput {
  x: number;
  y: number;
  level: number;
  footprint: number;
  kind: 'capital' | 'worldCenter' | 'garrison';
}

/**
 * Level every crossing building spawns at — procedural auto-crossings (mapgen `_crossingTile`) and
 * hand-placed ones alike. Exported (2026-08-25) because `Math.max(2, SLG_MAP_MAX_LEVEL - 1)` had been
 * open-coded in three places — here, `econ-sim/strongholdCombat.ts`, and siege.ts's doc comment as the
 * prose "currently 9" — which is the same shape as the constant drift ADR-075 spent its whole day on.
 * The garrison a player actually faces is `passageGarrison(CROSSING_TILE_LEVEL)`.
 */
export const CROSSING_TILE_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1);

function _cityTileType(kind: MapEditCityInput['kind']): TileType {
  return kind === 'worldCenter' ? 'center' : 'familyKeep';
}

/** Converts a painted terrain-grid cell into its tile override (type + level + optional obstacle art kind). */
function _terrainOverride(type: MapEditTileInput['type']): _Override {
  switch (type) {
    case 'river':    return { type: 'obstacle', level: 1, obstacleKind: 'river' };
    case 'mountain': return { type: 'obstacle', level: 1, obstacleKind: 'mountain' };
    case 'neutral':  return { type: 'neutral', level: 1 };
    case 'bridge':   return { type: 'bridge', level: CROSSING_TILE_LEVEL };
    case 'plankway': return { type: 'plankway', level: CROSSING_TILE_LEVEL };
  }
}

/** Options for {@link rasterizeMapEdits}. */
export interface RasterizeOpts {
  /**
   * Declares that `cities` is the COMPLETE city layer for this world, not a subset — which lets the
   * rasterizer hand every procedural city-ground tile no city in the list still stands on back to plain
   * terrain (`proceduralTileIgnoringCities`).
   *
   * Needed because a DRAGGED city otherwise leaves its old `familyKeep`/`center` ground behind — a phantom
   * city plot with no building standing on it, 9×9 of it for the world center. It cannot be the default:
   * with a partial list (one city under test, say) the revert would erase every city the caller never
   * mentioned. Both of tools/map-editor's call sites — the live preview (render/baseMap.ts) and Publish
   * (ui/publish.ts) — pass the store's full node list and must set this IDENTICALLY, or the WYSIWYG
   * guarantee between preview and upload breaks.
   */
  citiesAreComplete?: boolean;
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
 * Only returns tiles whose resulting type/level/resType actually differ from the baseline (§24 "only upload
 * the tiles changed this time") — untouched terrain is never included. City nodes are applied after terrain tiles so a
 * dragged city footprint always wins over any terrain it now overlaps.
 *
 * Order of the three override passes, lowest priority first:
 *   1. Vacated procedural city anchors → back to plain terrain (`proceduralTileIgnoringCities`). Requires
 *      `opts.citiesAreComplete` — see {@link RasterizeOpts}.
 *   2. Painted terrain cells (river/mountain/neutral/bridge/plankway).
 *   3. City footprints — always win (DESIGN.md §6.2).
 */
export function rasterizeMapEdits(
  worldId: string,
  tiles: readonly MapEditTileInput[],
  cities: readonly MapEditCityInput[],
  opts: RasterizeOpts = {},
): MapTemplateTile[] {
  const seed = worldSeed(worldId);
  const overrides = new Map<string, _Override>();

  // Pass 1: hand every procedural city-ground tile back to the terrain. Tiles a city in `cities` still
  // stands on are re-claimed by pass 3 below; the rest stop being city ground, which is exactly what a
  // dragged city has to leave behind. Opt-in — see RasterizeOpts.citiesAreComplete.
  for (const { x, y } of opts.citiesAreComplete ? proceduralCityGroundTiles(worldId) : []) {
    const bare = proceduralTileIgnoringCities(worldId, x, y);
    overrides.set(`${x}:${y}`, {
      type: bare.type, level: bare.level,
      ...(bare.resType ? { resType: bare.resType } : {}),
      ...(bare.obstacleKind ? { obstacleKind: bare.obstacleKind } : {}),
    });
  }

  for (const tile of tiles) {
    if (tile.x < 0 || tile.x >= SLG_MAP_W || tile.y < 0 || tile.y >= SLG_MAP_H) continue;
    // river/mountain bake to impassable obstacle (keeping the painted art kind); neutral carves a band open;
    // bridge/plankway drop a capturable crossing building over a carved gap.
    overrides.set(`${tile.x}:${tile.y}`, _terrainOverride(tile.type));
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
