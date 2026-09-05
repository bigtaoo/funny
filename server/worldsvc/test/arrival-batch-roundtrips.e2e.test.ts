// worldsvc arrival-tick round-trip gate (2026-09-05, `sched:arrivals` deep batching).
//
// This is the regression test for the change, and it asserts a COST, not a behaviour: settling N uneventful
// mid-route marches must take a constant number of database round trips, not a number that grows with N.
// The 200-bot load test measured the old per-march loop at p50 1761ms / p90 6705ms against a 2000ms interval
// (WORLDSVC_CONCURRENCY_AUDIT §5.4) purely because every march cost ~7 serial round trips of its own; a
// refactor that quietly puts one back is invisible in every functional test in this directory and shows up
// in production only as "arrivals are late again".
//
// So the assertions are exact call counts against a counting Mongo proxy and a counting fake Redis, plus the
// resulting occupancy state — the batched writer has to be both cheap AND produce what the per-march writer
// produced. The complementary direction (which marches are ALLOWED into the batch) is unit-tested in
// arrival-batch-split.test.ts; here we check that the ones that are not allowed still take the old path, by
// planting a defender and watching the march fight it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MARCH_SPEED_SEC_PER_TILE, marchStepArriveAt, playerWorldId, SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import { createWorldMongo, type MarchDoc, type WorldCollections, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { SlgPushMsg, WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_arrival_batch_test';
const W = 's1-abatch';
const DEPART = 1_000_000;
const STEP_MS = MARCH_SPEED_SEC_PER_TILE * 1000;
/** Enough marches that a per-march regression is unmistakable against the constant-cost budgets below. */
const FLEET = 12;

const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
};

/**
 * Fake Redis that implements the BATCHED hash commands as well as the per-field ones, and counts every
 * command. The other occupancy e2e fakes deliberately implement only hset/hget/hdel (exercising the fallback
 * path in core/push.ts); this one is the opposite case — it is here to prove the batched commands are the
 * ones actually issued.
 */
class CountingRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  readonly calls = new Map<string, number>();
  private bump(cmd: string): void { this.calls.set(cmd, (this.calls.get(cmd) ?? 0) + 1); }
  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    return h;
  }
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> { this.bump('hset'); this.hash(key).set(field, value); return 1; }
  async hget(key: string, field: string): Promise<string | null> { this.bump('hget'); return this.hashes.get(key)?.get(field) ?? null; }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    this.bump('hdel');
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    this.bump('hmget');
    const h = this.hashes.get(key);
    return fields.map((f) => h?.get(f) ?? null);
  }
  async hsetMany(key: string, pairs: string[]): Promise<unknown> {
    this.bump('hsetMany');
    const h = this.hash(key);
    for (let i = 0; i < pairs.length; i += 2) h.set(pairs[i]!, pairs[i + 1]!);
    return 1;
  }
  async hdelJsonIdMatch(key: string, fields: string[], ids: string[]): Promise<unknown> {
    this.bump('hdelJsonIdMatch');
    const h = this.hashes.get(key);
    if (!h) return 1;
    fields.forEach((f, i) => {
      const cur = h.get(f);
      if (!cur) return;
      if ((JSON.parse(cur) as { id: string }).id === ids[i]) h.delete(f);
    });
    return 1;
  }
  async hmergeJsonField(key: string, field: string, entryKey: string, entryJson: string | null): Promise<unknown> {
    this.bump('hmergeJsonField');
    const h = this.hash(key);
    const map = JSON.parse(h.get(field) ?? '{}') as Record<string, unknown>;
    if (entryJson === null) delete map[entryKey];
    else map[entryKey] = JSON.parse(entryJson);
    if (Object.keys(map).length === 0) h.delete(field);
    else h.set(field, JSON.stringify(map));
    return 1;
  }
  async quit(): Promise<unknown> { return 'OK'; }

  total(): number { return [...this.calls.values()].reduce((a, b) => a + b, 0); }
  reset(): void { this.calls.clear(); }
  occAt(worldId: string, tid: string): { id: string; ownerId: string; tile: string; leaveAt: number } | null {
    const raw = this.hashes.get(`world:${worldId}:occ`)?.get(tid);
    return raw ? JSON.parse(raw) : null;
  }
  occSize(worldId: string): number { return this.hashes.get(`world:${worldId}:occ`)?.size ?? 0; }
}

/** Wrap every collection so each method call is tallied as `<collection>.<method>`. */
function countingCols(cols: WorldCollections, tally: Map<string, number>): WorldCollections {
  return new Proxy(cols as unknown as Record<string, object>, {
    get(target, colName: string) {
      const col = target[colName];
      if (!col) return col;
      return new Proxy(col, {
        get(c, method: string) {
          const v = (c as unknown as Record<string, unknown>)[method];
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            const key = `${colName}.${method}`;
            tally.set(key, (tally.get(key) ?? 0) + 1);
            return (v as (...a: unknown[]) => unknown).apply(c, args);
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
if (!mongo) console.warn(`[worldsvc.arrival-batch.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * A stepping march walking east along its own row, inserted straight into Mongo. Dispatching through
 * startMarch would drag in territory connectivity, troop economy and pathfinding — none of which this test
 * is about, and all of which make it hard to place a whole fleet at chosen coordinates.
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

describe.skipIf(!mongo)('worldsvc arrival tick: round-trip cost (`sched:arrivals` batching)', () => {
  const m = mongo!;
  let nowMs = DEPART;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: CountingRedis;
  let tally: Map<string, number>;
  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(_a: string, _msg: SlgPushMsg) {},
    broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = DEPART;
    redis = new CountingRedis();
    tally = new Map();
    svc = new WorldService({
      cols: countingCols(m.collections, tally),
      redis,
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

  /** `FLEET` players, each with one march on its own row so no two can ever touch the same cell. */
  async function launchFleet(): Promise<MarchDoc[]> {
    const marches: MarchDoc[] = [];
    for (let i = 0; i < FLEET; i++) {
      const y = 200 + i * 3;
      await svc.joinWorld(W, `p${i}`, 100, y);
      marches.push(steppingMarch(`mm${i}`, `p${i}`, 100, y, 8));
    }
    await m.collections.marches.insertMany(marches);
    return marches;
  }

  it('settles a whole fleet of uneventful steps in a constant number of round trips', async () => {
    const marches = await launchFleet();
    redis.reset();
    tally.clear();

    nowMs = DEPART + STEP_MS;
    expect(await svc.processDueArrivals()).toBe(0); // all mid-route: nothing settled

    // ── Mongo: one due scan, one projected playerWorld read, one bulkWrite. No per-march anything. ──
    expect(tally.get('marches.find') ?? 0).toBe(1);
    expect(tally.get('marches.bulkWrite') ?? 0).toBe(1);
    expect(tally.get('marches.updateOne') ?? 0).toBe(0);
    expect(tally.get('marches.findOne') ?? 0).toBe(0);
    expect(tally.get('playerWorld.find') ?? 0).toBe(1);
    expect(tally.get('playerWorld.findOne') ?? 0).toBe(0);

    // ── Redis: one HMGET for occupancy, one for coverage, one guarded batch clear, one batch set. ──
    expect(redis.calls.get('hmget') ?? 0).toBe(2);
    expect(redis.calls.get('hdelJsonIdMatch') ?? 0).toBe(1);
    expect(redis.calls.get('hsetMany') ?? 0).toBe(1);
    expect(redis.calls.get('hget') ?? 0).toBe(0);
    expect(redis.calls.get('hset') ?? 0).toBe(0);
    // The budget that actually holds the line: constant, and far below one round trip per march.
    expect(redis.total()).toBeLessThan(FLEET);

    // ── And the state is what the per-march writer would have produced. ──
    for (const mm of marches) {
      const doc = (await m.collections.marches.findOne({ _id: mm._id }))!;
      expect(doc.stepIndex).toBe(1);
      expect(doc.nextStepAt).toBe(marchStepArriveAt(DEPART, 2));
      const cell = mm.path![1]!;
      const occ = redis.occAt(W, tileId(W, cell.x, cell.y))!;
      expect(occ.id).toBe(mm._id);
      expect(occ.ownerId).toBe(mm.ownerId);
      expect(occ.leaveAt).toBe(marchStepArriveAt(DEPART, 2));
    }
    expect(redis.occSize(W)).toBe(FLEET);
  });

  it('holds that budget when the marches jump several cells at once', async () => {
    const marches = await launchFleet();
    redis.reset();
    tally.clear();

    // A tick that fell behind: every march owes three steps. The old loop paid four Redis round trips per
    // STEP; the batch collapses the intermediate cells it provably never has to publish.
    nowMs = DEPART + 3 * STEP_MS;
    expect(await svc.processDueArrivals()).toBe(0);
    expect(redis.total()).toBeLessThan(FLEET);
    expect(tally.get('marches.bulkWrite') ?? 0).toBe(1);

    for (const mm of marches) {
      expect((await m.collections.marches.findOne({ _id: mm._id }))!.stepIndex).toBe(3);
      // Only the cell it now stands on is registered — the two it passed through are not left behind.
      expect(redis.occAt(W, tileId(W, mm.path![3]!.x, mm.path![3]!.y))!.id).toBe(mm._id);
      expect(redis.occAt(W, tileId(W, mm.path![1]!.x, mm.path![1]!.y))).toBeNull();
      expect(redis.occAt(W, tileId(W, mm.path![2]!.x, mm.path![2]!.y))).toBeNull();
    }
    expect(redis.occSize(W)).toBe(FLEET);
  });

  it('a march stepping onto an occupied cell keeps the per-march path, and fights', async () => {
    const marches = await launchFleet();
    // Park an enemy team on the cell march 0 is about to enter.
    const victim = marches[0]!;
    const contested = victim.path![1]!;
    const tid = tileId(W, contested.x, contested.y);
    await svc.joinWorld(W, 'enemy', 400, 400);
    await m.collections.stationed.insertOne({
      _id: tid, worldId: W, ownerId: 'enemy', tile: tid, x: contested.x, y: contested.y,
      teamId: 't1', army: [], troops: 50, sinceAt: DEPART, mode: 'idle',
    });
    await redis.hset(`world:${W}:occ`, tid, JSON.stringify({
      kind: 'stationed', id: tid, ownerId: 'enemy', teamId: 't1', tile: tid, leaveAt: Number.MAX_SAFE_INTEGER,
    }));
    redis.reset();
    tally.clear();

    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();

    // The contested march took the serial path: it re-read its own doc and its full playerWorld, which is
    // exactly what the batch skips. Its 11 siblings did not.
    expect(tally.get('marches.findOne') ?? 0).toBe(1);
    expect(tally.get('playerWorld.findOne') ?? 0).toBeGreaterThanOrEqual(1);
    expect(tally.get('marches.bulkWrite') ?? 0).toBe(1); // the other 11 still went as one batch

    // ...and the encounter really happened: a much smaller defender is wiped and the cell changes hands.
    expect(await m.collections.stationed.findOne({ _id: tid })).toBeNull();
    expect(await m.collections.sieges.countDocuments({ tile: tid })).toBe(1);
    expect(redis.occAt(W, tid)!.id).toBe(victim._id);
  });

  it('does not move a march that was recalled between the due scan and the batched write', async () => {
    const marches = await launchFleet();
    const recalled = marches[0]!;
    // Simulate the recall landing inside the tick: flip the doc to a return leg the way recallMarch does,
    // after the scan has already snapshotted it. The batch's cursor update is guarded on exactly this.
    const realFind = m.collections.marches.find.bind(m.collections.marches);
    let flipped = false;
    m.collections.marches.find = ((...args: Parameters<typeof realFind>) => {
      const cursor = realFind(...args);
      const realToArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const docs = await realToArray();
        if (!flipped) {
          flipped = true;
          await m.collections.marches.updateOne(
            { _id: recalled._id },
            { $set: { kind: 'return', status: 'marching' }, $unset: { path: '', stepIndex: '', nextStepAt: '' } },
          );
        }
        return docs;
      };
      return cursor;
    }) as typeof realFind;

    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();
    m.collections.marches.find = realFind;

    // The recalled march kept no stepping cursor and was given no occupancy entry — the leak the per-march
    // path's re-read exists to prevent, closed here by the guarded bulkWrite + the follow-up confirm query.
    const doc = (await m.collections.marches.findOne({ _id: recalled._id }))!;
    expect(doc.stepIndex).toBeUndefined();
    expect(redis.occAt(W, tileId(W, recalled.path![1]!.x, recalled.path![1]!.y))).toBeNull();
    // Its siblings are unaffected.
    expect(redis.occSize(W)).toBe(FLEET - 1);
  });

  it('still works against a Redis that only speaks the per-field commands', async () => {
    // core/push.ts falls back for clients without the batched commands (every other fake in this directory).
    // The fallback must produce identical state — it is the deployed behaviour until Redis is upgraded.
    const plain = new CountingRedis();
    // A literal exposing only the per-field surface: the batched methods live on CountingRedis's prototype,
    // so `delete` would not hide them.
    const legacyRedis: WorldRedis = {
      publish: () => plain.publish(),
      hset: (...a) => plain.hset(...a),
      hget: (...a) => plain.hget(...a),
      hdel: (...a) => plain.hdel(...a),
      quit: () => plain.quit(),
    };
    svc = new WorldService({
      cols: m.collections, redis: legacyRedis, gateway: fakeGateway, meta: fakeMeta,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });
    const marches = await launchFleet();

    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();

    expect(plain.calls.get('hmget') ?? 0).toBe(0);
    expect(plain.occSize(W)).toBe(FLEET);
    for (const mm of marches) {
      expect(plain.occAt(W, tileId(W, mm.path![1]!.x, mm.path![1]!.y))!.id).toBe(mm._id);
    }
  });

  it('reports the batched/serial split so a silent demotion is visible', async () => {
    const { worldMetricsSnapshot } = await import('../src/metrics');
    await launchFleet();
    const before = worldMetricsSnapshot().counters['arrivals.batched'] ?? 0;
    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();
    expect((worldMetricsSnapshot().counters['arrivals.batched'] ?? 0) - before).toBe(FLEET);
  });

  it('leaves a player with no world doc on the per-march path', async () => {
    const orphan = steppingMarch('orphan', 'nobody', 100, 900, 8);
    await m.collections.marches.insertOne(orphan);
    tally.clear();
    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();
    // advanceMarch's own `if (pw)` handling applies — including its re-read of the march doc.
    expect(tally.get('marches.findOne') ?? 0).toBe(1);
    expect(tally.get('marches.bulkWrite') ?? 0).toBe(0);
    expect((await m.collections.marches.findOne({ _id: 'orphan' }))!.stepIndex).toBe(1);
  });

  it('leaves an arriving march on the per-march path', async () => {
    await svc.joinWorld(W, 'arrive', 100, 700);
    const short = steppingMarch('short', 'arrive', 100, 700, 2); // one step from its destination
    await m.collections.marches.insertOne(short);
    tally.clear();
    nowMs = DEPART + STEP_MS;
    expect(await svc.processDueArrivals()).toBe(1); // settled, so it was counted
    expect(tally.get('marches.bulkWrite') ?? 0).toBe(0);
    expect(await m.collections.marches.findOne({ _id: 'short' })).toBeNull();
  });
});
