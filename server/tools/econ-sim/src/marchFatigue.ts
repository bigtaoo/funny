// ─────────────────────────────────────────────────────────────────────────────
// March-fatigue (行军疲劳, ADR-047) gradient sanity check — post ADR-049 (map 500×500 → 1500×1500, 2026-07-22).
//
// ADR-047 gives every march a flat MARCH_MORALE_MAX=100 fatigue budget, burned 1 point per tile moved,
// scaled linearly onto a combat-power multiplier in [MARCH_MORALE_COMBAT_FLOOR=0.7, 1.0] (moraleCombatMultiplier,
// shared/src/slg/march.ts). The "100 tiles to floor" number was picked against the OLD 500×500 map (half-diagonal
// ≈ 354 tiles), where 100 tiles was a meaningful fraction of the map's reach. ADR-049 tripled every linear
// dimension (half-diagonal now ≈ 1061 tiles) while leaving MARCH_MORALE_MAX untouched — this was never re-checked
// against real province geometry (SLG_DESIGN_LOG.md flags this design-doc-audit-2026-07 gap explicitly).
//
// This module answers: on the NEW map, does a march's fatigue penalty still form a genuine gradient (some
// marches taxed lightly, some taxed heavily, in proportion to how far they travel), or does the 100-tile
// budget exhaust so quickly relative to real intra-province distances that almost everything bottoms out
// at the 70% floor — collapsing "far expeditions are penalized more than near ones" into a near-binary
// "leave your own doorstep and eat the max penalty, regardless of how much farther you go" outcome.
//
// IMPORTANT correction (discovered while building this script, 2026-07-27): an inter-province march is NOT
// a single findMarchPath hop. ADR-034's ring/branch terrain (mapgen.ts _ringTerrainAt/_riverChordAt/
// _branchKindAt) walls off province boundaries with 'obstacle' bands that only open at sparse single-tile
// crossings (bridge/plankway) — and findMarchPath treats an UNOWNED crossing as impassable mid-route (only
// passable if occupied, or exempted as the final destination). So on a fresh world, marching from one
// province straight into another in one hop is categorically impossible by design — you must first march TO
// the crossing (capturing/occupying it), then march AGAIN from there onward. Since ADR-047 morale is bound
// to the MARCH INSTANCE and resets to full every departure, fatigue can never accumulate across an
// inter-province campaign's legs — it only ever applies within a single leg. That makes "neighbor-province"/
// "hegemony-rush" as literal one-shot distances meaningless; the real question is whether a single LEG (which,
// for intra-province movement, needs no crossing at all) can rack up enough tiles to matter. Hence the
// 'intra-province-far' category below: two points sampled far apart but within the SAME province — the
// longest realistic distance coverable in one uninterrupted leg.
//
// Method: real generator, real A* (findMarchPath, shared/src/slg/march.ts — same pathfinder worldsvc uses,
// obstacle density ~3% included), real province geometry (provinceCapitalPositions/provinceIdxAt,
// shared/src/slg/province.ts). No hand-assumed distances — every sample is an actual A*-solved path on the
// real map for a given world seed.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SLG_MAP_W,
  SLG_MAP_H,
  MARCH_MORALE_MAX,
  MARCH_MORALE_COMBAT_FLOOR,
  MARCH_MORALE_FLOOR_TILES,
  findMarchPath,
  moraleCombatMultiplier,
  provinceCapitalPositions,
  provinceIdxAt,
  NATION_KIND_BY_IDX,
  CENTER_CAPITAL_IDX,
  type NationKind,
} from '@nw/shared';

export const HALF_DIAGONAL = Math.sqrt((SLG_MAP_W / 2) ** 2 + (SLG_MAP_H / 2) ** 2);
/** Tile count at which a march has fully exhausted MARCH_MORALE_MAX and sits at the combat floor (ADR-052: ratio-derived, not the flat MARCH_MORALE_MAX). */
export const FLOOR_TILES = MARCH_MORALE_FLOOR_TILES;

export interface MarchSample {
  category: 'home' | 'intra-province-far' | 'random-pair';
  tiles: number; // path length - 1 (0 if unreachable — excluded upstream)
  morale: number; // 0..MARCH_MORALE_MAX
  moraleMult: number; // MARCH_MORALE_COMBAT_FLOOR..1.0
}

function pathTiles(world: string, fx: number, fy: number, tx: number, ty: number): number | null {
  const path = findMarchPath(world, SLG_MAP_W, SLG_MAP_H, fx, fy, tx, ty, new Set(), new Set());
  if (!path) return null;
  return Math.max(0, path.length - 1);
}

function toSample(category: MarchSample['category'], tiles: number): MarchSample {
  // marchMoraleFromPath(path) is pure arithmetic on path.length (ADR-052: MAX - tiles*(MAX/FLOOR_TILES));
  // compute directly from the tile count instead of constructing a throwaway PathCell[] just to satisfy its signature.
  const m = Math.max(0, MARCH_MORALE_MAX - tiles * (MARCH_MORALE_MAX / FLOOR_TILES));
  return { category, tiles, morale: m, moraleMult: moraleCombatMultiplier(m) };
}

/** Uniform random point inside [0,mapW) x [0,mapH), deterministic per (seed,salt,i). */
function rngPoint(seed: number, salt: number, i: number): [number, number] {
  // simple deterministic hash-based PRNG (no dependency on shared/noise internals) — good enough for sampling
  let s = (seed * 2654435761 + salt * 40503 + i * 2246822519) >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
  const x = Math.floor(next() * SLG_MAP_W);
  const y = Math.floor(next() * SLG_MAP_H);
  return [Math.max(0, Math.min(SLG_MAP_W - 1, x)), Math.max(0, Math.min(SLG_MAP_H - 1, y))];
}

const SECTOR_WIDTH = (2 * Math.PI) / 6;

/**
 * Samples march distances for one world seed across three scenario categories:
 * - home: short local march near the player's own province capital (radius up to 8% of the map half-diagonal
 *   — a defensive reinforcement or nearby land grab, the "close to home" case ADR-047 was clearly meant to leave unpenalized).
 * - intra-province-far: the longest realistic SINGLE-LEG march — two points far apart but inside the SAME
 *   outer province (no crossing needed, see module header for why inter-province distance isn't a valid
 *   single-leg quantity to sample at all post ADR-034's chokepoint terrain).
 * - random-pair: two uniform-random points anywhere on the map (baseline reference; most will be UNREACHABLE
 *   in one leg by design — reachability rate itself is reported as an informational side-finding, not treated
 *   as a fatigue-gradient data point).
 */
export interface WorldSampleResult {
  samples: MarchSample[];
  randomPairAttempted: number;
  randomPairReachable: number;
}

export function sampleWorld(seed: number, samplesPerCategory: number): WorldSampleResult {
  const world = `econsim-march-${seed}`;
  const capitals = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, seed);
  const out: MarchSample[] = [];
  let randomPairAttempted = 0;
  let randomPairReachable = 0;

  // home: near own capital (province i), short radius
  for (let i = 0; i < 6; i++) { // 6 outer provinces = where new players actually start (birth provinces)
    const [cx, cy] = capitals[i]!;
    for (let k = 0; k < samplesPerCategory; k++) {
      const [rx, ry] = rngPoint(seed, i * 1000 + 1, k);
      // clamp the random point into a short radius around the capital instead of using it raw
      const angle = Math.atan2(ry - cy, rx - cx);
      const r = ((k + 1) / samplesPerCategory) * 0.08 * HALF_DIAGONAL; // up to 8% of half-diagonal
      const tx = Math.max(0, Math.min(SLG_MAP_W - 1, Math.round(cx + Math.cos(angle) * r)));
      const ty = Math.max(0, Math.min(SLG_MAP_H - 1, Math.round(cy + Math.sin(angle) * r)));
      const tiles = pathTiles(world, cx, cy, tx, ty);
      if (tiles !== null) out.push(toSample('home', tiles));
    }
  }

  // intra-province-far: two points at a shared moderate radius (clear of both the core/resource ring bands
  // and the sector-boundary branch bands) but spread across most of the sector's angular width — the
  // longest chord obtainable without leaving the province (and therefore without needing a crossing).
  const cx0 = SLG_MAP_W / 2, cy0 = SLG_MAP_H / 2;
  for (let i = 0; i < 6; i++) {
    const sectorStart = i * SECTOR_WIDTH;
    for (let k = 0; k < samplesPerCategory; k++) {
      const spread = 0.35 + (0.6 * k) / Math.max(1, samplesPerCategory - 1); // widens toward 0.95 of the sector
      const r = 0.65 * HALF_DIAGONAL; // mid-band of the outer ring (clear of both boundary bands)
      const aX = Math.round(cx0 + r * Math.cos(sectorStart + SECTOR_WIDTH * (0.5 - spread / 2)));
      const aY = Math.round(cy0 + r * Math.sin(sectorStart + SECTOR_WIDTH * (0.5 - spread / 2)));
      const bX = Math.round(cx0 + r * Math.cos(sectorStart + SECTOR_WIDTH * (0.5 + spread / 2)));
      const bY = Math.round(cy0 + r * Math.sin(sectorStart + SECTOR_WIDTH * (0.5 + spread / 2)));
      if (provinceIdxAt(aX, aY) !== i || provinceIdxAt(bX, bY) !== i) continue; // skip if geometry drifted out of sector
      const tiles = pathTiles(world, aX, aY, bX, bY);
      if (tiles !== null) out.push(toSample('intra-province-far', tiles));
    }
  }

  // random-pair: uniform anywhere, baseline reference (mostly unreachable in one leg by design — see header)
  for (let k = 0; k < samplesPerCategory; k++) {
    const [fx, fy] = rngPoint(seed, 9001, k * 2);
    const [tx, ty] = rngPoint(seed, 9002, k * 2 + 1);
    randomPairAttempted++;
    const tiles = pathTiles(world, fx, fy, tx, ty);
    if (tiles !== null) { randomPairReachable++; out.push(toSample('random-pair', tiles)); }
  }

  return { samples: out, randomPairAttempted, randomPairReachable };
}

void CENTER_CAPITAL_IDX; // no longer sampled directly (see module header: inter-province distance is multi-leg, not a single quantity)

export function summarize(samples: MarchSample[]) {
  const byCat = new Map<MarchSample['category'], MarchSample[]>();
  for (const s of samples) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category)!.push(s);
  }
  const rows: { category: string; n: number; medianTiles: number; medianMult: number; pctAtFloor: number }[] = [];
  for (const [cat, arr] of byCat) {
    const tiles = arr.map((s) => s.tiles).sort((a, b) => a - b);
    const mults = arr.map((s) => s.moraleMult).sort((a, b) => a - b);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
    const atFloor = arr.filter((s) => s.tiles >= FLOOR_TILES).length;
    rows.push({
      category: cat,
      n: arr.length,
      medianTiles: median(tiles),
      medianMult: median(mults),
      pctAtFloor: atFloor / arr.length,
    });
  }
  return rows;
}

export { MARCH_MORALE_MAX, MARCH_MORALE_COMBAT_FLOOR };
export type { NationKind };
void NATION_KIND_BY_IDX; // (kept for potential future ring-kind breakdown; not used in the current pass)
