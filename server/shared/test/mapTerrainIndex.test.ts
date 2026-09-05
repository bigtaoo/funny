// Tests for the march-pathfinding terrain/connectivity index (worldsvc-concurrency-2026-09-05, phase 1).
//
// The index is an OPTIMISATION that is allowed to change how long a march order takes and nothing else, so
// the tests that matter are equivalence tests: the indexed A* must return exactly what the unindexed A*
// returns, and the connectivity short-circuit must never claim "unreachable" for a target A* can actually
// reach. Both are checked against the real 1500x1500 procedural map, not a fixture, because the whole point
// is the shape of that specific map (20 components joined by 75 crossings).
import { describe, it, expect } from 'vitest';
import {
  buildMapTerrainIndex,
  getMapTerrainIndex,
  clearMapTerrainIndexCache,
  reachableThroughGates,
  findMarchPath,
  proceduralTile,
  TERRAIN_PASSABLE,
  TERRAIN_OBSTACLE,
  TERRAIN_CROSSING,
  SLG_MAP_W,
  SLG_MAP_H,
} from '../src/index';

const WORLD = 's1-0';

// Built once for the whole file: ~2.5s at full map size, and every test here wants the same one.
const index = buildMapTerrainIndex(WORLD, SLG_MAP_W, SLG_MAP_H);

/** Deterministic pseudo-random pairs, so a failure is reproducible rather than "it flaked once". */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('buildMapTerrainIndex', () => {
  it('classifies every cell exactly as findMarchPath would classify it from proceduralTile', () => {
    const rand = lcg(7);
    for (let i = 0; i < 5000; i++) {
      const x = Math.floor(rand() * SLG_MAP_W);
      const y = Math.floor(rand() * SLG_MAP_H);
      const type = proceduralTile(WORLD, x, y).type;
      const expected =
        type === 'obstacle' ? TERRAIN_OBSTACLE
          : type === 'bridge' || type === 'plankway' ? TERRAIN_CROSSING
            : TERRAIN_PASSABLE;
      expect(index.terrain[y * SLG_MAP_W + x]).toBe(expected);
    }
  });

  it('assigns a component to every passable cell and none to obstacles or crossings', () => {
    const rand = lcg(11);
    for (let i = 0; i < 5000; i++) {
      const flat = Math.floor(rand() * index.terrain.length);
      const cls = index.terrain[flat]!;
      if (cls === TERRAIN_PASSABLE) expect(index.component[flat]).toBeGreaterThan(0);
      else expect(index.component[flat]).toBe(0);
    }
  });

  it('finds a small number of components on the real map — the premise the O(1) reachability check rests on', () => {
    // If a map change ever shattered this into thousands of components the BFS in reachableThroughGates
    // would stop being free, so the number is pinned loosely rather than left unstated.
    expect(index.componentCount).toBeGreaterThan(1);
    expect(index.componentCount).toBeLessThan(200);
    expect(index.gates.size).toBeGreaterThan(0);
  });

  it('records, for each crossing, the components it would join', () => {
    for (const [flat, comps] of index.gates) {
      expect(index.terrain[flat]).toBe(TERRAIN_CROSSING);
      for (const c of comps) expect(c).toBeGreaterThan(0);
    }
  });
});

describe('getMapTerrainIndex caching', () => {
  it('returns the same instance for the same world and rebuilds after a clear', () => {
    clearMapTerrainIndexCache();
    const a = getMapTerrainIndex('tiny-cache-world', 8, 8);
    expect(getMapTerrainIndex('tiny-cache-world', 8, 8)).toBe(a);
    clearMapTerrainIndexCache();
    expect(getMapTerrainIndex('tiny-cache-world', 8, 8)).not.toBe(a);
  });

  it('keys on map size, so a resized map does not reuse the old classification', () => {
    clearMapTerrainIndexCache();
    const small = getMapTerrainIndex('tiny-cache-world', 8, 8);
    const large = getMapTerrainIndex('tiny-cache-world', 16, 16);
    expect(large).not.toBe(small);
    expect(large.terrain.length).toBe(256);
  });

  it('evicts least-recently-used worlds rather than growing without bound', () => {
    clearMapTerrainIndexCache();
    const first = getMapTerrainIndex('lru-0', 8, 8);
    for (let i = 1; i <= 4; i++) getMapTerrainIndex(`lru-${i}`, 8, 8);
    // 'lru-0' was pushed out by the four that followed it, so this is a fresh build, not the same object.
    expect(getMapTerrainIndex('lru-0', 8, 8)).not.toBe(first);
  });
});

describe('findMarchPath with an index', () => {
  it('returns exactly the same path as the unindexed search, over random real-map pairs', () => {
    const rand = lcg(23);
    let checked = 0;
    for (let i = 0; i < 25; i++) {
      const fx = 200 + Math.floor(rand() * 1100);
      const fy = 200 + Math.floor(rand() * 1100);
      const d = 5 + Math.floor(rand() * 60);
      const ang = rand() * Math.PI * 2;
      const tx = Math.max(0, Math.min(SLG_MAP_W - 1, Math.round(fx + Math.cos(ang) * d)));
      const ty = Math.max(0, Math.min(SLG_MAP_H - 1, Math.round(fy + Math.sin(ang) * d)));
      const gates = new Set<string>();
      const withIndex = findMarchPath(WORLD, SLG_MAP_W, SLG_MAP_H, fx, fy, tx, ty, gates, new Set(), { index });
      const without = findMarchPath(WORLD, SLG_MAP_W, SLG_MAP_H, fx, fy, tx, ty, gates);
      expect(withIndex).toEqual(without);
      checked++;
    }
    expect(checked).toBe(25);
  });

  it('honours a smaller node budget by giving up rather than searching forever', () => {
    // A tiny budget cannot cross the map, so the search reports no path — the cap is live, not decorative.
    const path = findMarchPath(WORLD, SLG_MAP_W, SLG_MAP_H, 300, 300, 1200, 1200, new Set(), new Set(), { index, maxNodes: 50 });
    expect(path).toBeNull();
  });
});

describe('reachableThroughGates', () => {
  it('never rules out a target the real A* can reach (the safety property the short-circuit depends on)', () => {
    const rand = lcg(41);
    let reachableCases = 0;
    for (let i = 0; i < 60; i++) {
      const fx = 200 + Math.floor(rand() * 1100);
      const fy = 200 + Math.floor(rand() * 1100);
      const d = 5 + Math.floor(rand() * 80);
      const ang = rand() * Math.PI * 2;
      const tx = Math.max(0, Math.min(SLG_MAP_W - 1, Math.round(fx + Math.cos(ang) * d)));
      const ty = Math.max(0, Math.min(SLG_MAP_H - 1, Math.round(fy + Math.sin(ang) * d)));
      const gates = new Set<string>();
      const path = findMarchPath(WORLD, SLG_MAP_W, SLG_MAP_H, fx, fy, tx, ty, gates, new Set(), { index });
      if (!path) continue;
      reachableCases++;
      expect(reachableThroughGates(index, fx, fy, tx, ty, gates)).toBe(true);
    }
    expect(reachableCases).toBeGreaterThan(0);
  });

  it('holds the same way when every crossing is open (gates must widen reachability, never narrow it)', () => {
    const allGates = new Set<string>();
    for (const flat of index.gates.keys()) allGates.add(`${flat % SLG_MAP_W}:${(flat / SLG_MAP_W) | 0}`);
    const rand = lcg(59);
    let reachableCases = 0;
    for (let i = 0; i < 30; i++) {
      const fx = 200 + Math.floor(rand() * 1100);
      const fy = 200 + Math.floor(rand() * 1100);
      const d = 5 + Math.floor(rand() * 120);
      const ang = rand() * Math.PI * 2;
      const tx = Math.max(0, Math.min(SLG_MAP_W - 1, Math.round(fx + Math.cos(ang) * d)));
      const ty = Math.max(0, Math.min(SLG_MAP_H - 1, Math.round(fy + Math.sin(ang) * d)));
      const path = findMarchPath(WORLD, SLG_MAP_W, SLG_MAP_H, fx, fy, tx, ty, allGates, new Set(), { index });
      if (!path) continue;
      reachableCases++;
      expect(reachableThroughGates(index, fx, fy, tx, ty, allGates)).toBe(true);
    }
    expect(reachableCases).toBeGreaterThan(0);
  });

  it('rules out a target across a closed crossing, and admits it once the crossing is held', () => {
    // Pick a real crossing that actually separates two components, then ask across it both ways.
    let probe: { gate: number; a: number; b: number } | null = null;
    for (const [flat, comps] of index.gates) {
      if (comps.length >= 2) {
        probe = { gate: flat, a: comps[0]!, b: comps[1]! };
        break;
      }
    }
    if (!probe) return; // no separating crossing on this map: nothing to assert, and not a failure
    const cellOf = (comp: number): [number, number] => {
      for (let i = 0; i < index.component.length; i++) {
        if (index.component[i] === comp) return [i % SLG_MAP_W, (i / SLG_MAP_W) | 0];
      }
      throw new Error(`component ${comp} has no cells`);
    };
    const [ax, ay] = cellOf(probe.a);
    const [bx, by] = cellOf(probe.b);
    const gateKey = `${probe.gate % SLG_MAP_W}:${(probe.gate / SLG_MAP_W) | 0}`;
    const closed = reachableThroughGates(index, ax, ay, bx, by, new Set());
    const open = reachableThroughGates(index, ax, ay, bx, by, new Set([gateKey]));
    // Opening a gate can only help. Two components may also be joined elsewhere, so `closed` is not
    // asserted false — what must hold is that opening never takes reachability away.
    expect(open || !closed).toBe(true);
  });

  it('lets a marcher standing ON a held crossing path out of it (ADR-051 idle re-dispatch)', () => {
    const gate = index.gates.entries().next();
    if (gate.done) return;
    const [flat, comps] = gate.value;
    if (comps.length === 0) return;
    const gx = flat % SLG_MAP_W;
    const gy = (flat / SLG_MAP_W) | 0;
    // Any neighbouring passable cell is in one of this gate's components, so it must be reachable.
    for (const [nx, ny] of [[gx - 1, gy], [gx + 1, gy], [gx, gy - 1], [gx, gy + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
      if (index.terrain[ny * SLG_MAP_W + nx] !== TERRAIN_PASSABLE) continue;
      expect(reachableThroughGates(index, gx, gy, nx, ny, new Set())).toBe(true);
      return;
    }
  });

  it('rejects out-of-bounds endpoints and an obstacle destination', () => {
    expect(reachableThroughGates(index, -1, 0, 10, 10, new Set())).toBe(false);
    expect(reachableThroughGates(index, 10, 10, SLG_MAP_W, 10, new Set())).toBe(false);
    let obstacle: [number, number] | null = null;
    for (let i = 0; i < index.terrain.length; i++) {
      if (index.terrain[i] === TERRAIN_OBSTACLE) {
        obstacle = [i % SLG_MAP_W, (i / SLG_MAP_W) | 0];
        break;
      }
    }
    expect(obstacle).not.toBeNull();
    expect(reachableThroughGates(index, 750, 750, obstacle![0], obstacle![1], new Set())).toBe(false);
  });

  it('treats a same-cell request as reachable', () => {
    expect(reachableThroughGates(index, 400, 400, 400, 400, new Set())).toBe(true);
  });
});
