// Split from mapgen.ts (2026-08-10, independent function module range 6, part 4/7).
// Cities (ADR-034 §3): point-node siege targets, layered on top of the procedural terrain.
// Province capitals (state capitals, §3 "province capital") are handled via `provinceCapitalPositions`; this section
// covers the other two node kinds. Kept as plain ProceduralTile classifications (familyKeep/center) rather
// than a separate node schema — garrison/HP numbers for cities-as-distinct-entities are explicitly an open
// question in the design doc (§5), not yet pinned down, so this is the faithful MVP of the "structure is
// locked, numbers are DRAFT" part of ADR-034.
import { cityFootprint, SLG_MAP_H, SLG_MAP_MAX_LEVEL, SLG_MAP_W } from '../core';
import { rand2, worldSeed } from '../noise';
import {
  CENTER_CAPITAL_IDX, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO, _TWO_PI,
  provinceCapitalPositions,
} from '../province';

/** World-center city footprint side length (ADR-034 §3: a "9×9 tile" solid, same family as BASE_FOOTPRINT but larger — the core province's contested objective). */
export const WORLD_CENTER_FOOTPRINT = 9;
/** Per-outer-province graded city level tiers (ADR-034 §3: 2×3 + 2×4 + 2×5 + 1×6 + 1×7 + 1×8 = 9 cities/province, 54 total). */
const _OUTER_GRADED_CITY_TIERS: readonly number[] = [3, 3, 4, 4, 5, 5, 6, 7, 8];
/** State-capital city level (DRAFT — a province's capital is its strongest city). */
export const PROVINCE_CAPITAL_LEVEL = SLG_MAP_MAX_LEVEL;

// ── Resource level cap behind a city (2026-07-11, placeholder tuning) ──────────────────────────
// A city sprite is tall enough to visually occlude tiles behind it — in this iso projection (see
// client isoGrid.ts tileToScreen) that's specifically the tiles toward -x ("up-left" on screen) and
// toward -y ("up-right" on screen) from the city's own footprint, NOT the front/left/right sides
// (those are already guaranteed clear by the sprite's plot-diamond mask, see WorldMapRenderer/city.ts).
// Rather than solve "is this tile still capturable" with more rendering tricks, cap those two
// occluded bands' resource level low enough that players don't care they can't see them clearly.
// Finalized 2026-07-30 (user call): 5/5 stays as the generation-time default. Any specific tile that
// still needs a different level after generation gets hand-painted directly in tools/map-editor —
// these two constants aren't meant to be an editor-exposed dial, just the auto-gen starting point.
/** Max resource level allowed in a city's occluded back-bands (see {@link _inCityBackBands}). */
export const RESOURCE_LEVEL_CAP_NEAR_CITY = 5;
/** How many tiles deep the occluded back-bands extend past the city's own footprint edge. */
const RESOURCE_LEVEL_CAP_DEPTH = 5;

/**
 * True if (x,y) sits in one of the two tile-space bands a city's tall sprite visually occludes: the
 * `RESOURCE_LEVEL_CAP_DEPTH`-tile-deep strip immediately behind the footprint's -x edge ("up-left" on
 * screen) or -y edge ("up-right" on screen), spanning the footprint's own width on the perpendicular
 * axis. The other two sides (+x/+y, i.e. front-left/front-right on screen) are unaffected — those are
 * already fully visible (the sprite's own plot mask guarantees it never bleeds there).
 */
export function _inCityBackBands(x: number, y: number, cityX: number, cityY: number, footprint: number): boolean {
  const r = (footprint - 1) / 2;
  const inUpLeft = x >= cityX - r - RESOURCE_LEVEL_CAP_DEPTH && x < cityX - r && y >= cityY - r && y <= cityY + r;
  const inUpRight = y >= cityY - r - RESOURCE_LEVEL_CAP_DEPTH && y < cityY - r && x >= cityX - r && x <= cityX + r;
  return inUpLeft || inUpRight;
}

interface _CityNode { x: number; y: number; level: number; kind: 'garrison'; provinceIdx?: number; }

const _cityNodeCache = new Map<number, readonly _CityNode[]>();

// Note: crossings (passage across obstacle bands) are no longer city nodes — they are `bridge`/`plankway`
// tiles emitted directly by the terrain functions above (gate→bridge/plankway migration). The old branch
// gate-city nodes are gone; passage is carried entirely by those capturable crossing tiles.
/** Graded cities (54, §3) for a world, cached by seed. Excludes state capitals / world center (handled separately). */
export function _worldCityNodes(mapW: number, mapH: number, seed: number): readonly _CityNode[] {
  const cached = _cityNodeCache.get(seed);
  if (cached) return cached;
  const cx = mapW / 2;
  const cy = mapH / 2;
  const halfDiag = Math.sqrt(cx ** 2 + cy ** 2);
  const nodes: _CityNode[] = [];

  // 54 graded cities: 9 per outer (birth) province, scattered within its ring band with a margin from the sector edges (branches).
  for (let p = 0; p < 6; p++) {
    const sectorWidth = _TWO_PI / 6;
    const angleLo = p * sectorWidth + sectorWidth * 0.12;
    const angleHi = (p + 1) * sectorWidth - sectorWidth * 0.12;
    for (let ci = 0; ci < _OUTER_GRADED_CITY_TIERS.length; ci++) {
      const salt = seed ^ 0x0f00 ^ (p * 100 + ci);
      const angle = angleLo + rand2(p, ci, salt) * (angleHi - angleLo);
      const rNorm = PROVINCE_RESOURCE_OUTER_RADIUS_RATIO + 0.05
        + rand2(p, ci + 50, salt ^ 0x01) * (0.88 - PROVINCE_RESOURCE_OUTER_RADIUS_RATIO - 0.05);
      const r = rNorm * halfDiag;
      const x = Math.max(0, Math.min(mapW - 1, Math.round(cx + Math.cos(angle) * r)));
      const y = Math.max(0, Math.min(mapH - 1, Math.round(cy + Math.sin(angle) * r)));
      nodes.push({ x, y, level: _OUTER_GRADED_CITY_TIERS[ci]!, kind: 'garrison', provinceIdx: p });
    }
  }

  _cityNodeCache.set(seed, nodes);
  return nodes;
}

/** One siege-point node, for editor consumption (DESIGN.md §6.2 data form: point nodes, not tile coverage). */
export interface MapEditorCityNode {
  id: string;
  kind: 'capital' | 'worldCenter' | 'garrison';
  /** Owning province index (§2.1), present for `capital`/`garrison` (their province is fixed by generation); absent for `worldCenter` (belongs to the core province by definition). */
  provinceIdx?: number;
  x: number;
  y: number;
  level: number;
  /** Square footprint side length in tiles, derived from level via {@link cityFootprint} (3/5/7/9 by tier); `WORLD_CENTER_FOOTPRINT` for the world center. */
  footprint: number;
}

/**
 * All siege-point nodes for a world (ADR-034 §3), flattened for the map editor's city-drag tool (§6.1):
 * world center (1) + province capitals (9, excludes the core province — its "capital" *is* the world
 * center) + graded cities from `_worldCityNodes`. Editor-only — `proceduralTile()` above computes
 * these positions independently (not from this list) for the runtime tile classification. Crossings
 * (bridge/plankway) are terrain tiles, not city nodes, so they are not listed here.
 */
export function allCityNodes(worldId: string): MapEditorCityNode[] {
  const seed = worldSeed(worldId);
  const mapW = SLG_MAP_W;
  const mapH = SLG_MAP_H;
  const nodes: MapEditorCityNode[] = [];

  const wcx = Math.floor(mapW / 2);
  const wcy = Math.floor(mapH / 2);
  nodes.push({ id: 'worldCenter', kind: 'worldCenter', x: wcx, y: wcy, level: SLG_MAP_MAX_LEVEL, footprint: WORLD_CENTER_FOOTPRINT });

  const caps = provinceCapitalPositions(mapW, mapH, seed);
  caps.forEach(([x, y], provinceIdx) => {
    if (provinceIdx === CENTER_CAPITAL_IDX) return; // the core province's "capital" is the world center above
    nodes.push({ id: `capital-${provinceIdx}`, kind: 'capital', provinceIdx, x, y, level: PROVINCE_CAPITAL_LEVEL, footprint: cityFootprint(PROVINCE_CAPITAL_LEVEL) });
  });

  let garrisonIdx = 0;
  for (const node of _worldCityNodes(mapW, mapH, seed)) {
    nodes.push({ id: `garrison-${garrisonIdx++}`, kind: 'garrison', provinceIdx: node.provinceIdx, x: node.x, y: node.y, level: node.level, footprint: cityFootprint(node.level) });
  }
  return nodes;
}
