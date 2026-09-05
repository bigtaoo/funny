// The actual march-pathfinding computation, isolated from where it runs.
//
// This module is deliberately free of worker/pool/DB imports: it is executed today inside a compute worker
// thread (compute/worker.ts) and is meant to be executed unchanged inside a standalone compute service
// later (see compute/types.ts's phase-4 note). Anything added here must stay pure — same request, same
// answer, no clock, no I/O.
import { findMarchPath, getMapTerrainIndex, reachableThroughGates, type PathCell } from '@nw/shared';
import type { PathRequest } from './types';

/**
 * Resolve one march path, or `null` when the destination is unreachable.
 *
 * Two-stage on purpose. `reachableThroughGates` is a CONSERVATIVE proof over terrain and crossings only —
 * it ignores enemy capitals and blocker structures, which can only ever remove routes — so a `false` is a
 * real "no path" and lets us skip an A* run that would otherwise burn its whole node budget to reach the
 * same conclusion. That case was measured at 2-6 SECONDS on the live 1500x1500 map and was the single
 * largest source of blocked event-loop time in worldsvc (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05).
 *
 * When it says "maybe", the real A* decides — handed the same terrain index, which replaces its
 * per-neighbour `proceduralTile()` call with an array read (~4x on top).
 */
export function runPathSync(req: PathRequest): PathCell[] | null {
  // Cached per process with a bounded LRU, so this builds once per world (~2.5s at 1500x1500) and is then
  // free. compute/pool.ts's warmWorld pays that cost at boot, on every worker, before any player order.
  const idx = getMapTerrainIndex(req.world, req.mapW, req.mapH);
  const gates = new Set(req.passableGateKeys);
  if (!reachableThroughGates(idx, req.fx, req.fy, req.tx, req.ty, gates)) return null;
  return findMarchPath(
    req.world,
    req.mapW,
    req.mapH,
    req.fx,
    req.fy,
    req.tx,
    req.ty,
    gates,
    new Set(req.blockedBaseKeys),
    { index: idx },
  );
}

/** Build the per-world terrain index now, so the first real path request does not pay for it. */
export function warmPathIndex(world: string, mapW: number, mapH: number): void {
  getMapTerrainIndex(world, mapW, mapH);
}
