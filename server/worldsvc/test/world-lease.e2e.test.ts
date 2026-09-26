// Per-world scheduler leases (worldLease.ts, 2026-09-26, WORLDSVC_CONCURRENCY_AUDIT §12.7 phase 3 / §12.12).
//
// Two properties matter and both are pinned against a real Mongo: at any moment no two processes believe they
// hold the same world (otherwise the lease buys nothing), and every non-closed world ends up held by someone
// (otherwise its marches silently stop settling). The rest — handover on a clean stop, takeover after a crash,
// a stalled holder dropping what was taken from it — are the ways the second property could fail.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import { createWorldMongo, type MarchDoc, type WorldDoc, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { LEASE_TTL_MS, preferredHolder, WorldLeases, type SchedulerLeaseDoc } from '../src/worldLease';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_lease_test';
const T0 = 1_000_000;
const WORLDS = ['s1-1', 's1-2', 's1-3', 's1-4', 's1-5', 's1-6', 's1-7', 's1-8'];
const A = 'host-a:1:aaaaaa';
const B = 'host-b:1:cccccc'; // with A: 5/3 over WORLDS (the first-choice id gave A all eight, a 1-in-256 draw)

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.world-lease.e2e] Mongo unreachable (${URI}) — skipping.`);

function world(id: string, status: WorldDoc['status'] = 'active'): WorldDoc {
  return { _id: id, season: 1, shard: Number(id.split('-')[1]), status, mapW: SLG_MAP_W, mapH: SLG_MAP_H, openAt: 0, capacity: 500, population: 0, rev: 1 };
}

afterAll(async () => {
  if (!mongo) return;
  await mongo.db.dropDatabase();
  await mongo.close();
});

describe.skipIf(!mongo)('worldsvc per-world scheduler leases', () => {
  const m = mongo!;
  const leases = m.db.collection<SchedulerLeaseDoc>('schedulerLeases');
  let nowMs = T0;
  const make = (instanceId: string) => new WorldLeases({ leases, worlds: m.collections.worlds, instanceId, now: () => nowMs });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = T0;
    await m.collections.worlds.insertMany(WORLDS.map((id) => world(id)));
  });

  const expectPartition = (a: WorldLeases, b: WorldLeases) => {
    const [oa, ob] = [a.owned(), b.owned()];
    expect(oa.filter((w) => ob.includes(w))).toEqual([]);
    expect([...oa, ...ob].sort()).toEqual([...WORLDS].sort());
  };

  it('a lone process holds every world that is not closed', async () => {
    await m.collections.worlds.insertOne(world('s1-99', 'closed'));
    const a = make(A);
    await a.renew();
    expect(a.owned()).toEqual([...WORLDS].sort());
  });

  it('two processes converge on the rendezvous split, never both holding one world on the way', async () => {
    // The split is a pure function of the ids, so the test can say in advance who gets what — and must check
    // it is not the degenerate "one gets everything" that would make the rest of this test vacuous.
    const wantA = WORLDS.filter((w) => preferredHolder([A, B], w) === A).sort();
    const wantB = WORLDS.filter((w) => preferredHolder([A, B], w) === B).sort();
    expect(wantA.length).toBeGreaterThan(0);
    expect(wantB.length).toBeGreaterThan(0);

    const a = make(A);
    const b = make(B);
    await a.renew();
    expect(a.owned()).toEqual([...WORLDS].sort());

    // B joins: everything is still leased to A, so B takes nothing yet.
    await b.renew();
    expect(b.owned()).toEqual([]);
    // A sees B in the live list and lets go of B's share; B picks it up on its next round.
    nowMs += 5_000;
    await a.renew();
    expect(a.owned()).toEqual(wantA);
    expect(b.owned()).toEqual([]);
    await b.renew();
    expect(b.owned()).toEqual(wantB);
    expectPartition(a, b);

    // Steady state: further rounds move nothing.
    nowMs += 5_000;
    await a.renew();
    await b.renew();
    expect(a.owned()).toEqual(wantA);
    expect(b.owned()).toEqual(wantB);
  });

  it('a clean stop hands every world over on the survivor\'s next round', async () => {
    const a = make(A);
    const b = make(B);
    await a.renew();
    await b.renew();
    await a.renew();
    await b.renew();
    await a.stop();
    expect(a.owned()).toEqual([]);
    await b.renew();
    expect(b.owned()).toEqual([...WORLDS].sort());
  });

  it('a crashed process\'s worlds are taken over once its lease and presence expire, not before', async () => {
    const a = make(A);
    const b = make(B);
    await a.renew();
    await b.renew();
    await a.renew();
    await b.renew();
    const aHad = a.owned();
    // A dies here: no stop(), no more renewals.

    nowMs += LEASE_TTL_MS - 1_000;
    await b.renew();
    expect(b.owned().filter((w) => aHad.includes(w))).toEqual([]);

    nowMs += 2_000;
    await b.renew();
    expect(b.owned()).toEqual([...WORLDS].sort());

    // A's presence doc does not outlive it indefinitely (each restart is a new id, so these would pile up).
    nowMs += LEASE_TTL_MS + 1_000;
    await b.renew();
    expect(await leases.countDocuments({ kind: 'instance', holder: A })).toBe(0);
    expect(await leases.countDocuments({ kind: 'instance', holder: B })).toBe(1);
  });

  it('a holder that stalls past its expiry drops what was taken over meanwhile', async () => {
    const a = make(A);
    await a.renew();
    // A stalls (GC pause, partition) past its TTL; it already stops treating the leases as its own locally.
    nowMs += LEASE_TTL_MS + 1_000;
    expect(a.owned()).toEqual([]);
    const b = make(B);
    await b.renew();
    expect(b.owned()).toEqual([...WORLDS].sort());

    // A wakes up and renews: B's leases are live, so A must not count any of them as its own.
    await a.renew();
    expectPartition(a, b);
    expect(a.owned()).toEqual([]);
    // ...and the two then settle into the ordinary split.
    nowMs += 5_000;
    await b.renew();
    await a.renew();
    expectPartition(a, b);
  });
});

describe.skipIf(!mongo)('worldsvc scheduler scans scoped to held worlds', () => {
  const m = mongo!;
  const W1 = 's1-scope-a';
  const W2 = 's1-scope-b';
  const fakeMeta: WorldMetaClient = {
    available: true,
    async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
    async getProfile() { return null; },
    async grantMaterial() {},
    async grantTitle() {},
    batchProfiles: async () => new Map(),
  };
  const gateway: WorldGatewayClient = { available: true, async push() {}, async broadcast() {} };

  function returnLeg(worldId: string, ownerId: string): MarchDoc {
    return {
      _id: `r-${worldId}`, worldId, ownerId,
      fromTile: tileId(worldId, 105, 400), toTile: tileId(worldId, 100, 400),
      kind: 'return', troops: 10, army: [],
      departAt: T0 - 60_000, arriveAt: T0,
      status: 'marching', minX: 100, maxX: 105, minY: 400, maxY: 400, rev: 1,
    };
  }

  it('settles only the worlds it is given, and everything when given none', async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new WorldService({ cols: m.collections, redis: null, gateway, meta: fakeMeta, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => T0 });
    await svc.joinWorld(W1, 'p1');
    await svc.joinWorld(W2, 'p2');
    await m.collections.marches.insertMany([returnLeg(W1, 'p1'), returnLeg(W2, 'p2')]);

    expect(await svc.processDueArrivalSettlements(T0, 0, [W1])).toBe(1);
    expect(await m.collections.marches.countDocuments({ worldId: W1 })).toBe(0);
    expect(await m.collections.marches.countDocuments({ worldId: W2 })).toBe(1);

    expect(await svc.processDueArrivalSettlements(T0, 0)).toBe(1);
    expect(await m.collections.marches.countDocuments({})).toBe(0);
  });
});
