// Regression gate for the property the whole worldsvc-concurrency-2026-09-05 workstream exists to
// establish: **dispatching a march must not do CPU work on the event loop**.
//
// The bug this guards against is not a wrong answer, it is a stopped process. `findMarchPath` is a
// synchronous A*, and on the live 1500x1500 map an unreachable target made it burn its whole 500k-node
// budget — measured at 2 to 6 SECONDS during which worldsvc served nobody: not other players' orders, not
// Mongo/Redis callbacks, not the scheduler. That is the entire explanation for the report that opened the
// audit ("my fifth team's order lags"), and one player alone can trigger it.
//
// Nothing else in the suite would catch its return. Every existing march test asserts on the RESULT of a
// dispatch, and the result is identical whether the path was computed on the event loop or on a worker —
// only the wall clock differs, and only for everyone else. So this file asserts on the wall clock, and on
// the shape of the code that keeps it honest:
//
//   1. a source gate — the dispatch path must route pathfinding through the compute backend;
//   2. a behavioural gate — the loop stays responsive while pathfinding is in flight, including for the
//      unreachable targets that used to be the expensive case;
//   3. a concurrency gate — many dispatches at once still finish promptly and all succeed.
//
// Thresholds are deliberately loose (see LOOP_STALL_BUDGET_MS): this is a regression gate, not a
// benchmark. It has to fail on "the synchronous call came back" and pass on a loaded CI runner.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  proceduralTile,
  buildMapTerrainIndex,
  TERRAIN_PASSABLE,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
  npcGarrison,
  type MapTerrainIndex,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { WorldCore } from '../src/core';
import { computeMarchPath } from '../src/combatShared';
import { getComputeBackend, shutdownComputeBackend } from '../src/compute';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_concurrency_test';
const W = 's1-conc';

/**
 * Longest the event loop may go unserved while pathfinding is in flight.
 *
 * 400ms is chosen against both failure modes, not as a round number. The regression it must catch parked
 * the loop for 2000-6000ms, so there is a 5-15x margin below it. The noise it must tolerate is a shared
 * 2-vCPU CI runner also running mongodb-memory-server, vitest's own machinery and (by design) worker
 * threads chewing on A* — ordinary GC and scheduler jitter there is tens of ms, so there is roughly an
 * order of magnitude of headroom above it. If this ever goes flaky, the answer is to look at what got
 * slower, not to raise the number: at 2000ms it stops distinguishing the two.
 */
const LOOP_STALL_BUDGET_MS = 400;

/** Concurrent dispatches in the throughput case. Small enough to stay quick; large enough to serialize visibly if pathfinding ever moves back onto the loop. */
const CONCURRENT_DISPATCHES = 12;

const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
};
const fakeGateway: WorldGatewayClient = {
  available: false,
  async push() {},
  async broadcast() {},
};

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.concurrency.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * Watches how late a 5ms interval actually fires. That lateness IS the quantity under test: a callback
 * cannot run while someone else holds the thread, so the largest gap is the longest the process was
 * unavailable to every other player.
 */
class LoopProbe {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  maxGapMs = 0;
  ticks = 0;

  start(): void {
    this.maxGapMs = 0;
    this.ticks = 0;
    this.last = Date.now();
    this.timer = setInterval(() => this.mark(), 5);
  }

  /**
   * Stop, and fold in the time since the last tick.
   *
   * That last step is load-bearing, and leaving it out is how the first version of this file passed its
   * own mutation check with the synchronous pathfinder restored. When a synchronous block ends, Node
   * drains microtasks — the promise continuation this code is sitting in — BEFORE timers, so `stop()`
   * runs first and clears the interval, and the tick that would have recorded the multi-second gap never
   * happens. The probe saw a quiet loop precisely when the loop had been frozen. Measuring the tail here
   * makes the last interval an ordinary one instead of the one that gets thrown away.
   */
  stop(): void {
    this.mark();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private mark(): void {
    const now = Date.now();
    this.maxGapMs = Math.max(this.maxGapMs, now - this.last);
    this.last = now;
    this.ticks++;
  }
}

/**
 * A cell in each of the two LARGEST terrain components — a pair with no route over land.
 *
 * Largest, not first-found: scanning from index 0 lands on whatever sliver happens to touch the top-left
 * corner, which is a real component but not the case players hit. The two big landmasses either side of a
 * river are, and they are also far enough apart to be the expensive search the old code choked on.
 */
function crossComponentPair(index: MapTerrainIndex): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const size = new Map<number, number>();
  const cell = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < index.component.length; i++) {
    const c = index.component[i]!;
    if (c === 0) continue;
    size.set(c, (size.get(c) ?? 0) + 1);
    // Keep a mid-component cell rather than the first one seen, so the endpoints sit inside the landmass.
    if (!cell.has(c) || size.get(c)! % 5000 === 0) cell.set(c, { x: i % SLG_MAP_W, y: (i / SLG_MAP_W) | 0 });
  }
  const biggest = [...size.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (biggest.length < 2) return null;
  return { from: cell.get(biggest[0]![0])!, to: cell.get(biggest[1]![0])! };
}

/** A passable cell near (sx,sy), for the reachable half of the workload. */
function passableNear(index: MapTerrainIndex, sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (index.terrain[y * SLG_MAP_W + x] === TERRAIN_PASSABLE) return { x, y };
      }
    }
  }
  throw new Error('no passable cell found');
}

describe('march dispatch does its pathfinding off the event loop', () => {
  it('the dispatch path routes pathfinding through the compute backend, not a direct synchronous call', () => {
    // A source gate, deliberately: the behavioural checks below need Mongo and are skipped without it,
    // and this is the one assertion that must hold on every machine and every run. It is also the exact
    // shape of the regression — someone "simplifying" combatShared.ts back to calling findMarchPath
    // inline would restore a multi-second event-loop stall while every existing test stayed green.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'combatShared.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toContain('getComputeBackend');
    expect(code).not.toMatch(/\bfindMarchPath\s*\(/);
  });

  it('the compute backend, not this thread, is what pathfinding is submitted to', () => {
    // Pins the other half of the seam: `findPath` must exist on whatever backend is selected, so the
    // phase-4 swap to a remote compute service cannot silently lose the call site.
    const backend = getComputeBackend();
    expect(typeof backend.findPath).toBe('function');
    expect(typeof backend.warmWorld).toBe('function');
    expect(backend.name).toBe('worker');
  });
});

describe.skipIf(!mongo)('march dispatch concurrency e2e', () => {
  const m = mongo!;
  let svc: WorldService;
  // computeMarchPath takes the shared kernel, not the facade: WorldService COMPOSES a private WorldCore
  // rather than extending it (2026-08-11 mixin-chain split), so the two are not interchangeable. Both are
  // built over the same deps here, so they see the same database.
  let core: WorldCore;
  let index: MapTerrainIndex;
  let nowMs = 1_000_000;

  beforeAll(async () => {
    // Built here rather than inside a measured window: ~2.3s of pure CPU on this thread, which is exactly
    // the cost worldsvc pays once per world on a compute worker at boot (index.ts's warmWorld).
    index = buildMapTerrainIndex(W, SLG_MAP_W, SLG_MAP_H);
    await getComputeBackend().warmWorld(W, SLG_MAP_W, SLG_MAP_H);
  }, 120_000);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    const deps = {
      cols: m.collections, redis: null, gateway: fakeGateway, meta: fakeMeta,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs,
    };
    svc = new WorldService(deps);
    core = new WorldCore(deps);
  });

  afterAll(async () => {
    await shutdownComputeBackend();
    await m.db.dropDatabase();
    await m.close();
  });

  it('keeps serving other work while an UNREACHABLE target is being resolved (the 2-6s case)', async () => {
    const pair = crossComponentPair(index);
    // The real map has 20 components; if a map change ever left exactly one, this case cannot be built
    // and saying so is better than passing vacuously.
    expect(pair, 'the map has no two disconnected components to test with').not.toBeNull();

    // No joinWorld: computeMarchPath reads only `familyId` / `mainBaseTile` off the requester's document
    // and tolerates its absence, and a capital cannot be planted at an arbitrary component's edge anyway
    // (the 3x3 footprint has to fit). The pathfinder behaves identically either way, and it is what is
    // being measured here.
    const probe = new LoopProbe();
    probe.start();
    const t0 = Date.now();
    // Straight at computeMarchPath rather than through startMarch: this is the layer that used to block,
    // and ADR-039 connectivity would refuse a cross-component occupy long before the pathfinder saw it.
    await expect(
      computeMarchPath(core, W, pair!.from.x, pair!.from.y, pair!.to.x, pair!.to.y, 'a'),
    ).rejects.toThrow(/PATH_BLOCKED|No viable path/);
    const elapsed = Date.now() - t0;
    probe.stop();

    expect(probe.ticks, 'the probe never ran — the measurement is meaningless').toBeGreaterThan(0);
    expect(probe.maxGapMs).toBeLessThan(LOOP_STALL_BUDGET_MS);
    // The verdict itself now comes from an O(1) connectivity proof, so it is fast in absolute terms too.
    expect(elapsed).toBeLessThan(2_000);
  }, 60_000);

  it('keeps serving other work while many reachable paths are computed at once', async () => {
    const from = passableNear(index, 400, 400);
    // Deliberately LONG legs (40-150 cells). A handful of short hops is cheap even computed synchronously,
    // so short targets here would let the regression through — verified by mutation: with the synchronous
    // call restored, short legs kept this green while long ones do not.
    const targets = Array.from({ length: CONCURRENT_DISPATCHES }, (_, i) => passableNear(index, from.x + 40 + i * 9, from.y + 40 + i * 9));
    await svc.joinWorld(W, 'a', from.x, from.y);

    const probe = new LoopProbe();
    probe.start();
    const paths = await Promise.all(
      targets.map((t) => computeMarchPath(core, W, from.x, from.y, t.x, t.y, 'a').catch(() => null)),
    );
    probe.stop();

    // At least some had to actually succeed, or "the loop stayed free" would be true of doing nothing.
    expect(paths.filter(Boolean).length).toBeGreaterThan(0);
    expect(probe.ticks).toBeGreaterThan(0);
    expect(probe.maxGapMs).toBeLessThan(LOOP_STALL_BUDGET_MS);
  }, 60_000);

  it('settles a burst of concurrent occupy orders from different players without stalling', async () => {
    // The end-to-end shape of the original report: several orders issued at once. Each player gets their
    // own base and their own adjacent target, so the burst exercises real dispatch (validation, pool
    // debit, march insert) and not just the pathfinder.
    //
    // Scope, stated so nobody mistakes it for the stall gate: these legs are two cells long, and two-cell
    // A* is cheap even computed synchronously — under mutation this case stays green while the two above
    // fail loudly. It guards the OTHER half of the dispatch path (that concurrent orders all succeed and
    // do not serialize on Mongo), not the event loop.
    const players: { id: string; base: { x: number; y: number }; target: { x: number; y: number } }[] = [];
    for (let i = 0; i < CONCURRENT_DISPATCHES; i++) {
      const spot = pickBaseAndTarget(index, 300 + i * 40, 300 + i * 40);
      if (spot) players.push({ id: `p${i}`, ...spot });
    }
    expect(players.length).toBeGreaterThan(4);
    for (const p of players) await svc.joinWorld(W, p.id, p.base.x, p.base.y);

    const probe = new LoopProbe();
    probe.start();
    const t0 = Date.now();
    const results = await Promise.allSettled(
      players.map((p) => {
        const troops = npcGarrison(proceduralTile(W, p.target.x, p.target.y).level) + OCCUPY_MIN_TROOPS + 500;
        return svc.startMarch(W, p.id, p.base.x, p.base.y, p.target.x, p.target.y, 'occupy', troops);
      }),
    );
    const elapsed = Date.now() - t0;
    probe.stop();

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message);
    expect(ok.length, `dispatch failures: ${JSON.stringify(failures)}`).toBe(players.length);
    expect(probe.ticks).toBeGreaterThan(0);
    expect(probe.maxGapMs).toBeLessThan(LOOP_STALL_BUDGET_MS);
    // Concurrency, not serialization: these run against the same Mongo, so this is a loose ceiling —
    // it fails when dispatches queue behind one another's CPU, which is what the regression looks like.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});

/** True when a cell is ordinary ground a player may stand on or take — no city, choke or obstacle. */
function isPlainGround(index: MapTerrainIndex, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x >= SLG_MAP_W - 1 || y >= SLG_MAP_H - 1) return false;
  if (index.terrain[y * SLG_MAP_W + x] !== TERRAIN_PASSABLE) return false;
  const t = proceduralTile(W, x, y).type;
  return t !== 'center' && t !== 'familyKeep' && t !== 'stronghold' && t !== 'base';
}

/**
 * A capital anchor near (sx,sy) plus a legal occupy target for it.
 *
 * Two constraints that are easy to miss and both produced real failures while writing this: `joinWorld`
 * needs the WHOLE 3x3 capital footprint clear (ADR-025), not just the anchor; and the anchor's orthogonal
 * neighbours are all INSIDE that footprint, so the nearest cell that is actually occupiable — and still
 * borders owned land, satisfying ADR-039 — sits two cells out.
 */
function pickBaseAndTarget(
  index: MapTerrainIndex,
  sx: number,
  sy: number,
): { base: { x: number; y: number }; target: { x: number; y: number } } | null {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        let footprintOk = true;
        for (let fy = -1; fy <= 1 && footprintOk; fy++) {
          for (let fx = -1; fx <= 1; fx++) {
            if (!isPlainGround(index, x + fx, y + fy)) { footprintOk = false; break; }
          }
        }
        if (!footprintOk) continue;
        for (const [tx, ty] of [[x + 2, y], [x - 2, y], [x, y + 2], [x, y - 2]] as const) {
          if (isPlainGround(index, tx, ty)) return { base: { x, y }, target: { x: tx, y: ty } };
        }
      }
    }
  }
  return null;
}
