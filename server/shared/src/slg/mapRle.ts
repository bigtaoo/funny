// Run-length encoding for map-template/baseline terrain rows (SLG_DESIGN §24, 2026-07-27 storage redesign).
// generateTemplate's "batch-run proceduralTile() over the full grid" (mapTemplateService.ts) produces one
// tile per (x,y) — at SLG_MAP_W×SLG_MAP_H (1500×1500, ADR-049) that's 2.25M cells. Storing one Mongo doc per
// cell (the pre-2026-07-27 shape) meant both `mapTemplateTiles` (the template) and `mapBaselines` (every
// world cloned from an active template) each held 2.25M documents — the actual root cause was never
// `cloneActiveTemplateInto` itself but `generateTemplate`'s per-cell materialization it copies from.
// Terrain has long horizontal runs (rings/rivers/mountains are contiguous bands; resource/neutral tiles are
// large uniform stretches between sparse Bernoulli-sampled special tiles — see proceduralTile in mapgen.ts),
// so row-level run-length encoding collapses each 1500-cell row to a handful of runs — one Mongo doc per
// row (height docs total, e.g. 1500) instead of one per cell (width×height, e.g. 2.25M).
import type { ObstacleKind, ResourceType, TileType } from './core';
import type { ProceduralTile } from './mapgen';

/** One contiguous horizontal run of identical tiles, x0..x1 inclusive. */
export interface TileRun {
  x0: number;
  x1: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  obstacleKind?: ObstacleKind;
}

function tileEq(a: ProceduralTile, b: ProceduralTile): boolean {
  return a.type === b.type && a.level === b.level && a.resType === b.resType && a.obstacleKind === b.obstacleKind;
}

function toRun(x0: number, x1: number, t: ProceduralTile): TileRun {
  return { x0, x1, type: t.type, level: t.level, ...(t.resType ? { resType: t.resType } : {}), ...(t.obstacleKind ? { obstacleKind: t.obstacleKind } : {}) };
}

/** Run-length-encodes one row (x in [0,width)) via a per-cell accessor. Pure function, no I/O. */
export function encodeRow(width: number, tileAt: (x: number) => ProceduralTile): TileRun[] {
  const runs: TileRun[] = [];
  let x = 0;
  while (x < width) {
    const t = tileAt(x);
    let x1 = x;
    while (x1 + 1 < width && tileEq(tileAt(x1 + 1), t)) x1++;
    runs.push(toRun(x, x1, t));
    x = x1 + 1;
  }
  return runs;
}

/** Decodes a row's runs back into a per-cell array (index = x, for x in [0,width)). Assumes runs cover [0,width) with no gaps/overlaps. */
export function decodeRow(runs: readonly TileRun[], width: number): ProceduralTile[] {
  const out: ProceduralTile[] = new Array(width);
  for (const r of runs) {
    for (let x = r.x0; x <= r.x1 && x < width; x++) {
      out[x] = { type: r.type, level: r.level, ...(r.resType ? { resType: r.resType } : {}), ...(r.obstacleKind ? { obstacleKind: r.obstacleKind } : {}) };
    }
  }
  return out;
}

/** Reads a single cell from a row's runs (linear scan — rows have a handful of runs, not worth a binary search). Returns undefined if x falls outside every run (a malformed/partial row). */
export function tileAtX(runs: readonly TileRun[], x: number): ProceduralTile | undefined {
  for (const r of runs) {
    if (x >= r.x0 && x <= r.x1) {
      return { type: r.type, level: r.level, ...(r.resType ? { resType: r.resType } : {}), ...(r.obstacleKind ? { obstacleKind: r.obstacleKind } : {}) };
    }
  }
  return undefined;
}

/** Filters a row's runs down to the cells whose x falls in [x0,x1] (inclusive), for a viewport-bbox read. Splits runs that straddle the boundary. */
export function sliceRuns(runs: readonly TileRun[], x0: number, x1: number): TileRun[] {
  const out: TileRun[] = [];
  for (const r of runs) {
    const s = Math.max(r.x0, x0);
    const e = Math.min(r.x1, x1);
    if (s <= e) out.push({ ...r, x0: s, x1: e });
  }
  return out;
}

/** Applies single-cell edits (x → new tile) to an existing row and re-encodes it. Used by saveTilesDiff, which edits a handful of cells at a time against an already-generated (and thus already-row-encoded) template row. */
export function applyEditsToRow(runs: readonly TileRun[], width: number, edits: ReadonlyMap<number, ProceduralTile>): TileRun[] {
  const cells = decodeRow(runs, width);
  for (const [x, t] of edits) {
    if (x >= 0 && x < width) cells[x] = t;
  }
  return encodeRow(width, (x) => cells[x]!);
}
