// Object pool statistics registry (data source for the memory monitor / MemoryMonitor).
//
// Each view/system registers its pool on construction and unregisters it on destruction. MemoryMonitor calls
// snapshotPools() when memory exceeds the threshold (or on WeChat onMemoryWarning) to dump
// "how many idle objects each pool is holding and the estimated memory they occupy" in a single console.warn call.
//
// Design trade-offs:
//  - What is counted here is "idle objects in the pool (already detached, awaiting reuse)", not objects currently active in the scene —
//    the pool itself is resident memory kept for reuse; leaks are most easily spotted here as abnormal growth (e.g. a pool accumulating more and more objects).
//  - bytesEach is a **rough estimate** of JS heap usage (PIXI Container + child Graphics/Sprite geometry buffers + JS object header),
//    excluding GPU VRAM (spritesheets/BaseTextures are shared across matches and do not change with pool size). The figures are for relative comparison, not precision.

export interface PoolSource {
  /** Display label, e.g. 'unit.stickman' / 'building' / 'fx.vfx'. */
  label: string;
  /** Number of idle objects currently held in this pool. */
  idle(): number;
  /** Rough estimated JS heap bytes per idle object (see file header; excludes GPU VRAM). */
  bytesEach: number;
}

const sources = new Set<PoolSource>();

/** Register a pool data source; returns an unregister function (call it in the owner's destroy()). */
export function registerPool(src: PoolSource): () => void {
  sources.add(src);
  return () => { sources.delete(src); };
}

export interface PoolRow {
  label: string;
  idle: number;
  /** Rough estimated bytes: idle × bytesEach. */
  estBytes: number;
}

export interface PoolSnapshot {
  rows: PoolRow[];
  totalIdle: number;
  totalBytes: number;
}

/** Snapshot of all currently registered pools (sorted by estimated usage descending). Entries with the same label are merged and summed (multiple same-named views per match). */
export function snapshotPools(): PoolSnapshot {
  const merged = new Map<string, PoolRow>();
  let totalIdle = 0;
  let totalBytes = 0;
  for (const s of sources) {
    const idle = Math.max(0, s.idle() | 0);
    const estBytes = idle * s.bytesEach;
    totalIdle += idle;
    totalBytes += estBytes;
    const prev = merged.get(s.label);
    if (prev) { prev.idle += idle; prev.estBytes += estBytes; }
    else merged.set(s.label, { label: s.label, idle, estBytes });
  }
  const rows = [...merged.values()].sort((a, b) => b.estBytes - a.estBytes);
  return { rows, totalIdle, totalBytes };
}
