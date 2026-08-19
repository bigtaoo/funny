// Split from mapgen.ts (2026-08-10, independent function module range 6, part 7/7).
// The top-level per-tile classifier (proceduralTile) that composes terrain.ts/biome.ts/cities.ts/
// levelDist.ts, plus obstacleShoreAt (the shore-wash lookup) which recurses into proceduralTile for
// neighbor tiles — both live here (rather than in terrain.ts) precisely because that recursion means
// this file must sit "above" terrain.ts in the import graph, not beside it.
import { cityFootprint, SLG_GEN, SLG_MAP_H, SLG_MAP_MAX_LEVEL, SLG_MAP_W, type ObstacleKind } from '../core';
import { valueNoise, worldSeed, rand2 } from '../noise';
import {
  capitalIdxAt, NATION_KIND_BY_IDX, PROVINCE_CORE_RADIUS_RATIO, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO,
  provinceCapitalPositions, provinceIdxAt, _MAP_HALF_DIAGONAL,
} from '../province';
import type { ProceduralTile } from './types';
import { obstacleTile } from './types';
import { biomeAt, resTypeFor } from './biome';
import { _branchKindAt, _crossingTile, _riverChordAt, _ringTerrainAt, RIVER_CHORD_COUNT } from './terrain';
import { _inCityBackBands, _worldCityNodes, PROVINCE_CAPITAL_LEVEL, RESOURCE_LEVEL_CAP_NEAR_CITY, WORLD_CENTER_FOOTPRINT } from './cities';
import { _levelFromRing } from './levelDist';

/**
 * Computes the procedural default tile for (worldId, x, y). Pure function, deterministic, never persisted.
 * Distribution rules (ADR-034, 2026-07-05): a 9×9 world-center footprint (core province's hegemony objective);
 * province capitals + graded/gate city nodes (siege points); ring-boundary/river/branch terrain bands (impassable,
 * with free gates only on the two main province rings); otherwise a per-ring (outer/resource/core) level
 * distribution table (§4) + the existing biome/stronghold/keep mechanics, now gated by distance to the tile's
 * own province capital rather than the old nearest-capital Voronoi `dr`.
 */
export function proceduralTile(world: string, x: number, y: number): ProceduralTile {
  const seed = worldSeed(world);
  const mapW = SLG_MAP_W;
  const mapH = SLG_MAP_H;

  // World-center 9×9 footprint (unique) — core province's hegemony capital / city.
  const wcx = Math.floor(mapW / 2);
  const wcy = Math.floor(mapH / 2);
  const wcR = (WORLD_CENTER_FOOTPRINT - 1) / 2;
  if (Math.abs(x - wcx) <= wcR && Math.abs(y - wcy) <= wcR) {
    return { type: 'center', level: SLG_MAP_MAX_LEVEL };
  }

  const caps = provinceCapitalPositions(mapW, mapH, seed);
  const capIdx = capitalIdxAt(x, y, caps);
  if (capIdx >= 0) {
    return { type: 'familyKeep', level: PROVINCE_CAPITAL_LEVEL, resType: biomeAt(x, y, seed) };
  }

  for (const node of _worldCityNodes(mapW, mapH, seed)) {
    if (node.x === x && node.y === y) {
      return { type: 'familyKeep', level: node.level, resType: biomeAt(x, y, seed) };
    }
  }

  return proceduralTileIgnoringCities(world, x, y);
}

/**
 * `proceduralTile()` minus its three city-ground branches (world-center block / province-capital anchor /
 * graded-city anchor): what the land under a procedural city would have been classified as if no city
 * stood there. Split out 2026-08-19 for the map editor's publish path — when a designer DRAGS a city
 * node, `rasterizeMapEdits()` has to paint the city's new footprint AND hand the vacated procedural
 * anchor back to the terrain, otherwise the old spot keeps its `familyKeep`/`center` city ground and
 * renders as a phantom city plot with no building on it (a 9×9 one for the world center).
 *
 * Caveat, deliberately not solved here: the resource-level cap in a city's occluded back-bands
 * (`_inCityBackBands` / `RESOURCE_LEVEL_CAP_NEAR_CITY`) is still keyed off the PROCEDURAL city
 * positions, so a moved city leaves its old back-band cap behind and does not cap behind its new
 * position. That is a level-distribution artifact (max resource level 5 vs the ring's own roll), not a
 * render bug — the editor can hand-paint any tile whose level actually matters (see the
 * `RESOURCE_LEVEL_CAP_NEAR_CITY` comment in cities.ts).
 */
export function proceduralTileIgnoringCities(world: string, x: number, y: number): ProceduralTile {
  const seed = worldSeed(world);
  const mapW = SLG_MAP_W;
  const mapH = SLG_MAP_H;
  const wcx = Math.floor(mapW / 2);
  const wcy = Math.floor(mapH / 2);
  const caps = provinceCapitalPositions(mapW, mapH, seed);

  // Terrain: 2 main province rings, then river chords, then birth-province branches — first match wins.
  // Ring boundaries are the crease ridges (→ mountain art, crossings = plankway); the two crossing
  // chords are the ink rivers (→ river art, crossings = bridge); branches alternate mountain-spur /
  // river-tributary (see _branchKindAt). A 'crossing' result is a capturable passage building (siege-to-pass).
  const ring1 = _ringTerrainAt(x, y, seed, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO, 0x0a01);
  if (ring1) return ring1 === 'crossing' ? _crossingTile('mountain') : obstacleTile('mountain');
  const ring0 = _ringTerrainAt(x, y, seed, PROVINCE_CORE_RADIUS_RATIO, 0x0a02);
  if (ring0) return ring0 === 'crossing' ? _crossingTile('mountain') : obstacleTile('mountain');
  for (let c = 0; c < RIVER_CHORD_COUNT; c++) {
    const river = _riverChordAt(x, y, seed, c);
    if (river) return river === 'crossing' ? _crossingTile('river') : obstacleTile('river');
  }
  const branch = _branchKindAt(x, y, seed);
  if (branch) return branch.crossing ? _crossingTile(branch.kind) : obstacleTile(branch.kind);

  // Province + per-ring level distribution (ADR-034 §4).
  const provIdx = provinceIdxAt(x, y);
  const kind = NATION_KIND_BY_IDX[provIdx]!;
  const lvlNoise = valueNoise(x, y, SLG_GEN.levelFreq, seed ^ 0x0111);
  let level = _levelFromRing(kind, lvlNoise);

  // Cap resource level in a city's occluded back-bands (see RESOURCE_LEVEL_CAP_NEAR_CITY docs above) —
  // world center, this tile's own province capital, and any graded/gate city node.
  if (
    _inCityBackBands(x, y, wcx, wcy, WORLD_CENTER_FOOTPRINT)
    || caps.some(([cx, cy]) => _inCityBackBands(x, y, cx, cy, cityFootprint(PROVINCE_CAPITAL_LEVEL)))
    || _worldCityNodes(mapW, mapH, seed).some((n) => _inCityBackBands(x, y, n.x, n.y, cityFootprint(n.level)))
  ) {
    level = Math.min(level, RESOURCE_LEVEL_CAP_NEAR_CITY);
  }

  // Stronghold spacing (unchanged mechanics), measured from the tile's own province capital.
  //
  // The old sibling of this branch — a scattered `familyKeep` ("关隘") classification gated by
  // `valueNoise(x, y, SLG_GEN.keepFreq) > SLG_GEN.keepThreshold` — was DELETED 2026-08-19. Two
  // problems, one of which the stronghold comment right above `strongholdThreshold` already warned
  // about in the abstract:
  //   • Smooth value-noise over a threshold produces contiguous BLOBS, not the "sparse strategic
  //     point" the type was documented as. Measured on the shipping 1500×1500 map: 74,124 keep tiles
  //     (3.3% of the map) in 472 connected blobs, the largest 1,745 tiles / 68×56 bbox. Every one of
  //     those tiles stamps its own `building_keep` gatehouse sprite at 1.3× tile size (client
  //     tileGraphics/tiles.ts), so a blob rendered as one giant wall of overlapping masonry.
  //   • The type had no mechanics left to justify the space: passage was migrated to capturable
  //     bridge/plankway tiles (SLG_DESIGN §"统一通道机制"), so a keep gated nothing, carried no NPC
  //     garrison of its own, dropped no capture reward and had no info text — it was just a
  //     level-9-forced resource tile wearing castle art.
  // These cells now fall through to the ordinary resource/neutral classification below, so the land
  // is still claimable — it just reads as (and yields like) the resource tier its ring says it is.
  // `familyKeep` survives ONLY as city GROUND: the province-capital / graded-city node branches in
  // `proceduralTile` above, and the map-editor's city-footprint rasterization (mapEdit.ts). If a real
  // chokepoint mechanic is ever designed, reintroduce it with a per-tile Bernoulli hash (see
  // `strongholdThreshold`), never a smooth-noise threshold.
  const [capX, capY] = caps[provIdx]!;
  const distToCap = Math.sqrt((x - capX) ** 2 + (y - capY) ** 2) / _MAP_HALF_DIAGONAL;
  const strongholdRand = rand2(x, y, seed ^ 0x0555);
  if (strongholdRand > SLG_GEN.strongholdThreshold && distToCap > SLG_GEN.strongholdMinDistRatio) {
    return { type: 'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(x, y, seed) };
  }

  // Resource tile vs neutral open land
  const occ = rand2(x, y, seed ^ 0x0333);
  if (occ < SLG_GEN.resourceDensity) {
    return { type: 'resource', level, resType: resTypeFor(x, y, seed, level) };
  }
  return { type: 'neutral', level: Math.min(level, SLG_GEN.neutralLevelCap) };
}

/** Neighbor offsets for {@link obstacleShoreAt}: orthogonal edges read as "closer" to the obstacle
 * than diagonal corners, so they carry more shore-wash weight. */
const _SHORE_NEIGHBORS: readonly [number, number, number][] = [
  [1, 0, 0.45], [-1, 0, 0.45], [0, 1, 0.45], [0, -1, 0.45],
  [1, 1, 0.25], [1, -1, 0.25], [-1, 1, 0.25], [-1, -1, 0.25],
];

/**
 * "Shore" wash for a non-obstacle tile bordering a river/mountain band (2026-07-12 edge-blend pass):
 * ring/river-chord/branch bands are rasterized as a hard per-tile boolean (obstacle vs not), which reads
 * as an abrupt cut where the hand-drawn mountain/river art meets grass, even though the band's underlying
 * boundary line already wobbles organically (see `_ringTerrainAt`/`_riverChordAt`). Rather than reworking
 * the three band shapes to emit a fractional distance (they're geometrically distinct — circle/line/line —
 * and none carry sub-tile resolution), this looks at the already-computed neighbor tiles and, for a tile
 * touching an obstacle, returns that obstacle's art kind + a faded wash alpha so the render layer (tileGraphics
 * drawTileL1 / map-editor drawEditorTile) can paint a soft "bank" fringe on the land side of the boundary
 * instead of a hard texture swap. Returns null for obstacle tiles themselves (they render at full strength;
 * see the ProceduralTile.type check at each call site) and for land tiles with no adjacent obstacle.
 * Orthogonal neighbors weigh more than diagonal-only ones so a tile touching the band's flat edge reads
 * stronger than one only grazing its corner. Must stay in lockstep with the map-editor's drawEditorTile
 * (SLG map render parity).
 */
export function obstacleShoreAt(world: string, x: number, y: number): { kind: ObstacleKind; alpha: number } | null {
  let best: ObstacleKind | null = null;
  let bestW = 0;
  for (const [dx, dy, w] of _SHORE_NEIGHBORS) {
    if (w <= bestW) continue;
    const n = proceduralTile(world, x + dx, y + dy);
    if (n.type === 'obstacle' && n.obstacleKind) { best = n.obstacleKind; bestW = w; }
  }
  return best ? { kind: best, alpha: bestW } : null;
}
