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
/**
 * Per-outer-province graded city level tiers (ADR-034 §3: 2×3 + 2×4 + 2×5 + 1×6 + 1×7 + 1×8 = 9
 * cities/province, 54 total). Exported since ADR-074: `citySiege.ts` derives
 * {@link WILD_CITY_MIN_LEVEL} from it rather than re-stating "the weakest wild city is level 3", which
 * is the level the single-player-proof siege invariant is measured against.
 */
export const OUTER_GRADED_CITY_TIERS: readonly number[] = [3, 3, 4, 4, 5, 5, 6, 7, 8];
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

/** True if (x,y) falls inside the square `footprint`×`footprint` block centred on (cx,cy). */
export function _inCityFootprint(x: number, y: number, cx: number, cy: number, footprint: number): boolean {
  const r = (footprint - 1) / 2;
  return Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
}

/**
 * The province-capital / graded city whose **footprint** covers (x,y), or null (ADR-074).
 *
 * Before ADR-074 `proceduralTile` matched city positions with `capitalIdxAt` / `node.x === x && node.y === y`
 * — i.e. it classified only a city's single ANCHOR cell as `familyKeep`, while the client drew a
 * `cityFootprint(level)`-sized sprite over it. A Lv.8 city was therefore 1 cell of city ground plus 48
 * ordinary resource tiles hidden under the artwork, each independently occupiable by any single player
 * (用户 2026-08-25 截图: 城墙内部弹出「墨水 Lv.2 / 建议兵力 240」的普通占领框). The map editor's publish path
 * (`rasterizeMapEdits`) had always stamped the WHOLE footprint, so the two map-generation paths also
 * disagreed about the same city. This function is the fix for both: footprint containment, matching
 * `rasterizeMapEdits`.
 *
 * Capitals are tested before graded cities so that an overlap resolves the same way the old anchor-match
 * ordering did (capital branch came first). The world center is NOT handled here — it has always covered
 * its full `WORLD_CENTER_FOOTPRINT` block and is classified as `center`, not `familyKeep`, by
 * `proceduralTile` before it ever reaches this function.
 */
export function _cityGroundNodeAt(
  mapW: number,
  mapH: number,
  seed: number,
  x: number,
  y: number,
): { level: number } | null {
  const caps = provinceCapitalPositions(mapW, mapH, seed);
  const capFootprint = cityFootprint(PROVINCE_CAPITAL_LEVEL);
  for (let i = 0; i < caps.length; i++) {
    // The core province's "capital" IS the world center (provinceCapitalPositions pins it to the exact map
    // center). `allCityNodes` skips it for the same reason, and `proceduralTile` classifies that block as
    // `center` before reaching here — claiming it as a `familyKeep` capital footprint too would only matter
    // if this function were ever called first, and then it would be wrong (no city sprite is drawn for it).
    if (i === CENTER_CAPITAL_IDX) continue;
    const [cx, cy] = caps[i]!;
    if (_inCityFootprint(x, y, cx, cy, capFootprint)) return { level: PROVINCE_CAPITAL_LEVEL };
  }
  for (const node of _worldCityNodes(mapW, mapH, seed)) {
    if (_inCityFootprint(x, y, node.x, node.y, cityFootprint(node.level))) return { level: node.level };
  }
  return null;
}

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
    for (let ci = 0; ci < OUTER_GRADED_CITY_TIERS.length; ci++) {
      const salt = seed ^ 0x0f00 ^ (p * 100 + ci);
      const angle = angleLo + rand2(p, ci, salt) * (angleHi - angleLo);
      const rNorm = PROVINCE_RESOURCE_OUTER_RADIUS_RATIO + 0.05
        + rand2(p, ci + 50, salt ^ 0x01) * (0.88 - PROVINCE_RESOURCE_OUTER_RADIUS_RATIO - 0.05);
      const r = rNorm * halfDiag;
      const x = Math.max(0, Math.min(mapW - 1, Math.round(cx + Math.cos(angle) * r)));
      const y = Math.max(0, Math.min(mapH - 1, Math.round(cy + Math.sin(angle) * r)));
      nodes.push({ x, y, level: OUTER_GRADED_CITY_TIERS[ci]!, kind: 'garrison', provinceIdx: p });
    }
  }

  _cityNodeCache.set(seed, nodes);
  return nodes;
}

/**
 * One siege-point node (DESIGN.md §6.2 data form: point nodes, not tile coverage).
 *
 * No longer editor-only, despite the name (kept to avoid a rename across client/editor/server call
 * sites): since 2026-08-19 this is also the PUBLISHED form — the map editor uploads its (possibly
 * dragged) node list next to the tile diff, worldsvc stores it on the template, clones it into each
 * world at world-open, and serves it back on `POST /world/enter` so the game's city sprite layer draws
 * the cities that are actually there instead of recomputing `allCityNodes()` from the seed. See
 * `rasterizeMapEdits` (mapEdit.ts) for the tile side of the same publish.
 */
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
 * center) + graded cities from `_worldCityNodes`. `proceduralTile()` above computes these positions
 * independently (not from this list) for the runtime tile classification. Crossings (bridge/plankway)
 * are terrain tiles, not city nodes, so they are not listed here.
 *
 * This is the SEED-DERIVED node list — the editor's starting point, and the fallback for a world whose
 * template predates published city nodes. It is NOT what the game should render for a world cloned from
 * an edited template: read the served list (`POST /world/enter`'s `cities`) instead, which reflects any
 * drag the designer published. Two ways this function is wrong for such a world: dragged nodes obviously
 * moved, and — even with nothing dragged — a template is generated with `proceduralTile(templateId, …)`,
 * so a world whose id differs from its templateId gets terrain on the template's seed but would get
 * cities on its own.
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

/**
 * Every tile `proceduralTile()` classifies as city GROUND for `worldId`: **the whole footprint of every
 * city** — world center, province capitals and graded cities alike.
 *
 * Until ADR-074 (2026-08-25) this was asymmetric: only the world center covered its full footprint, while
 * a capital/garrison contributed its single anchor cell, because that is all `proceduralTile` classified.
 * That asymmetry was the bug, not a design choice (see `_cityGroundNodeAt`), and it is gone on both sides.
 *
 * The map editor's publish path needs this list to hand a VACATED footprint back to the terrain when a
 * designer drags a city elsewhere (see `rasterizeMapEdits`). Derived from `allCityNodes()` so it cannot
 * drift from the node list itself; a regression test pins it against `proceduralTile()`.
 *
 * Cities near a map edge have their footprints clipped to the map, and two cities' footprints may overlap
 * — so callers must treat the result as a SET of coordinates, not a count (it can contain duplicates).
 */
export function proceduralCityGroundTiles(worldId: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const node of allCityNodes(worldId)) {
    const r = (node.footprint - 1) / 2;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue;
        out.push({ x, y });
      }
    }
  }
  return out;
}

/** The three node kinds a published city list may carry (see {@link MapEditorCityNode.kind}). */
const _CITY_KINDS: readonly MapEditorCityNode['kind'][] = ['capital', 'worldCenter', 'garrison'];

/**
 * Validates an untrusted city-node list (the admin publish payload) into `MapEditorCityNode[]`, or
 * throws. Lives here rather than in the worldsvc route so the map editor's own JSON import
 * (`CityStore.loadFromJSON`) and the server agree on exactly one notion of "a well-formed node".
 * Coordinates must be integers inside the map; `footprint` must be a positive odd number (the
 * rasterizer centers the plot on the node, so an even side length has no center tile).
 */
export function parseCityNodes(raw: unknown): MapEditorCityNode[] {
  if (!Array.isArray(raw)) throw new Error('expected an array of city nodes');
  return raw.map((entry, i) => {
    const n = entry as Partial<MapEditorCityNode>;
    const bad = (why: string): never => { throw new Error(`city node #${i}: ${why}`); };
    if (typeof n.id !== 'string' || !n.id) bad('id must be a non-empty string');
    if (!_CITY_KINDS.includes(n.kind as MapEditorCityNode['kind'])) bad(`invalid kind ${String(n.kind)}`);
    if (!Number.isInteger(n.x) || n.x! < 0 || n.x! >= SLG_MAP_W) bad(`x out of range: ${String(n.x)}`);
    if (!Number.isInteger(n.y) || n.y! < 0 || n.y! >= SLG_MAP_H) bad(`y out of range: ${String(n.y)}`);
    if (!Number.isInteger(n.level) || n.level! < 1 || n.level! > SLG_MAP_MAX_LEVEL) bad(`level out of range: ${String(n.level)}`);
    if (!Number.isInteger(n.footprint) || n.footprint! < 1 || n.footprint! % 2 === 0) bad(`footprint must be a positive odd integer: ${String(n.footprint)}`);
    return {
      id: n.id!, kind: n.kind!, x: n.x!, y: n.y!, level: n.level!, footprint: n.footprint!,
      ...(Number.isInteger(n.provinceIdx) ? { provinceIdx: n.provinceIdx! } : {}),
    };
  });
}
