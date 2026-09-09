// worldsvc arrival SETTLEMENT half (2026-09-09, WORLDSVC_CONCURRENCY_AUDIT §6.7 item 1).
//
// The 2026-09-05 batching fixed the walking half (p50 1761ms → ~2ms) and its own counters named what was
// left: in a 32s storm, 1071 of 1797 serial marches were `arriving`. Each of those is a real capture battle
// plus a metaserver round trip — unbatchable (it writes the DEFENDER's ledger) and, for the same reason,
// not safe to run concurrently. So a tick with dozens of them due simply ran for seconds, and while it ran
// nothing else on this single thread moved.
//
// The fix is not to make that work cheaper — it cannot be, and NOTHING here claims a throughput win. It is
// to stop one burst of it from owning the thread: settlements are their own scheduler task, ordered
// oldest-arrival-first, and bounded by a wall-clock slice that leaves the remainder for the next pass.
//
// What that makes testable, and what this file pins:
//   1. the slice actually stops the pass, and the remainder is untouched and still due (deferral needs no
//      state of its own — that is the property that makes it safe);
//   2. the queue drains across passes, in arrival order, with nothing lost;
//   3. the two halves are DISJOINT — the walking pass never settles, the settling pass never picks up a
//      mid-route march. Overlap is the one way this split goes quietly wrong, and it would look like
//      "occasional double work" rather than like a failure.
//
// The slice is driven by passing `sliceMs` rather than by faking a clock: a settlement does real async I/O,
// so a microscopic slice deterministically admits exactly one march per pass, and `sliceMs: 0` (the
// pre-split behaviour) admits all of them. No timer faking around live Mongo.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MARCH_SPEED_SEC_PER_TILE, marchStepArriveAt, SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import { createWorldMongo, type MarchDoc, type WorldCollections, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { SlgPushMsg, WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_arrival_slice_test';
const W = 's1-aslice';
const DEPART = 1_000_000;
const STEP_MS = MARCH_SPEED_SEC_PER_TILE * 1000;
/** Small enough to keep the e2e quick, big enough that "one per pass" is unmistakable. */
const FLEET = 5;
/** Any positive slice smaller than the cost of one real settlement — i.e. "let exactly one through". */
const ONE_AT_A_TIME_MS = 0.000_001;

const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
};

/** In-memory hash store covering the occupancy/coverage commands the arrival paths use. */
class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    return h;
  }
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> { this.hash(key).set(field, value); return 1; }
  async hget(key: string, field: string): Promise<string | null> { return this.hashes.get(key)?.get(field) ?? null; }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    const h = this.hashes.get(key);
    return fields.map((f) => h?.get(f) ?? null);
  }
  async hsetMany(key: string, pairs: string[]): Promise<unknown> {
    const h = this.hash(key);
    for (let i = 0; i < pairs.length; i += 2) h.set(pairs[i]!, pairs[i + 1]!);
    return 1;
  }
  async hdelJsonIdMatch(key: string, fields: string[], ids: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 1;
    fields.forEach((f, i) => {
      const cur = h.get(f);
      if (cur && (JSON.parse(cur) as { id: string }).id === ids[i]) h.delete(f);
    });
    return 1;
  }
  async hmergeJsonField(key: string, field: string, entryKey: string, entryJson: string | null): Promise<unknown> {
    const h = this.hash(key);
    const map = JSON.parse(h.get(field) ?? '{}') as Record<string, unknown>;
    if (entryJson === null) delete map[entryKey];
    else map[entryKey] = JSON.parse(entryJson);
    if (Object.keys(map).length === 0) h.delete(field);
    else h.set(field, JSON.stringify(map));
    return 1;
  }
  async quit(): Promise<unknown> { return 'OK'; }
}

/**
 * Wrap `cols` so every `marches.find(...).sort(spec)` records its spec.
 *
 * Needed because the behavioural half of the ordering test cannot fail on its own: the settlement query
 * filters on `arriveAt`, so Mongo picks the `{arriveAt: 1}` index and hands the documents back in exactly
 * the order the sort asks for — deleting the `.sort()` from production code leaves every observable
 * assertion green. That does NOT make the sort decoration: it is the difference between a guarantee and a
 * planner coincidence, and the day the planner prefers another index (a compound one, a different filter)
 * the fairness property disappears silently. So the ORDER is asserted through behaviour, and the fact that
 * the order was actually REQUESTED is asserted here.
 */
function sortSpyCols(cols: WorldCollections, sorts: unknown[]): WorldCollections {
  return new Proxy(cols as unknown as Record<string, object>, {
    get(target, colName: string) {
      const col = target[colName];
      if (colName !== 'marches' || !col) return col;
      return new Proxy(col, {
        get(c, method: string) {
          const v = (c as unknown as Record<string, unknown>)[method];
          if (method !== 'find' || typeof v !== 'function') return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
          return (...args: unknown[]) => {
            const cursor = (v as (...a: unknown[]) => Record<string, unknown>).apply(c, args);
            return new Proxy(cursor, {
              get(cur, m: string) {
                const f = (cur as Record<string, unknown>)[m];
                if (typeof f !== 'function') return f;
                return (...a: unknown[]) => {
                  if (m === 'sort') sorts.push(a[0]);
                  return (f as (...x: unknown[]) => unknown).apply(cur, a);
                };
              },
            });
          };
        },
      });
    },
  }) as unknown as WorldCollections;
}

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.arrival-slice.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * A stepping march walking east along its own row, inserted straight into Mongo (same shortcut as
 * arrival-batch-roundtrips.e2e.test.ts: dispatching through startMarch would drag in connectivity, troop
 * economy and pathfinding, none of which this file is about). `len` decides when it arrives — which is
 * what the ordering test varies.
 */
function steppingMarch(id: string, ownerId: string, x0: number, y: number, len: number): MarchDoc {
  const path = Array.from({ length: len }, (_, i) => ({ x: x0 + i, y }));
  return {
    _id: id,
    worldId: W,
    ownerId,
    fromTile: tileId(W, x0, y),
    toTile: tileId(W, x0 + len - 1, y),
    kind: 'move',
    teamId: 't1',
    troops: 500,
    army: [],
    departAt: DEPART,
    arriveAt: marchStepArriveAt(DEPART, len - 1),
    path,
    stepIndex: 0,
    nextStepAt: marchStepArriveAt(DEPART, 1),
    status: 'marching',
    minX: x0, maxX: x0 + len - 1, minY: y, maxY: y,
    rev: 1,
  };
}

describe.skipIf(!mongo)('worldsvc arrival settlement: time slice and queue order', () => {
  const m = mongo!;
  let nowMs = DEPART;
  const now = () => nowMs;
  let svc: WorldService;
  let sorts: unknown[];
  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(_a: string, _msg: SlgPushMsg) {},
    broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = DEPART;
    sorts = [];
    svc = new WorldService({
      cols: sortSpyCols(m.collections, sorts),
      redis: new FakeRedis(),
      gateway: fakeGateway,
      meta: fakeMeta,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** `FLEET` one-step marches, each on its own row, all arriving at the same instant. */
  async function launchArrivingFleet(): Promise<MarchDoc[]> {
    const marches: MarchDoc[] = [];
    for (let i = 0; i < FLEET; i++) {
      const y = 200 + i * 3;
      await svc.joinWorld(W, `p${i}`, 100, y);
      marches.push(steppingMarch(`ms${i}`, `p${i}`, 100, y, 2));
    }
    await m.collections.marches.insertMany(marches);
    return marches;
  }

  const stillMarching = () => m.collections.marches.countDocuments({ status: 'marching' });

  it('settles everything due when the slice is off — the pre-split behaviour, still available', async () => {
    await launchArrivingFleet();
    nowMs = DEPART + STEP_MS;
    expect(await svc.processDueArrivalSettlements(nowMs, 0)).toBe(FLEET);
    expect(await stillMarching()).toBe(0);
  });

  it('a slice narrower than one settlement lets exactly one through, and leaves the rest ALONE', async () => {
    const marches = await launchArrivingFleet();
    nowMs = DEPART + STEP_MS;
    const before = await m.collections.marches.find({}).toArray();

    expect(await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS)).toBe(1);
    expect(await stillMarching()).toBe(FLEET - 1);

    // "Left alone" is the load-bearing half: a deferred march carries no marker, no lease, no rescheduled
    // time. It is simply still due, so the next pass finds it by the same query — which is why a crash
    // between passes loses nothing and why deferral needs no state of its own.
    const after = await m.collections.marches.find({}).toArray();
    const byId = new Map(after.map((d) => [d._id, d]));
    for (const b of before.slice(1)) {
      const a = byId.get(b._id);
      if (!a) continue; // the one that settled
      expect(a).toEqual(b);
    }
    expect(marches.length).toBe(FLEET);
  });

  it('drains the queue across passes, one per pass, losing nothing', async () => {
    await launchArrivingFleet();
    nowMs = DEPART + STEP_MS;
    let total = 0;
    for (let i = 0; i < FLEET; i++) {
      total += await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS);
      expect(await stillMarching()).toBe(FLEET - (i + 1));
    }
    expect(total).toBe(FLEET);
    // And a pass over an empty queue is a no-op rather than an error.
    expect(await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS)).toBe(0);
  });

  it('settles the oldest arrival first, so a cut-short pass cannot starve anyone', async () => {
    // Three marches with genuinely different arrival times, inserted newest-first so insertion order and
    // arrival order disagree — otherwise a natural-order scan would pass this test by accident.
    for (const [i, len] of [4, 3, 2].entries()) {
      await svc.joinWorld(W, `q${i}`, 300, 300 + i * 3);
      await m.collections.marches.insertOne(steppingMarch(`mq${len}`, `q${i}`, 300, 300 + i * 3, len));
    }
    nowMs = DEPART + 10 * STEP_MS; // all three are past their arrival

    await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS);
    // len 2 arrives at DEPART+1 step, len 3 at +2, len 4 at +3 — so the len-2 march is the oldest.
    expect(await m.collections.marches.findOne({ _id: 'mq2' })).toBeNull();
    expect(await m.collections.marches.findOne({ _id: 'mq3' })).not.toBeNull();
    expect(await m.collections.marches.findOne({ _id: 'mq4' })).not.toBeNull();

    await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS);
    expect(await m.collections.marches.findOne({ _id: 'mq3' })).toBeNull();
    expect(await m.collections.marches.findOne({ _id: 'mq4' })).not.toBeNull();

    // ...and the order was ASKED for, not inherited from whichever index the planner happened to pick.
    // See sortSpyCols: with the sort deleted these two passes still settle in the same order today,
    // because the filter is on `arriveAt` and Mongo walks that index. This is the only assertion in the
    // file that goes red for that edit.
    expect(sorts.length).toBeGreaterThan(0);
    for (const spec of sorts) expect(spec).toEqual({ arriveAt: 1 });
  });

  it('reports the backlog it left behind', async () => {
    const { worldMetricsSnapshot } = await import('../src/metrics');
    const read = () => worldMetricsSnapshot().counters;
    const delta = (a: Record<string, number>, b: Record<string, number>, k: string) => (b[k] ?? 0) - (a[k] ?? 0);

    await launchArrivingFleet();
    nowMs = DEPART + STEP_MS;
    const before = read();
    await svc.processDueArrivalSettlements(nowMs, ONE_AT_A_TIME_MS);
    const after = read();

    // Under an ordinary load `deferred` is always 0; a value that keeps climbing is the honest statement
    // that settlement throughput is the ceiling — which no latency number says out loud, because a backlog
    // and a slow tick look identical from outside.
    expect(delta(before, after, 'arrivals.settled')).toBe(1);
    expect(delta(before, after, 'arrivals.deferred')).toBe(FLEET - 1);
  });

  // ── the disjointness of the two halves ────────────────────────────────────────────────────────────────
  it('the walking half never settles, and the settling half never walks a mid-route march', async () => {
    await launchArrivingFleet();                       // FLEET marches arriving at DEPART + 1 step
    await svc.joinWorld(W, 'walker', 500, 500);
    await m.collections.marches.insertOne(steppingMarch('walker1', 'walker', 500, 500, 8)); // still walking
    nowMs = DEPART + STEP_MS;

    // Walking pass: advances the walker and does not touch the arrivals.
    expect(await svc.processDueArrivalSteps(nowMs)).toBe(0);
    expect(await stillMarching()).toBe(FLEET + 1);
    expect((await m.collections.marches.findOne({ _id: 'walker1' }))!.stepIndex).toBe(1);

    // Settling pass: takes every arrival and leaves the walker exactly where the walking pass put it.
    expect(await svc.processDueArrivalSettlements(nowMs, 0)).toBe(FLEET);
    const walker = (await m.collections.marches.findOne({ _id: 'walker1' }))!;
    expect(walker.stepIndex).toBe(1);
    expect(await stillMarching()).toBe(1);
  });

  it('processDueArrivals still leaves the world settled in one call, for callers that own the clock', async () => {
    // Tests and admin tools jump `now` past a march's arriveAt and expect one call to be enough. The
    // scheduler no longer uses this entry point, so nothing else would notice if it started honouring the
    // slice — and every fixture in this directory would start failing intermittently instead of loudly.
    await launchArrivingFleet();
    await svc.joinWorld(W, 'far', 500, 500);
    await m.collections.marches.insertOne(steppingMarch('far1', 'far', 500, 500, 6));
    nowMs = DEPART + 10 * STEP_MS;

    expect(await svc.processDueArrivals()).toBe(FLEET + 1);
    expect(await stillMarching()).toBe(0);
  });
});
