// Editor-side terrain overlay state (DESIGN.md §6.1/§6.2): river/mountain grid brush. Painting stamps a
// brush-sized disc of tiles directly into a persistent tile map — the map itself IS the source of truth,
// with no polyline/vector layer to reconstruct from a "start point" on every render. This module only
// holds/mutates state; rendering and input wiring live in index.ts.
import { SLG_MAP_H, SLG_MAP_W, TERRAIN_BAND_WIDTH_MAX, TERRAIN_BAND_WIDTH_MIN } from '@nw/shared/slg';

export type TerrainKind = 'river' | 'mountain';

export interface TilePoint {
  x: number;
  y: number;
}

/** Random default brush size within the same 5–11 tile range the ADR-034 procedural bands use (DESIGN.md §6.1). */
export function randomDefaultWidth(): number {
  return Math.round(TERRAIN_BAND_WIDTH_MIN + Math.random() * (TERRAIN_BAND_WIDTH_MAX - TERRAIN_BAND_WIDTH_MIN));
}

function forEachCircleTile(cx: number, cy: number, diameter: number, fn: (x: number, y: number) => void): void {
  const r = diameter / 2;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SLG_MAP_W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SLG_MAP_H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) fn(x, y);
    }
  }
}

interface LegacyPath {
  type: TerrainKind;
  points: TilePoint[];
  width: number;
}

export class TerrainGridStore {
  /** "x:y" → painted terrain kind. The map itself is the persisted layer — no separate vector shapes. */
  readonly cells = new Map<string, TerrainKind>();

  get size(): number {
    return this.cells.size;
  }

  /** Stamps a circular brush of the given diameter (tiles), centered at (cx, cy), onto the grid. */
  paintCircle(cx: number, cy: number, kind: TerrainKind, diameter: number): void {
    forEachCircleTile(cx, cy, diameter, (x, y) => this.cells.set(`${x}:${y}`, kind));
  }

  eraseCircle(cx: number, cy: number, diameter: number): void {
    forEachCircleTile(cx, cy, diameter, (x, y) => this.cells.delete(`${x}:${y}`));
  }

  /**
   * Interpolates brush stamps along the segment [from, to] so a fast cursor move between two mousemove
   * samples doesn't leave gaps — same idea as any tilemap/image-editor brush. `kind === null` erases
   * instead of painting.
   */
  strokeCircle(from: TilePoint, to: TilePoint, kind: TerrainKind | null, diameter: number): void {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(0.5, diameter * 0.4)));
    for (let i = 0; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      if (kind) this.paintCircle(x, y, kind, diameter);
      else this.eraseCircle(x, y, diameter);
    }
  }

  clear(): void {
    this.cells.clear();
  }

  toTileInputs(): { x: number; y: number; type: TerrainKind }[] {
    const out: { x: number; y: number; type: TerrainKind }[] = [];
    for (const [key, type] of this.cells) {
      const [xs, ys] = key.split(':');
      out.push({ x: Number(xs), y: Number(ys), type });
    }
    return out;
  }

  toJSON(): string {
    return JSON.stringify(this.toTileInputs(), null, 2);
  }

  /**
   * Accepts either the current per-tile grid format or the retired vector-path format ({points, width})
   * — JSON exported before the grid-brush rewrite is rasterized into cells on load so old work isn't lost.
   */
  loadFromJSON(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    this.cells.clear();
    for (const raw of parsed as Record<string, unknown>[]) {
      if (Array.isArray(raw.points) && typeof raw.width === 'number') {
        this._migrateLegacyPath(raw as unknown as LegacyPath);
        continue;
      }
      if (raw.type !== 'river' && raw.type !== 'mountain') throw new Error(`invalid terrain type: ${String(raw.type)}`);
      if (typeof raw.x !== 'number' || typeof raw.y !== 'number') throw new Error('tile needs numeric x/y');
      this.cells.set(`${raw.x}:${raw.y}`, raw.type);
    }
  }

  private _migrateLegacyPath(path: LegacyPath): void {
    if (path.points.length < 2) {
      const p = path.points[0];
      if (p) this.paintCircle(p.x, p.y, path.type, path.width);
      return;
    }
    for (let i = 0; i < path.points.length - 1; i++) {
      this.strokeCircle(path.points[i]!, path.points[i + 1]!, path.type, path.width);
    }
  }
}
