// SLG nation / province system (S8-6.5, §2.4; angle-sector ring layout ADR-034, 2026-07-05).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

import { SLG_MAP_H, SLG_MAP_W } from './core';
import { rand2 } from './noise';

/** Number of nations (6 outer + 3 resource + 1 core = 10 provinces, each with one representative capital). */
export const NATION_COUNT = 10;
/** Nation bonus: resource production bonus within the player's own province (fraction, 0.10 = +10%, §16.5 A7 decision). */
export const NATION_BONUS_PRODUCTION = 0.10;
/** Nation bonus: defense combat bonus within the player's own province (fraction, 0.15 = +15%, §16.5 A7 decision). */
export const NATION_BONUS_DEFENSE = 0.15;
/**
 * Nation/province kind by capitalIdx (ADR-034, 2026-07-05): angle-sector ring layout, replacing the ADR-032/033
 * Voronoi-from-10-fixed-capitals arrangement. 6 "birth" provinces each occupy a 60° angle sector on the outer
 * ring; 3 "resource" provinces each occupy a 120° angle sector on a middle ring (angle-aligned so resource
 * province i covers birth provinces 2i/2i+1); 1 "core" province is the center circle (still capitalIdx 9 /
 * CENTER_CAPITAL_IDX — world-center city, the season's hegemony objective).
 */
export type NationKind = 'outer' | 'resource' | 'core';
export const NATION_KIND_BY_IDX: readonly NationKind[] = [
  'outer', 'outer', 'outer', 'outer', 'outer', 'outer', // 0-5: 6 birth provinces, 60° sectors
  'resource', 'resource', 'resource',                   // 6-8: 3 resource provinces, 120° sectors
  'core',                                                // 9: center circle (world-center city)
];

/** Central plains capital (capitalIdx 9, §2.4) occupation bonus: reward materials for the tier are multiplied by CENTER_CAPITAL_MULT. */
export const CENTER_CAPITAL_IDX = 9;
export const CENTER_CAPITAL_MULT = 2;

export const _TWO_PI = Math.PI * 2;
export const _MAP_CX = SLG_MAP_W / 2;
export const _MAP_CY = SLG_MAP_H / 2;
export const _MAP_HALF_DIAGONAL = Math.sqrt(_MAP_CX ** 2 + _MAP_CY ** 2);

/** Core province radius (ADR-034 §2.1 DRAFT default), as a fraction of the map's half-diagonal. */
export const PROVINCE_CORE_RADIUS_RATIO = 0.11;
/** Resource-ring outer boundary radius (ADR-034 §2.1 DRAFT default), as a fraction of the map's half-diagonal; beyond this is the outer/birth ring. */
export const PROVINCE_RESOURCE_OUTER_RADIUS_RATIO = 0.39;

/** Angle (radians, [0, 2π)) of (x,y) around the map's geometric center; 0 = due east, increasing clockwise in screen coordinates. */
export function _angleOf(x: number, y: number): number {
  let a = Math.atan2(y - _MAP_CY, x - _MAP_CX);
  if (a < 0) a += _TWO_PI;
  return a;
}
/** Distance of (x,y) from the map's geometric center, normalized by the map's half-diagonal (0 = center, ~1 = corner). */
export function _normRadius(x: number, y: number): number {
  return Math.sqrt((x - _MAP_CX) ** 2 + (y - _MAP_CY) ** 2) / _MAP_HALF_DIAGONAL;
}

/**
 * Province membership by angle sector + radius ring (ADR-034 §2.1) — replaces the old Voronoi `nearestCapitalIdx`.
 * Pure geometry, no capital lookup needed: core circle → 9; resource ring (120° sectors, angle-aligned so sector i
 * covers outer sectors 2i/2i+1) → 6+i; outer ring (60° sectors) → i.
 */
export function provinceIdxAt(x: number, y: number): number {
  const rNorm = _normRadius(x, y);
  if (rNorm <= PROVINCE_CORE_RADIUS_RATIO) return CENTER_CAPITAL_IDX;
  const angle = _angleOf(x, y);
  if (rNorm <= PROVINCE_RESOURCE_OUTER_RADIUS_RATIO) {
    return 6 + (Math.floor(angle / (_TWO_PI / 3)) % 3);
  }
  return Math.floor(angle / (_TWO_PI / 6)) % 6;
}

const _provinceCapitalCache = new Map<number, readonly [number, number][]>();

/**
 * Deterministic capital (state-capital city) position per province, keyed by worldId seed (ADR-034 §3: state
 * capitals sit at their sector's center angle ± jitter, at a random radius within their own ring band; the core
 * province's "capital" is the exact map center — the world-center city). Replaces the old fixed CAPITAL_FRACTIONS
 * table: positions are no longer universal constants because they now depend on the world's seed, not just map size.
 */
export function provinceCapitalPositions(mapW: number, mapH: number, seed: number): readonly [number, number][] {
  const cacheKey = (seed >>> 0) ^ Math.imul(mapW, 0x1000003) ^ Math.imul(mapH, 0x100013);
  const cached = _provinceCapitalCache.get(cacheKey);
  if (cached) return cached;
  const cx = mapW / 2;
  const cy = mapH / 2;
  const halfDiag = Math.sqrt(cx ** 2 + cy ** 2);
  const out: [number, number][] = [];
  for (let i = 0; i < NATION_COUNT; i++) {
    if (i === CENTER_CAPITAL_IDX) {
      out.push([Math.floor(cx), Math.floor(cy)]);
      continue;
    }
    const isOuter = NATION_KIND_BY_IDX[i] === 'outer';
    const sectorCount = isOuter ? 6 : 3;
    const sectorIdx = isOuter ? i : i - 6;
    const sectorWidth = _TWO_PI / sectorCount;
    const jitter = (rand2(i, 0, seed ^ 0x0c11) - 0.5) * sectorWidth * 0.6; // stays inside own sector, margin from its boundary
    const angle = sectorIdx * sectorWidth + sectorWidth / 2 + jitter;
    const rMin = isOuter ? PROVINCE_RESOURCE_OUTER_RADIUS_RATIO + 0.04 : PROVINCE_CORE_RADIUS_RATIO + 0.03;
    const rMax = isOuter ? 0.94 : PROVINCE_RESOURCE_OUTER_RADIUS_RATIO - 0.03;
    const rNorm = rMin + rand2(i, 1, seed ^ 0x0c22) * Math.max(0.01, rMax - rMin);
    const r = rNorm * halfDiag;
    const x = Math.round(cx + Math.cos(angle) * r);
    const y = Math.round(cy + Math.sin(angle) * r);
    out.push([Math.max(0, Math.min(mapW - 1, x)), Math.max(0, Math.min(mapH - 1, y))]);
  }
  _provinceCapitalCache.set(cacheKey, out);
  return out;
}

/** Returns the capital index if (x,y) is a capital location, or -1 if it is not a capital. */
export function capitalIdxAt(
  x: number,
  y: number,
  capitals: readonly [number, number][],
): number {
  for (let i = 0; i < capitals.length; i++) {
    const [cx, cy] = capitals[i]!;
    if (cx === x && cy === y) return i;
  }
  return -1;
}
