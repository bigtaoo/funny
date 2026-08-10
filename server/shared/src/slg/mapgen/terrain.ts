// Split from mapgen.ts (2026-08-10, independent function module range 6, part 3/7).
// Terrain (ADR-034 §2.2/§2.3): ring boundary bands + river chords + birth-province branches.
// All three are impassable ('obstacle') mountain/river bands defined by distance-to-a-geometric-shape < width/2,
// with organic noise-driven wobble/width. Passage across a band is ONLY via a capturable crossing building
// (bridge over a river / plankway over a mountain — gate→bridge/plankway migration): each band gets a minimal
// auto-crossing fallback (1 per band, 1 tile wide, siege-to-pass) so a template-less world stays connected;
// designers add/adjust further crossings by hand in the map editor.
import { SLG_MAP_MAX_LEVEL, type ObstacleKind } from '../core';
import { valueNoise, rand2 } from '../noise';
import { _angleOf, _MAP_CX, _MAP_CY, _MAP_HALF_DIAGONAL, _normRadius, _TWO_PI, PROVINCE_RESOURCE_OUTER_RADIUS_RATIO } from '../province';
import type { ProceduralTile } from './types';

/** Terrain band thickness range in tiles (ADR-034 §2.2 DRAFT default: 5–11, independently randomized per band/point). */
export const TERRAIN_BAND_WIDTH_MIN = 5;
export const TERRAIN_BAND_WIDTH_MAX = 11;
/** Auto-crossing width in tiles (1 = a single-tile-wide passage the marcher cannot route around; the crossing spans the band's full radial thickness at its angle). */
export const CROSSING_WIDTH_TILES = 1;
/** Auto-crossing count per main province ring (minimal connectivity fallback; designers add more in the editor). */
export const RING_CROSSING_COUNT_PER_RING = 1;
/** Number of ink-river chords crossing the whole map (ADR-034 §2.2: "two ink rivers"). */
export const RIVER_CHORD_COUNT = 2;
/** Auto-crossing count per river chord (minimal connectivity fallback). */
export const RIVER_CROSSING_COUNT_PER_CHORD = 1;
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
 * map half-diagonal) is a continuous impassable band, angle-wobbled and variable-width, broken by a minimal
 * set of 1-tile-wide crossings. Returns null off the band, 'crossing' inside a crossing (→ plankway/bridge
 * building), 'obstacle' otherwise. A crossing arc spans the band's full radial thickness at its angle, so a
 * single-tile-wide crossing genuinely bridges the whole band.
 */
export function _ringTerrainAt(x: number, y: number, seed: number, ringRatio: number, salt: number): 'obstacle' | 'crossing' | null {
  const angle = _angleOf(x, y);
  const rNorm = _normRadius(x, y);
  const wobble = (valueNoise(Math.cos(angle) * 40, Math.sin(angle) * 40, 1, seed ^ salt) - 0.5) * 0.02;
  const effRatio = ringRatio + wobble;
  const widthNoise = valueNoise(Math.cos(angle) * 60, Math.sin(angle) * 60, 1, seed ^ salt ^ 0x01);
  const widthTiles = TERRAIN_BAND_WIDTH_MIN + widthNoise * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN);
  const halfWidthRatio = (widthTiles / 2) / _MAP_HALF_DIAGONAL;
  if (Math.abs(rNorm - effRatio) > halfWidthRatio) return null;
  const r = effRatio * _MAP_HALF_DIAGONAL;
  for (let c = 0; c < RING_CROSSING_COUNT_PER_RING; c++) {
    const crossingAngle = rand2(c, salt, seed ^ 0x02) * _TWO_PI;
    const crossingHalfAngle = (CROSSING_WIDTH_TILES / 2) / Math.max(1, r);
    let da = Math.abs(angle - crossingAngle);
    if (da > Math.PI) da = _TWO_PI - da;
    if (da <= crossingHalfAngle) return 'crossing';
  }
  return 'obstacle';
}

/**
 * River-chord terrain (ADR-034 §2.2 "ink river"): a near-straight line crossing the whole map through a
 * near-center offset point, wobbled along its length, broken by a minimal set of 1-tile-wide crossings.
 */
export function _riverChordAt(x: number, y: number, seed: number, chordIdx: number): 'obstacle' | 'crossing' | null {
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
  for (let c = 0; c < RIVER_CROSSING_COUNT_PER_CHORD; c++) {
    const crossingT = (rand2(c, chordIdx, seed ^ 0x0d05) - 0.5) * _MAP_HALF_DIAGONAL * 2;
    if (Math.abs(t - crossingT) <= CROSSING_WIDTH_TILES / 2) return 'crossing';
  }
  return 'obstacle';
}

/**
 * Branch terrain (ADR-034 §2.3 "spur / branch"): 6 branches, one per outer-province 60° sector boundary, running
 * from the outer/resource ring boundary outward to the map's square edge — separating the 6 birth provinces
 * from each other. Each branch carries a single 1-tile-wide auto-crossing (`crossing:true`) at its radial
 * midpoint so adjacent provinces stay connected without a template; the rest of the branch is impassable
 * `obstacle` of the branch's kind. `kind` picks the crossing building: mountain→plankway, river→bridge.
 */
export function _branchKindAt(x: number, y: number, seed: number): { kind: ObstacleKind; crossing: boolean } | null {
  const rNorm = _normRadius(x, y);
  if (rNorm <= PROVINCE_RESOURCE_OUTER_RADIUS_RATIO) return null;
  const angle = _angleOf(x, y);
  const rTiles = rNorm * _MAP_HALF_DIAGONAL;
  for (let k = 0; k < BRANCH_COUNT; k++) {
    const branchAngle = k * (_TWO_PI / BRANCH_COUNT);
    let da = Math.abs(angle - branchAngle);
    if (da > Math.PI) da = _TWO_PI - da;
    const distToLine = rTiles * Math.sin(da);
    const widthNoise = valueNoise(rTiles, k * 1000, 1 / 30, seed ^ 0x0e01 ^ k);
    const widthTiles = TERRAIN_BAND_WIDTH_MIN + widthNoise * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN);
    // §2.3: the 6 branches alternate mountain-spur / river-tributary by parity of the branch index.
    if (Math.abs(distToLine) <= widthTiles / 2) {
      const kind: ObstacleKind = k % 2 === 0 ? 'mountain' : 'river';
      // Single crossing at the branch's radial midpoint (between the resource-ring boundary and the map edge).
      const ringR = PROVINCE_RESOURCE_OUTER_RADIUS_RATIO * _MAP_HALF_DIAGONAL;
      const edgeR = _edgeDistanceAtAngle(branchAngle, _MAP_CX, _MAP_CY);
      const midR = (ringR + edgeR) / 2;
      return { kind, crossing: Math.abs(rTiles - midR) <= CROSSING_WIDTH_TILES / 2 };
    }
  }
  return null;
}

/** Crossing-building tile type for the given obstacle kind: river→bridge, mountain→plankway. */
export function _crossingTile(kind: ObstacleKind): ProceduralTile {
  return { type: kind === 'river' ? 'bridge' : 'plankway', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) };
}
