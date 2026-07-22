// SLG territory yield (S8-1, §14.3) + march duration + A* march pathfinding (S8-6.6, §4).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

import {
  MARCH_SPEED_SEC_PER_TILE,
  MARCH_MORALE_MAX,
  MARCH_MORALE_COMBAT_FLOOR,
  RESOURCE_YIELD_BASE,
  type ResourceType,
  type TileType,
} from './core';
import { proceduralTile } from './mapgen';

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
 * A* pathfinding from (fx,fy) to (tx,ty).
 * - Returns the full path (including start and end); returns a single node [{fx,fy}] for same-tile.
 * - Returns null if the destination is unreachable (obstacle / no path / out of bounds).
 * - passableGateKeys: set of crossing (bridge/plankway) tile keys that can be traversed (format "x:y"); the destination crossing itself is always reachable regardless of passage rights.
 * - blockedBaseKeys (ADR-025): set of enemy/other main-base tile keys ("x:y") that block pathing —
 *   a player's 3×3 capital is a solid building others must route around ("path-blocking"). The caller excludes
 *   the marcher's own base tiles from this set (owners march in/out freely). The destination itself is
 *   always allowed (isDest), so sieging an enemy base tile stays reachable.
 * - MAX_NODES safety cap (prevents worst-case on very large maps).
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
): PathCell[] | null {
  if (fx === tx && fy === ty) return [{ x: fx, y: fy }];
  if (!_slgInBounds(fx, fy, mapW, mapH) || !_slgInBounds(tx, ty, mapW, mapH)) return null;

  const walkable = (x: number, y: number, isDest: boolean): boolean => {
    if (!_slgInBounds(x, y, mapW, mapH)) return false;
    // Enemy main-base footprint blocks pathing (ADR-025); the destination is exempt so an
    // attacker can still march onto an enemy base tile to besiege it.
    if (!isDest && blockedBaseKeys.has(`${x}:${y}`)) return false;
    const p = proceduralTile(world, x, y);
    if (p.type === 'obstacle') return false; // obstacles always block, including the destination tile
    // Crossings (bridge/plankway): passable only if the destination (so you can march on to besiege it)
    // or occupied by the marcher's faction/allies; an unoccupied crossing blocks like an obstacle.
    if (p.type === 'bridge' || p.type === 'plankway') return isDest || passableGateKeys.has(`${x}:${y}`);
    return true;
  };

  if (!walkable(tx, ty, true)) return null; // destination tile is an obstacle

  const MAX_NODES = 500_000;
  // g: shortest step count from start to this node; par: parent node flat index (for path reconstruction)
  const g = new Map<number, number>();
  const par = new Map<number, number>();
  // open set: min-heap, elements = [f, flatIdx]
  const heap: [number, number][] = [];

  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  const si = fy * mapW + fx;
  g.set(si, 0);
  _slgHeapPush(heap, [h(fx, fy), si]);

  const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const closed = new Set<number>();
  let explored = 0;

  while (heap.length > 0) {
    const [, cur] = _slgHeapPop(heap)!;
    if (closed.has(cur)) continue;
    closed.add(cur);

    const cx = cur % mapW;
    const cy = (cur / mapW) | 0;
    if (cx === tx && cy === ty) return _slgReconstructPath(par, mapW, si, cur);
    if (++explored > MAX_NODES) break;

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
        _slgHeapPush(heap, [ng + h(nx, ny), ni]);
      }
    }
  }
  return null;
}

/** March path → duration (seconds): (path.length-1) steps × MARCH_SPEED_SEC_PER_TILE. */
export function marchDurationFromPath(path: PathCell[]): number {
  return Math.max(0, path.length - 1) * MARCH_SPEED_SEC_PER_TILE;
}

/**
 * Remaining morale (out of MARCH_MORALE_MAX) for a march given its full path: 1 point lost per tile moved
 * (path includes the start cell, so the cost is path.length - 1 tiles), floored at 0. Bound to the march
 * instance — every departure starts fresh at MARCH_MORALE_MAX regardless of the team's history.
 */
export function marchMoraleFromPath(path: PathCell[]): number {
  return Math.max(0, MARCH_MORALE_MAX - Math.max(0, path.length - 1));
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

function _slgHeapPush(heap: [number, number][], item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pi = heap[p]!; const ii = heap[i]!;
    if (pi[0] <= ii[0]) break;
    heap[p] = ii; heap[i] = pi;
    i = p;
  }
}

function _slgHeapPop(heap: [number, number][]): [number, number] | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
      if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
      if (m === i) break;
      const tmp = heap[i]!; heap[i] = heap[m]!; heap[m] = tmp;
      i = m;
    }
  }
  return top;
}
