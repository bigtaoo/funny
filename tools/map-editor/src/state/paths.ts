// Editor-side terrain overlay state (DESIGN.md §6.1/§6.2): river/mountain path brush.
// Data shape matches the doc's leaning data form — a vector polyline + width, not a per-tile
// coverage table. This module only holds/mutates state; rendering and input wiring live in index.ts.
import { TERRAIN_BAND_WIDTH_MAX, TERRAIN_BAND_WIDTH_MIN } from '@nw/shared/slg';

export type PathKind = 'river' | 'mountain';

export interface TilePoint {
  x: number;
  y: number;
}

export interface TerrainPath {
  id: string;
  type: PathKind;
  points: TilePoint[];
  width: number;
}

let _nextId = 1;

/** Random default width within the same 5–11 tile range the ADR-034 procedural bands use (DESIGN.md §6.1). */
export function randomDefaultWidth(): number {
  return Math.round(TERRAIN_BAND_WIDTH_MIN + Math.random() * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN));
}

export class PathStore {
  readonly paths: TerrainPath[] = [];

  add(type: PathKind, points: TilePoint[], width: number): TerrainPath {
    const path: TerrainPath = { id: `p${_nextId++}`, type, points, width };
    this.paths.push(path);
    return path;
  }

  remove(id: string): void {
    const idx = this.paths.findIndex((p) => p.id === id);
    if (idx >= 0) this.paths.splice(idx, 1);
  }

  clear(): void {
    this.paths.length = 0;
  }

  get(id: string): TerrainPath | undefined {
    return this.paths.find((p) => p.id === id);
  }

  toJSON(): string {
    return JSON.stringify(this.paths, null, 2);
  }

  loadFromJSON(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('expected an array of paths');
    this.paths.length = 0;
    for (const raw of parsed as TerrainPath[]) {
      if (raw.type !== 'river' && raw.type !== 'mountain') throw new Error(`invalid path type: ${String(raw.type)}`);
      if (!Array.isArray(raw.points) || raw.points.length < 2) throw new Error('path needs >=2 points');
      this.paths.push({ id: raw.id || `p${_nextId++}`, type: raw.type, points: raw.points, width: raw.width });
    }
  }
}

/** Perpendicular distance (in tiles) from a point to the nearest point on segment [a,b]. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Nearest distance (in tiles) from (x,y) to any segment of the path's polyline. */
export function distToPath(x: number, y: number, path: TerrainPath): number {
  let best = Infinity;
  for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i]!;
    const b = path.points[i + 1]!;
    best = Math.min(best, distToSegment(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}
