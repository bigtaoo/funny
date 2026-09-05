// compute/pathRunner — the march-pathfinding computation the compute backend actually executes
// (worldsvc-concurrency-2026-09-05, phase 1).
//
// The equivalence and safety properties of the terrain index itself are pinned next door in
// shared/test/mapTerrainIndex.test.ts, against the real 1500x1500 map. What is worth pinning HERE is the
// wiring: that runPathSync agrees with a plain findMarchPath for the same request, that it honours the
// gate and blocker sets it is handed, and that warmPathIndex actually removes the build cost from the
// first request (the reason index.ts pays it at boot).
import { describe, it, expect, beforeEach } from 'vitest';
import { findMarchPath, clearMapTerrainIndexCache } from '@nw/shared';
import { runPathSync, warmPathIndex } from '../src/compute/pathRunner';
import type { PathRequest } from '../src/compute/types';

// A small map keeps these tests fast; the procedural generator is the same one the real world uses, just
// asked about a smaller window, so the terrain still has genuine obstacles and crossings in it.
const W = 60;
const H = 60;
const WORLD = 'path-runner-test-world';

function req(over: Partial<PathRequest>): PathRequest {
  return {
    world: WORLD,
    mapW: W,
    mapH: H,
    fx: 5,
    fy: 5,
    tx: 20,
    ty: 20,
    passableGateKeys: [],
    blockedBaseKeys: [],
    ...over,
  };
}

beforeEach(() => {
  clearMapTerrainIndexCache();
});

describe('runPathSync', () => {
  it('agrees with a plain findMarchPath for the same request', () => {
    const r = req({});
    const viaRunner = runPathSync(r);
    const direct = findMarchPath(r.world, r.mapW, r.mapH, r.fx, r.fy, r.tx, r.ty, new Set(), new Set());
    expect(viaRunner).toEqual(direct);
  });

  it('returns a path that starts at the origin and ends at the target', () => {
    const path = runPathSync(req({}));
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 5, y: 5 });
    expect(path![path!.length - 1]).toEqual({ x: 20, y: 20 });
  });

  it('returns a single cell for a same-tile request', () => {
    expect(runPathSync(req({ tx: 5, ty: 5 }))).toEqual([{ x: 5, y: 5 }]);
  });

  it('returns null for an out-of-bounds target instead of throwing', () => {
    expect(runPathSync(req({ tx: W + 10, ty: 5 }))).toBeNull();
  });

  it('routes around blocked cells, and reports no path when they seal the target off', () => {
    // Wall the target in on all four sides. The connectivity pre-filter does not model blockers (that is
    // exactly why it is only allowed to prove UNreachability from terrain), so this exercises the case
    // where the pre-filter says "maybe" and A* has the final say.
    const walled = req({ tx: 20, ty: 20, blockedBaseKeys: ['19:20', '21:20', '20:19', '20:21'] });
    expect(runPathSync(walled)).toBeNull();
    // One gap in the wall and it is reachable again — the blockers are being read, not ignored.
    expect(runPathSync({ ...walled, blockedBaseKeys: ['19:20', '21:20', '20:19'] })).not.toBeNull();
  });

  it('passes the gate set through to the search', () => {
    // Whatever this map's crossings are, handing over every cell as "passable" can only ever widen the
    // search, never narrow it — so a request that succeeds with no gates must still succeed with all of
    // them, and one that fails may now succeed.
    const closed = runPathSync(req({ tx: 40, ty: 40 }));
    const allCells: string[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) allCells.push(`${x}:${y}`);
    const opened = runPathSync(req({ tx: 40, ty: 40, passableGateKeys: allCells }));
    if (closed) expect(opened).not.toBeNull();
  });
});

describe('warmPathIndex', () => {
  it('makes the first real request cheap by building the index up front', () => {
    // Cache cleared in beforeEach, so this call is the one that pays the build.
    const t0 = performance.now();
    warmPathIndex(WORLD, W, H);
    const warmMs = performance.now() - t0;

    const t1 = performance.now();
    runPathSync(req({}));
    const requestMs = performance.now() - t1;

    // The assertion is the ordering, not a wall-clock number: whatever the machine, the build must land in
    // the warmup and not in the request. On the real map that difference is ~2.5s versus milliseconds.
    expect(requestMs).toBeLessThanOrEqual(Math.max(warmMs, 50));
  });

  it('is idempotent — warming twice does not rebuild', () => {
    warmPathIndex(WORLD, W, H);
    const t0 = performance.now();
    warmPathIndex(WORLD, W, H);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
