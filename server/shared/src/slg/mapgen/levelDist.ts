// Split from mapgen.ts (2026-08-10, independent function module range 6, part 5/7).
// Per-ring level distribution (ADR-034 §4): percent-by-level tables (must each sum to 100); a smooth
// noise value is mapped through the cumulative distribution so same-region levels stay spatially
// continuous rather than randomly scattered per tile.
import type { NationKind } from '../province';

const _LEVEL_DIST_OUTER: readonly number[] = [34, 26, 16, 10, 6, 4, 3, 1, 0, 0];
const _LEVEL_DIST_RESOURCE: readonly number[] = [14, 10, 7, 6, 16, 14, 12, 9, 7, 5];
const _LEVEL_DIST_CORE: readonly number[] = [3, 5, 6, 8, 8, 10, 12, 14, 16, 18];

function _levelDistFor(kind: NationKind): readonly number[] {
  if (kind === 'outer') return _LEVEL_DIST_OUTER;
  if (kind === 'resource') return _LEVEL_DIST_RESOURCE;
  return _LEVEL_DIST_CORE;
}

/** Maps a smooth noise value [0,1) to a tile level 1..SLG_MAP_MAX_LEVEL via the per-ring cumulative percent table (ADR-034 §4). */
export function _levelFromRing(kind: NationKind, noise: number): number {
  const dist = _levelDistFor(kind);
  const target = Math.max(0, Math.min(99.999, noise * 100));
  let cum = 0;
  for (let lvl = 1; lvl <= dist.length; lvl++) {
    cum += dist[lvl - 1]!;
    if (target < cum) return lvl;
  }
  return dist.length;
}
