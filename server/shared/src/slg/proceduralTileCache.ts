// Memoised proceduralTile() for request-serving threads (worldsvc-3000 phase 0 follow-up, 2026-09-26).
//
// The phase-0 main-thread profile (WORLDSVC_CONCURRENCY_AUDIT §12.8) put ~20% of worldsvc's busy time in
// proceduralTile and its terrain/noise helpers, almost all of it from GET /world/map re-deriving every
// unoccupied cell of the viewport on every read. The answer for a given (world, x, y) never changes, so
// this caches it.
//
// Why not reuse MapTerrainIndex: that index keeps only the 3-way pathing class, not level / resType /
// obstacleKind, and building it is a ~3s whole-map pass that must never run on a request thread.
// This cache instead fills lazily in CHUNK×CHUNK blocks, so the first read of a viewport pays for at most
// a handful of chunks (a few thousand cells, single-digit ms) and every later read is an array lookup.
//
// Memory: each cell stores a Uint16 index into an interned table of distinct tiles (a few hundred
// type/level/resType/obstacleKind combinations), so a fully visited 1500×1500 world is 4.5MB.
// Returned objects are SHARED and frozen — callers must copy, never mutate.
import { proceduralTile } from './mapgen/tileGen';
import type { ProceduralTile } from './mapgen/types';

const CHUNK = 32;
const CHUNK_CELLS = CHUNK * CHUNK;

/** Same bound and rationale as mapTerrainIndex's INDEX_CACHE_MAX: two live shards plus rollover headroom. */
const WORLD_CACHE_MAX = 4;

interface WorldTiles {
  /** Chunk key `cy * chunksX + cx` → per-cell index into `palette`. */
  chunks: Map<number, Uint16Array>;
  palette: Readonly<ProceduralTile>[];
  paletteIndex: Map<string, number>;
}

// Insertion-ordered LRU, same pattern as mapTerrainIndex's indexCache.
const worlds = new Map<string, WorldTiles>();

function worldTiles(world: string): WorldTiles {
  const hit = worlds.get(world);
  if (hit) {
    worlds.delete(world);
    worlds.set(world, hit);
    return hit;
  }
  const w: WorldTiles = { chunks: new Map(), palette: [], paletteIndex: new Map() };
  worlds.set(world, w);
  while (worlds.size > WORLD_CACHE_MAX) {
    const oldest = worlds.keys().next();
    if (oldest.done) break;
    worlds.delete(oldest.value);
  }
  return w;
}

function intern(w: WorldTiles, t: ProceduralTile): number {
  const key = `${t.type}|${t.level}|${t.resType ?? ''}|${t.obstacleKind ?? ''}`;
  let i = w.paletteIndex.get(key);
  if (i === undefined) {
    if (w.palette.length >= 0xffff) throw new Error('proceduralTileCache palette overflow');
    i = w.palette.length;
    w.palette.push(Object.freeze({ ...t }));
    w.paletteIndex.set(key, i);
  }
  return i;
}

/**
 * {@link proceduralTile}, memoised per world. Identical result for in-map coordinates; coordinates outside
 * [0, 65535] bypass the cache. The returned object is shared across calls and frozen.
 */
export function cachedProceduralTile(world: string, x: number, y: number): Readonly<ProceduralTile> {
  if (x < 0 || y < 0 || x > 0xffff || y > 0xffff || !Number.isInteger(x) || !Number.isInteger(y)) {
    return proceduralTile(world, x, y);
  }
  const w = worldTiles(world);
  const cx = Math.floor(x / CHUNK);
  const cy = Math.floor(y / CHUNK);
  const key = cy * 0x10000 + cx;
  let chunk = w.chunks.get(key);
  if (!chunk) {
    chunk = new Uint16Array(CHUNK_CELLS);
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    for (let dy = 0; dy < CHUNK; dy++) {
      for (let dx = 0; dx < CHUNK; dx++) {
        chunk[dy * CHUNK + dx] = intern(w, proceduralTile(world, x0 + dx, y0 + dy));
      }
    }
    w.chunks.set(key, chunk);
  }
  return w.palette[chunk[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)]!]!;
}

/** Drop every cached world. Tests only. */
export function clearProceduralTileCache(): void {
  worlds.clear();
}
