// Concurrent same-world settlement (2026-09-26, WORLDSVC_CONCURRENCY_AUDIT §12.7 phase 2 / §12.11).
//
// processDueArrivalSettlements lets settlements overlap only when their predicted write sets are disjoint from
// every other settlement of the pass (combatMarch/settlePlan.ts). These tests pin the two halves of that promise
// against a real Mongo: disjoint settlements really do overlap (it is not silently still serial), and colliding
// ones — here, one player's several return legs, which all write the same playerWorld — still run one at a time
// and all land (no lost update from two rev-guarded refunds racing each other into the retry cap).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { playerWorldId, SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import { createWorldMongo, type MarchDoc, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { worldCounters } from '../src/metrics';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_settle_concurrency_test';
const W = 's1-settle-conc';
const T0 = 1_000_000;

const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: async () => new Map(),
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
if (!mongo) console.warn(`[worldsvc.settle-concurrency.e2e] Mongo unreachable (${URI}) — skipping.`);

/** A legacy-model return leg (no stepping cursor) that is due at T0: settles as a pool refund to its owner. */
function returnLeg(id: string, ownerId: string, x: number, y: number, troops: number): MarchDoc {
  return {
    _id: id, worldId: W, ownerId,
    fromTile: tileId(W, x + 5, y), toTile: tileId(W, x, y),
    kind: 'return', troops, army: [],
    departAt: T0 - 60_000, arriveAt: T0,
    status: 'marching', minX: x, maxX: x + 5, minY: y, maxY: y, rev: 1,
  };
}

describe.skipIf(!mongo)('worldsvc concurrent settlement', () => {
  const m = mongo!;
  let nowMs = T0;
  let svc: WorldService;
  const gateway: WorldGatewayClient = { available: true, async push() {}, async broadcast() {} };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = T0;
    svc = new WorldService({
      cols: m.collections, redis: null, gateway, meta: fakeMeta,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Join `ids` and empty their troop pools, so a refund is visible as an exact number. */
  async function players(ids: string[]): Promise<void> {
    for (const id of ids) await svc.joinWorld(W, id);
    await m.collections.playerWorld.updateMany({ worldId: W }, { $set: { troops: 0, troopCap: 1_000_000 } });
  }
  const troopsOf = async (id: string) => (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, id) }))!.troops;

  /** Track how many settlements are between their claim and the end of their refund at the same time. */
  function trackOverlap(): { max: () => number; restore: () => void } {
    const cols = m.collections;
    const realClaim = cols.marches.findOneAndDelete.bind(cols.marches);
    const realUpdate = cols.playerWorld.updateOne.bind(cols.playerWorld);
    let live = 0;
    let max = 0;
    cols.marches.findOneAndDelete = (async (...args: Parameters<typeof realClaim>) => {
      const r = await realClaim(...args);
      if (r) max = Math.max(max, ++live);
      return r;
    }) as typeof realClaim;
    cols.playerWorld.updateOne = (async (...args: Parameters<typeof realUpdate>) => {
      const r = await realUpdate(...args);
      live--;
      return r;
    }) as typeof realUpdate;
    return {
      max: () => max,
      restore: () => {
        cols.marches.findOneAndDelete = realClaim as typeof cols.marches.findOneAndDelete;
        cols.playerWorld.updateOne = realUpdate as typeof cols.playerWorld.updateOne;
      },
    };
  }

  it('settles disjoint settlements concurrently, each exactly once', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    await players(ids);
    await m.collections.marches.insertMany(ids.map((id, i) => returnLeg(`r-${id}`, id, 100 + i * 20, 400, 10 + i)));

    const before = worldCounters()['arrivals.concurrent'] ?? 0;
    const overlap = trackOverlap();
    try {
      expect(await svc.processDueArrivalSettlements(nowMs, 0)).toBe(ids.length);
    } finally {
      overlap.restore();
    }

    expect((worldCounters()['arrivals.concurrent'] ?? 0) - before).toBe(ids.length);
    expect(overlap.max()).toBeGreaterThan(1);
    for (const [i, id] of ids.entries()) expect(await troopsOf(id)).toBe(10 + i);
    expect(await m.collections.marches.countDocuments({ worldId: W })).toBe(0);
  });

  it('keeps one player\'s several settlements serial, and every one of them lands', async () => {
    await players(['solo', 'other']);
    await m.collections.marches.insertMany([
      returnLeg('s1', 'solo', 100, 500, 10),
      returnLeg('s2', 'solo', 140, 500, 20),
      returnLeg('s3', 'solo', 180, 500, 30),
      returnLeg('o1', 'other', 300, 500, 7),
    ]);

    const before = worldCounters()['arrivals.concurrent'] ?? 0;
    expect(await svc.processDueArrivalSettlements(nowMs, 0)).toBe(4);

    // Only the other player's leg was cleared to overlap; the three sharing `a:solo` ran as barriers.
    expect((worldCounters()['arrivals.concurrent'] ?? 0) - before).toBe(1);
    expect(await troopsOf('solo')).toBe(60);
    expect(await troopsOf('other')).toBe(7);
  });

  it('serialises two players landing on neighbouring cells (shared 3×3)', async () => {
    await players(['n1', 'n2']);
    await m.collections.marches.insertMany([
      returnLeg('n1', 'n1', 600, 600, 5),
      returnLeg('n2', 'n2', 601, 601, 6),
    ]);

    const before = worldCounters()['arrivals.concurrent'] ?? 0;
    expect(await svc.processDueArrivalSettlements(nowMs, 0)).toBe(2);
    expect((worldCounters()['arrivals.concurrent'] ?? 0) - before).toBe(0);
    expect(await troopsOf('n1')).toBe(5);
    expect(await troopsOf('n2')).toBe(6);
  });
});
