// SLG procedural map generation (core, §14.2 / U2 / U6 initial version; terrain ADR-034 §2.2/§2.3/§3) + map templates (§24).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

import { SLG_GEN, SLG_MAP_H, SLG_MAP_MAX_LEVEL, SLG_MAP_W, type ResourceType, type TileType } from './core';
import { valueNoise, worldSeed } from './noise';
import {
  _angleOf, _MAP_CX, _MAP_CY, _MAP_HALF_DIAGONAL, _normRadius, _TWO_PI,
  capitalIdxAt, CENTER_CAPITAL_IDX, NATION_KIND_BY_IDX, PROVINCE_CORE_RADIUS_RATIO, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO,
  provinceCapitalPositions, provinceIdxAt, type NationKind,
} from './province';
import { rand2 } from './noise';

/** Default attributes for a procedural tile (in an unclaimed neutral world). Once claimed at runtime, the DB document takes precedence. */
export interface ProceduralTile {
  type: TileType;
  /** Resource/tile level 1..SLG_MAP_MAX_LEVEL (higher = more yield and stronger default NPC garrison). */
  level: number;
  /** Resource type (only present for resource / familyKeep tiles). */
  resType?: ResourceType;
}

/**
 * Biome: low-frequency noise divides the map into four large land-resource zones (ink/paper/graphite/metal), encouraging resource
 * specialization and cross-zone trade (geographic foundation for the U1 auction economy). graphite is the 4th land resource (ADR-022);
 * `sticker` is never biome-generated (home-city self-produced).
 */
export function biomeAt(x: number, y: number, seed: number): ResourceType {
  const n = valueNoise(x, y, SLG_GEN.biomeFreq, seed ^ 0x0444);
  if (n < SLG_GEN.biomeInkMax) return 'ink';
  if (n < SLG_GEN.biomePaperMax) return 'paper';
  if (n < SLG_GEN.biomeGraphiteMax) return 'graphite';
  return 'metal';
}

// ── Terrain (ADR-034 §2.2/§2.3): ring boundary bands + river chords + birth-province branches ──────────
// All three are impassable ('obstacle') bands defined by distance-to-a-geometric-shape < width/2, with
// organic noise-driven wobble/width — replacing the old noise-threshold-zone model. Ring boundaries (the
// two province-ring radii) carry free-passage 'gate' arcs; branches carry none (siege-only, via city nodes in §City).
/** Terrain band thickness range in tiles (ADR-034 §2.2 DRAFT default: 5–11, independently randomized per band/point). */
export const TERRAIN_BAND_WIDTH_MIN = 5;
export const TERRAIN_BAND_WIDTH_MAX = 11;
/** Free-passage gate width range in tiles on the two main province rings (ADR-034 §2.4 DRAFT default: 3–8). */
export const RING_GATE_WIDTH_MIN = 3;
export const RING_GATE_WIDTH_MAX = 8;
/** Number of free-passage gates per main ring (DRAFT — doc pins the width range but not an exact count; several per ring per §2.4 "每处独立随机偏移"). */
export const RING_GATE_COUNT_PER_RING = 5;
/** Number of ink-river chords crossing the whole map (ADR-034 §2.2: "墨河两条"). */
export const RIVER_CHORD_COUNT = 2;
/** Free-passage gates per river chord (DRAFT: doc doesn't specify, but a fully impassable chord with zero crossings would be unplayable). */
export const RIVER_GATE_COUNT_PER_CHORD = 4;
/** Number of branches separating the 6 birth provinces from each other (ADR-034 §2.3: one per outer-sector boundary). */
export const BRANCH_COUNT = 6;

/** Distance in tiles from the map center to the square map boundary along the given angle. */
function _edgeDistanceAtAngle(angle: number, cx: number, cy: number): number {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const tx = Math.abs(cosA) > 1e-9 ? cx / Math.abs(cosA) : Infinity;
  const ty = Math.abs(sinA) > 1e-9 ? cy / Math.abs(sinA) : Infinity;
  return Math.min(tx, ty);
}

/**
 * Ring-boundary terrain (ADR-034 §2.1/§2.2 main ridge/river ring): the boundary circle at `ringRatio` (of the
 * map half-diagonal) is a continuous impassable band, angle-wobbled and variable-width, broken by several
 * free-passage gate arcs. Returns null off the band, 'gate' inside a gate arc, 'obstacle' otherwise.
 */
function _ringTerrainAt(x: number, y: number, seed: number, ringRatio: number, salt: number): 'obstacle' | 'gate' | null {
  const angle = _angleOf(x, y);
  const rNorm = _normRadius(x, y);
  const wobble = (valueNoise(Math.cos(angle) * 40, Math.sin(angle) * 40, 1, seed ^ salt) - 0.5) * 0.02;
  const effRatio = ringRatio + wobble;
  const widthNoise = valueNoise(Math.cos(angle) * 60, Math.sin(angle) * 60, 1, seed ^ salt ^ 0x01);
  const widthTiles = TERRAIN_BAND_WIDTH_MIN + widthNoise * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN);
  const halfWidthRatio = (widthTiles / 2) / _MAP_HALF_DIAGONAL;
  if (Math.abs(rNorm - effRatio) > halfWidthRatio) return null;
  const r = effRatio * _MAP_HALF_DIAGONAL;
  for (let g = 0; g < RING_GATE_COUNT_PER_RING; g++) {
    const gateAngle = rand2(g, salt, seed ^ 0x02) * _TWO_PI;
    const gateWidthTiles = RING_GATE_WIDTH_MIN + rand2(g, salt + 1, seed ^ 0x03) * (RING_GATE_WIDTH_MAX - RING_GATE_WIDTH_MIN);
    const gateHalfAngle = (gateWidthTiles / 2) / Math.max(1, r);
    let da = Math.abs(angle - gateAngle);
    if (da > Math.PI) da = _TWO_PI - da;
    if (da <= gateHalfAngle) return 'gate';
  }
  return 'obstacle';
}

/**
 * River-chord terrain (ADR-034 §2.2 "墨河"): a near-straight line crossing the whole map through a
 * near-center offset point, wobbled along its length, with a few free-passage gates.
 */
function _riverChordAt(x: number, y: number, seed: number, chordIdx: number): 'obstacle' | 'gate' | null {
  const dirAngle = rand2(chordIdx, 0, seed ^ 0x0d01) * Math.PI;
  const offset = (rand2(chordIdx, 1, seed ^ 0x0d02) - 0.5) * _MAP_HALF_DIAGONAL * 0.3;
  const nx = Math.cos(dirAngle + Math.PI / 2);
  const ny = Math.sin(dirAngle + Math.PI / 2);
  const px = _MAP_CX + nx * offset;
  const py = _MAP_CY + ny * offset;
  const dirX = Math.cos(dirAngle);
  const dirY = Math.sin(dirAngle);
  const dx = x - px;
  const dy = y - py;
  const dist = Math.abs(dx * -dirY + dy * dirX); // perpendicular distance to the chord's centerline
  const t = dx * dirX + dy * dirY; // position along the chord (used to vary wobble/width/gates along its length)
  const meander = (valueNoise(t, chordIdx * 1000 + 500, 1 / 80, seed ^ 0x0d04) - 0.5) * 6;
  const widthNoise = valueNoise(t, chordIdx * 1000, 1 / 50, seed ^ 0x0d03);
  const widthTiles = TERRAIN_BAND_WIDTH_MIN + widthNoise * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN);
  if (Math.abs(dist - meander) > widthTiles / 2) return null;
  for (let g = 0; g < RIVER_GATE_COUNT_PER_CHORD; g++) {
    const gateT = (rand2(g, chordIdx, seed ^ 0x0d05) - 0.5) * _MAP_HALF_DIAGONAL * 2;
    const gateWidth = RING_GATE_WIDTH_MIN + rand2(g, chordIdx + 10, seed ^ 0x0d06) * (RING_GATE_WIDTH_MAX - RING_GATE_WIDTH_MIN);
    if (Math.abs(t - gateT) <= gateWidth / 2) return 'gate';
  }
  return 'obstacle';
}

/**
 * Branch terrain (ADR-034 §2.3 "支脉/支流"): 6 branches, one per outer-province 60° sector boundary, running
 * from the outer/resource ring boundary outward to the map's square edge — separating the 6 birth provinces
 * from each other. No free gates (only the siege gate-city nodes in `_worldCityNodes`, checked separately).
 */
function _isOnBranch(x: number, y: number, seed: number): boolean {
  const rNorm = _normRadius(x, y);
  if (rNorm <= PROVINCE_RESOURCE_OUTER_RADIUS_RATIO) return false;
  const angle = _angleOf(x, y);
  const rTiles = rNorm * _MAP_HALF_DIAGONAL;
  for (let k = 0; k < BRANCH_COUNT; k++) {
    const branchAngle = k * (_TWO_PI / BRANCH_COUNT);
    let da = Math.abs(angle - branchAngle);
    if (da > Math.PI) da = _TWO_PI - da;
    const distToLine = rTiles * Math.sin(da);
    const widthNoise = valueNoise(rTiles, k * 1000, 1 / 30, seed ^ 0x0e01 ^ k);
    const widthTiles = TERRAIN_BAND_WIDTH_MIN + widthNoise * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN);
    if (Math.abs(distToLine) <= widthTiles / 2) return true;
  }
  return false;
}

// ── Cities (ADR-034 §3): point-node siege targets, layered on top of the procedural terrain ──────────
// Province capitals (state capitals, §3 "州府") are handled via `provinceCapitalPositions`; this section
// covers the other two node kinds. Kept as plain ProceduralTile classifications (familyKeep/center) rather
// than a separate node schema — garrison/HP numbers for cities-as-distinct-entities are explicitly an open
// question in the design doc (§5), not yet pinned down, so this is the faithful MVP of the "structure is
// locked, numbers are DRAFT" part of ADR-034.
/** World-center city footprint side length (ADR-034 §3: "9×9 格"实体, same family as BASE_FOOTPRINT but larger — the core province's contested objective). */
export const WORLD_CENTER_FOOTPRINT = 9;
/** Per-outer-province graded city level tiers (ADR-034 §3: 2×3 + 2×4 + 2×5 + 1×6 + 1×7 + 1×8 = 9 cities/province, 54 total). */
const _OUTER_GRADED_CITY_TIERS: readonly number[] = [3, 3, 4, 4, 5, 5, 6, 7, 8];
/** Gate-city level (DRAFT — §3/§5 leaves city garrison/level numbers open; reuses the old max-level-minus-1 convention for siege points). */
export const GATE_CITY_LEVEL = Math.max(2, SLG_MAP_MAX_LEVEL - 1);
/** State-capital city level (DRAFT, same convention as GATE_CITY_LEVEL but max — a province's capital is its strongest city). */
export const PROVINCE_CAPITAL_LEVEL = SLG_MAP_MAX_LEVEL;

interface _CityNode { x: number; y: number; level: number; kind: 'garrison' | 'gateCity'; provinceIdx?: number; }

const _cityNodeCache = new Map<number, readonly _CityNode[]>();

/** Graded cities (54, §3) + gate cities (6–9, §2.3/§3) for a world, cached by seed. Excludes state capitals / world center (handled separately). */
function _worldCityNodes(mapW: number, mapH: number, seed: number): readonly _CityNode[] {
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

  // Gate cities on the 6 branches: longest 3 branches get 2 each, shortest 3 get 1 (ADR-034 §2.3).
  const branches = Array.from({ length: BRANCH_COUNT }, (_, k) => {
    const angle = k * (_TWO_PI / BRANCH_COUNT);
    const ringR = PROVINCE_RESOURCE_OUTER_RADIUS_RATIO * halfDiag;
    const edgeR = _edgeDistanceAtAngle(angle, cx, cy);
    return { k, angle, ringR, len: Math.max(0, edgeR - ringR) };
  });
  const longBranchIdx = new Set([...branches].sort((a, b) => b.len - a.len).slice(0, 3).map((b) => b.k));
  for (const b of branches) {
    const count = longBranchIdx.has(b.k) ? 2 : 1;
    for (let g = 0; g < count; g++) {
      const salt = seed ^ 0x0f10 ^ (b.k * 10 + g);
      const frac = 0.15 + rand2(b.k, g, salt) * 0.7; // not centered — random offset along the branch
      const r = b.ringR + frac * b.len;
      const x = Math.max(0, Math.min(mapW - 1, Math.round(cx + Math.cos(b.angle) * r)));
      const y = Math.max(0, Math.min(mapH - 1, Math.round(cy + Math.sin(b.angle) * r)));
      nodes.push({ x, y, level: GATE_CITY_LEVEL, kind: 'gateCity' });
    }
  }

  _cityNodeCache.set(seed, nodes);
  return nodes;
}

/** One siege-point node, for editor consumption (DESIGN.md §6.2 data form: point nodes, not tile coverage). */
export interface MapEditorCityNode {
  id: string;
  kind: 'capital' | 'gateCity' | 'worldCenter' | 'garrison';
  /** Owning province index (§2.1), present for `capital`/`garrison` (their province is fixed by generation); absent for `gateCity` (straddles two provinces) and `worldCenter` (belongs to the core province by definition). */
  provinceIdx?: number;
  x: number;
  y: number;
  level: number;
  /** Square footprint side length in tiles; 1 for all point nodes, `WORLD_CENTER_FOOTPRINT` for the world center. */
  footprint: number;
}

/**
 * All siege-point nodes for a world (ADR-034 §3), flattened for the map editor's city-drag tool (§6.1):
 * world center (1) + province capitals (9, excludes the core province — its "capital" *is* the world
 * center) + graded/gate cities from `_worldCityNodes`. Editor-only — `proceduralTile()` above computes
 * these positions independently (not from this list) for the runtime tile classification.
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
    nodes.push({ id: `capital-${provinceIdx}`, kind: 'capital', provinceIdx, x, y, level: PROVINCE_CAPITAL_LEVEL, footprint: 1 });
  });

  let garrisonIdx = 0;
  let gateIdx = 0;
  for (const node of _worldCityNodes(mapW, mapH, seed)) {
    if (node.kind === 'garrison') {
      nodes.push({ id: `garrison-${garrisonIdx++}`, kind: 'garrison', provinceIdx: node.provinceIdx, x: node.x, y: node.y, level: node.level, footprint: 1 });
    } else {
      nodes.push({ id: `gate-${gateIdx++}`, kind: 'gateCity', x: node.x, y: node.y, level: node.level, footprint: 1 });
    }
  }
  return nodes;
}

// ── Per-ring level distribution (ADR-034 §4) ────────────────────────────────
// Percent-by-level tables (must each sum to 100); a smooth noise value is mapped through the cumulative
// distribution so same-region levels stay spatially continuous rather than randomly scattered per tile.
const _LEVEL_DIST_OUTER: readonly number[] = [34, 26, 16, 10, 6, 4, 3, 1, 0, 0];
const _LEVEL_DIST_RESOURCE: readonly number[] = [14, 10, 7, 6, 16, 14, 12, 9, 7, 5];
const _LEVEL_DIST_CORE: readonly number[] = [3, 5, 6, 8, 8, 10, 12, 14, 16, 18];

function _levelDistFor(kind: NationKind): readonly number[] {
  if (kind === 'outer') return _LEVEL_DIST_OUTER;
  if (kind === 'resource') return _LEVEL_DIST_RESOURCE;
  return _LEVEL_DIST_CORE;
}

/** Maps a smooth noise value [0,1) to a tile level 1..SLG_MAP_MAX_LEVEL via the per-ring cumulative percent table (ADR-034 §4). */
function _levelFromRing(kind: NationKind, noise: number): number {
  const dist = _levelDistFor(kind);
  const target = Math.max(0, Math.min(99.999, noise * 100));
  let cum = 0;
  for (let lvl = 1; lvl <= dist.length; lvl++) {
    cum += dist[lvl - 1]!;
    if (target < cum) return lvl;
  }
  return dist.length;
}

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

  // Terrain: 2 main province rings, then river chords, then birth-province branches — first match wins.
  const ring1 = _ringTerrainAt(x, y, seed, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO, 0x0a01);
  if (ring1) return ring1 === 'gate' ? { type: 'gate', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) } : { type: 'obstacle', level: 1 };
  const ring0 = _ringTerrainAt(x, y, seed, PROVINCE_CORE_RADIUS_RATIO, 0x0a02);
  if (ring0) return ring0 === 'gate' ? { type: 'gate', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) } : { type: 'obstacle', level: 1 };
  for (let c = 0; c < RIVER_CHORD_COUNT; c++) {
    const river = _riverChordAt(x, y, seed, c);
    if (river) return river === 'gate' ? { type: 'gate', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) } : { type: 'obstacle', level: 1 };
  }
  if (_isOnBranch(x, y, seed)) return { type: 'obstacle', level: 1 }; // branches have no free gates — only the gate-city nodes checked above

  // Province + per-ring level distribution (ADR-034 §4).
  const provIdx = provinceIdxAt(x, y);
  const kind = NATION_KIND_BY_IDX[provIdx]!;
  const lvlNoise = valueNoise(x, y, SLG_GEN.levelFreq, seed ^ 0x0111);
  const level = _levelFromRing(kind, lvlNoise);

  // Stronghold / familyKeep spacing (unchanged mechanics), now measured from the tile's own province capital.
  const [capX, capY] = caps[provIdx]!;
  const distToCap = Math.sqrt((x - capX) ** 2 + (y - capY) ** 2) / _MAP_HALF_DIAGONAL;
  const strongholdRand = rand2(x, y, seed ^ 0x0555);
  if (strongholdRand > SLG_GEN.strongholdThreshold && distToCap > SLG_GEN.strongholdMinDistRatio) {
    return { type: 'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(x, y, seed) };
  }
  const keepNoise = valueNoise(x, y, SLG_GEN.keepFreq, seed ^ 0x0222);
  if (keepNoise > SLG_GEN.keepThreshold && distToCap > SLG_GEN.keepMinDistRatio) {
    return { type: 'familyKeep', level: Math.max(level, SLG_MAP_MAX_LEVEL - 1), resType: biomeAt(x, y, seed) };
  }

  // Resource tile vs neutral open land
  const occ = rand2(x, y, seed ^ 0x0333);
  if (occ < SLG_GEN.resourceDensity) {
    return { type: 'resource', level, resType: biomeAt(x, y, seed) };
  }
  return { type: 'neutral', level: Math.min(level, SLG_GEN.neutralLevelCap) };
}

// ── Map templates (§24, admin-side editor for Layer A / design-time terrain baseline) ──────────
// A template is a from-scratch procedural seed (server-generated via proceduralTile) that ops can then
// hand-tune tile-by-tile in the editor. It is NOT runtime state: `TileDoc` overlays (Layer B) still carry
// occupation/building/garrison; a world instance clones a template's tiles as its terrain baseline at
// world-open time (copy, not a live reference — later template edits never retroactively affect a running world).
/** One tile inside a map template — same shape as {@link ProceduralTile} plus its coordinate. */
export interface MapTemplateTile {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
}

/** Template metadata (no tile payload — used for the template-picker list in the editor). */
export interface MapTemplateSummary {
  templateId: string;
  width: number;
  height: number;
  /** Bumped on regeneration; lets multiple generations of the same templateId size be told apart if ever reused. */
  version: number;
  tileCount: number;
  /** Whether new worlds currently clone this template as their terrain baseline (§24 "创建新世界用"). At most one template is active at a time. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Diff-save payload cap (§24 "只上发本次改动的格子"): guards against an editor bug accidentally re-uploading a whole map. */
export const MAP_TEMPLATE_SAVE_MAX_TILES = 5000;
/** Viewport read cap (editor opens a bbox, not the whole 500×500 template at once). */
export const MAP_TEMPLATE_READ_MAX_TILES = 100_000;
