// SLG territory yield (S8-1, §14.3) + march duration + A* march pathfinding (S8-6.6, §4).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

import {
  MARCH_SPEED_SEC_PER_TILE,
  MARCH_MORALE_MAX,
  MARCH_MORALE_COMBAT_FLOOR,
  MARCH_MORALE_FLOOR_RADIUS_RATIO,
  RESOURCE_YIELD_BASE,
  type ResourceType,
  type TileType,
} from './core';
import { proceduralTile } from './mapgen';
import { _MAP_HALF_DIAGONAL } from './province';
import { TERRAIN_OBSTACLE, TERRAIN_CROSSING, type MapTerrainIndex } from './mapTerrainIndex';

/**
 * Per-tile hourly yield (added to `playerWorld.yieldRate` after claiming). Pure function.
 * - `base` (home city): provides a starting ink trickle (`RESOURCE_YIELD_BASE`), ensuring new players always have yield to settle.
 * - Tiles with a `resType` (resource / familyKeep / territory after claiming): yield the corresponding resource at `RESOURCE_YIELD_BASE × level`.
 * - All others (neutral/territory without resType): no yield.
 */
export function tileYield(
  type: TileType,
  level: number,
  resType?: ResourceType,
): Partial<Record<ResourceType, number>> {
  if (type === 'base') return { ink: RESOURCE_YIELD_BASE };
  if (resType) return { [resType]: RESOURCE_YIELD_BASE * Math.max(1, level) };
  return {};
}

// ── March (S8-2, §14.4/§4) ────────────────────────────────
/**
 * March duration (seconds): Euclidean distance (ceiling) × MARCH_SPEED_SEC_PER_TILE; minimum 1 tile.
 * Pure function, computable on either end (client estimates ETA / server authoritatively sets arriveAt). Same-tile (distance 0) costs 1 tile.
 */
export function marchDurationSec(fx: number, fy: number, tx: number, ty: number): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const tiles = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  return tiles * MARCH_SPEED_SEC_PER_TILE;
}

// ── A* march pathfinding (S8-6.6, §4 "march pathfinding") ──────────────────────────
// 4-directional A* (up/down/left/right, no diagonals), Manhattan distance heuristic.
// Obstacle tiles are impassable; unoccupied crossings (bridge/plankway) are treated as obstacles
// ("unoccupied = obstacle"); occupied crossings are passable only by the occupying faction / allies
// (passableGateKeys is pre-fetched from the DB by the caller).

/** March path node. */
export interface PathCell {
  x: number;
  y: number;
}

/**
 * Node-expansion ceiling for one A* run. Reached only when the destination is genuinely unreachable within
 * the searched region; the search then reports "no path". Kept at the historical value so which marches are
 * refused does not change — worldsvc's speed fix is the terrain index (an O(1) unreachability proof, see
 * mapTerrainIndex.ts) plus running the search off the event loop, NOT a smaller budget.
 */
export const DEFAULT_PATH_MAX_NODES = 500_000;

export interface FindMarchPathOptions {
  /**
   * Precomputed terrain classification for this world (see mapTerrainIndex.ts). Supplying it replaces the
   * per-neighbour `proceduralTile()` call — measured at ~1.14us each, and A* makes up to four per expanded
   * cell — with a typed-array read. Omit it and the search behaves exactly as before, just slower; the two
   * paths are pinned to agree by test, since the index is built from the same `proceduralTile`.
   */
  index?: MapTerrainIndex;
  /** Override {@link DEFAULT_PATH_MAX_NODES} (tests use a small budget to exercise the cap cheaply). */
  maxNodes?: number;
}

/**
 * A* pathfinding from (fx,fy) to (tx,ty).
 * - Returns the full path (including start and end); returns a single node [{fx,fy}] for same-tile.
 * - Returns null if the destination is unreachable (obstacle / no path / out of bounds).
 * - passableGateKeys: set of crossing (bridge/plankway) tile keys that can be traversed (format "x:y"); the destination crossing itself is always reachable regardless of passage rights.
 * - blockedBaseKeys (ADR-025): set of enemy/other main-base tile keys ("x:y") that block pathing —
 *   a player's 3×3 capital is a solid building others must route around ("path-blocking"). The caller excludes
 *   the marcher's own base tiles from this set (owners march in/out freely). The destination itself is
 *   always allowed (isDest), so sieging an enemy base tile stays reachable.
 * - maxNodes safety cap (prevents worst-case on very large maps); see {@link FindMarchPathOptions}.
 */
export function findMarchPath(
  world: string,
  mapW: number,
  mapH: number,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  passableGateKeys: ReadonlySet<string>,
  blockedBaseKeys: ReadonlySet<string> = new Set(),
  opts: FindMarchPathOptions = {},
): PathCell[] | null {
  const { index, maxNodes = DEFAULT_PATH_MAX_NODES } = opts;
  if (fx === tx && fy === ty) return [{ x: fx, y: fy }];
  if (!_slgInBounds(fx, fy, mapW, mapH) || !_slgInBounds(tx, ty, mapW, mapH)) return null;

  // Terrain classification, from the precomputed index when the caller supplied one and from
  // `proceduralTile` otherwise. Both answer the same question — "obstacle, crossing, or open ground" —
  // and the index is generated by calling `proceduralTile` over the whole map, so they cannot disagree.
  const classify = index
    ? (x: number, y: number): number => index.terrain[y * mapW + x]!
    : (x: number, y: number): number => {
      const t = proceduralTile(world, x, y).type;
      return t === 'obstacle' ? TERRAIN_OBSTACLE : t === 'bridge' || t === 'plankway' ? TERRAIN_CROSSING : 0;
    };

  const walkable = (x: number, y: number, isDest: boolean): boolean => {
    if (!_slgInBounds(x, y, mapW, mapH)) return false;
    // Enemy main-base footprint blocks pathing (ADR-025); the destination is exempt so an
    // attacker can still march onto an enemy base tile to besiege it.
    if (!isDest && blockedBaseKeys.has(`${x}:${y}`)) return false;
    const cls = classify(x, y);
    if (cls === TERRAIN_OBSTACLE) return false; // obstacles always block, including the destination tile
    // Crossings (bridge/plankway): passable only if the destination (so you can march on to besiege it)
    // or occupied by the marcher's faction/allies; an unoccupied crossing blocks like an obstacle.
    if (cls === TERRAIN_CROSSING) return isDest || passableGateKeys.has(`${x}:${y}`);
    return true;
  };

  if (!walkable(tx, ty, true)) return null; // destination tile is an obstacle

  // g: shortest step count from start to this node; par: parent node flat index (for path reconstruction)
  const g = new Map<number, number>();
  const par = new Map<number, number>();
  // Open set: binary min-heap over (f, flatIdx), held as two parallel growable arrays rather than an
  // array of [f, idx] tuples. A long march expands hundreds of thousands of nodes, and the tuple form
  // allocated one two-element array per push — pure garbage, and the single largest remaining cost in the
  // search once the terrain index removed the per-neighbour `proceduralTile` call.
  const heap = new MinHeap();

  // Tie-breaking (ADR-049 fix, 2026-07-27): with 4-directional movement, a plain Manhattan heuristic is
  // exact whenever the path is unobstructed, so EVERY monotone lattice path from start to destination ties
  // on f = g + h. Without a tie-break, a min-heap A* can end up expanding close to the full dx×dy bounding
  // rectangle before happening to pop the destination — harmless on the old 500×500 map (max diagonal
  // ~350×350 ≈ 122,500 cells, well under the node cap), but on the 1500×1500 map (ADR-049) a routine diagonal
  // march (e.g. dx=dy=600 ≈ 360,000-cell box) blows past the node cap and findMarchPath incorrectly returns
  // null (PATH_BLOCKED) even though a path obviously exists — confirmed empirically (design-doc-audit-2026-07
  // econ-sim march-fatigue pass). Nudging h toward the straight line between (fx,fy) and (tx,ty) via a tiny
  // cross-track bias breaks ties deterministically and cuts exploration back to ~O(distance); TIE_EPS is
  // small enough that it can never make A* prefer a longer path over a shorter one (max possible cross-track
  // value is bounded by mapW×mapH, so TIE_EPS × that product stays well under 1 full step of g-cost).
  const TIE_EPS = 1 / (2 * mapW * mapH + 1);
  const h = (x: number, y: number) => {
    const base = Math.abs(x - tx) + Math.abs(y - ty);
    const cross = Math.abs((x - fx) * (ty - fy) - (tx - fx) * (y - fy));
    return base + cross * TIE_EPS;
  };
  const si = fy * mapW + fx;
  g.set(si, 0);
  heap.push(h(fx, fy), si);

  const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const closed = new Set<number>();
  let explored = 0;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);

    const cx = cur % mapW;
    const cy = (cur / mapW) | 0;
    if (cx === tx && cy === ty) return _slgReconstructPath(par, mapW, si, cur);
    if (++explored > maxNodes) break;

    const cg = g.get(cur)!;
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      const isDest = nx === tx && ny === ty;
      if (!walkable(nx, ny, isDest)) continue;
      const ni = ny * mapW + nx;
      const ng = cg + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        par.set(ni, cur);
        heap.push(ng + h(nx, ny), ni);
      }
    }
  }
  return null;
}

/**
 * March path → duration (seconds): (path.length-1) steps × MARCH_SPEED_SEC_PER_TILE × `speedMult`.
 *
 * `speedMult` is ADR-074 §8.3's world-center discount (0.9). It multiplies TIME, not speed, so a value
 * below 1 makes the march faster — named for the shape it has on the wire (`MarchDoc.speedMult`), where it
 * is a multiplier applied to a duration. Absent/1 = the plain rate, which is what every march was before
 * P3 and what every march still is unless its owner's sect holds the world center.
 */
export function marchDurationFromPath(path: PathCell[], speedMult = 1): number {
  return Math.max(0, path.length - 1) * MARCH_SPEED_SEC_PER_TILE * speedMult;
}

/**
 * ADR-051 (P1): wall-clock time (ms) at which a stepping march reaches `path[stepIndex]`, given its `departAt`.
 * Per-tile time is uniform (MARCH_SPEED_SEC_PER_TILE), so cell i is reached at departAt + i·speed·1000. Note
 * path[0] is reached at departAt and path[last] at departAt + (len-1)·speed·1000 == arriveAt
 * (consistent with marchDurationFromPath). Pure; used by both dispatch and the scheduler's step scan.
 *
 * ⚠️ `speedMult` MUST be the same value `marchDurationFromPath` was given for this march — which is why it
 * is persisted on the document rather than re-derived. Discounting `arriveAt` alone would leave the step
 * cursor running at the undiscounted cadence, so the march would "arrive" while the scan still had cells to
 * walk: encounters on the tail of the path would fire after settlement, or not at all.
 */
export function marchStepArriveAt(departAt: number, stepIndex: number, speedMult = 1): number {
  return departAt + Math.max(0, stepIndex) * MARCH_SPEED_SEC_PER_TILE * speedMult * 1000;
}

/**
 * Tiles a march can cover before morale bottoms out, at the CURRENT map size (ADR-053). A ratio of the map's
 * half-diagonal rather than a flat constant — see MARCH_MORALE_FLOOR_RADIUS_RATIO for why (auto-rescales with
 * SLG_MAP_W/H instead of silently going stale, as the flat MARCH_MORALE_MAX=100 tiles did across ADR-049).
 */
export const MARCH_MORALE_FLOOR_TILES = MARCH_MORALE_FLOOR_RADIUS_RATIO * _MAP_HALF_DIAGONAL;

/**
 * Remaining morale (out of MARCH_MORALE_MAX) for a march given its full path: cost per tile is
 * MARCH_MORALE_MAX / MARCH_MORALE_FLOOR_TILES (path includes the start cell, so tiles moved = path.length - 1),
 * floored at 0. Bound to the march instance — every departure starts fresh at MARCH_MORALE_MAX regardless of
 * the team's history.
 */
export function marchMoraleFromPath(path: PathCell[]): number {
  const tiles = Math.max(0, path.length - 1);
  return Math.max(0, MARCH_MORALE_MAX - tiles * (MARCH_MORALE_MAX / MARCH_MORALE_FLOOR_TILES));
}

/**
 * Combat-power multiplier from remaining morale: linear from MARCH_MORALE_COMBAT_FLOOR (morale=0) up to 1.0
 * (morale=MARCH_MORALE_MAX). Models a long-distance march arriving fatigued — attacking far-away targets is
 * inherently weaker than attacking nearby ones.
 */
export function moraleCombatMultiplier(morale: number): number {
  const clamped = Math.max(0, Math.min(MARCH_MORALE_MAX, morale));
  return MARCH_MORALE_COMBAT_FLOOR + (1 - MARCH_MORALE_COMBAT_FLOOR) * (clamped / MARCH_MORALE_MAX);
}

function _slgInBounds(x: number, y: number, mapW: number, mapH: number): boolean {
  return x >= 0 && y >= 0 && x < mapW && y < mapH;
}

function _slgReconstructPath(par: Map<number, number>, mapW: number, start: number, end: number): PathCell[] {
  const path: PathCell[] = [];
  let cur = end;
  while (cur !== start) {
    path.push({ x: cur % mapW, y: (cur / mapW) | 0 });
    cur = par.get(cur)!;
  }
  path.push({ x: start % mapW, y: (start / mapW) | 0 });
  return path.reverse();
}

/**
 * Binary min-heap of (priority, value) pairs kept in two parallel typed arrays, grown by doubling.
 * Allocation-free per operation, which is the whole point — see the call site in findMarchPath.
 * Private to this module: `pop()` returns only the value and is valid only while `size > 0`.
 */
class MinHeap {
  private f = new Float64Array(1024);
  private v = new Int32Array(1024);
  size = 0;

  push(priority: number, value: number): void {
    if (this.size === this.f.length) this.grow();
    const { f, v } = this;
    let i = this.size++;
    f[i] = priority;
    v[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[p]! <= f[i]!) break;
      const tf = f[p]!; const tv = v[p]!;
      f[p] = f[i]!; v[p] = v[i]!;
      f[i] = tf; v[i] = tv;
      i = p;
    }
  }

  pop(): number {
    const { f, v } = this;
    const top = v[0]!;
    const n = --this.size;
    f[0] = f[n]!;
    v[0] = v[n]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && f[l]! < f[m]!) m = l;
      if (r < n && f[r]! < f[m]!) m = r;
      if (m === i) break;
      const tf = f[i]!; const tv = v[i]!;
      f[i] = f[m]!; v[i] = v[m]!;
      f[m] = tf; v[m] = tv;
      i = m;
    }
    return top;
  }

  private grow(): void {
    const f = new Float64Array(this.f.length * 2);
    const v = new Int32Array(this.v.length * 2);
    f.set(this.f);
    v.set(this.v);
    this.f = f;
    this.v = v;
  }
}
