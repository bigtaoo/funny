// Stepping claim (MarchDoc.stepLeaseUntil, 2026-09-26, WORLDSVC_CONCURRENCY_AUDIT §12.7 phase 1).
//
// A step can fight, and a fight writes the defender's ledger, so two processors must never walk the same
// march. Both walkers honour the claim: advanceMarch (the per-march path) takes it with a conditional
// update and releases it with its cursor write, and applyFastSteps (the batched path) refuses a march that
// is held. A claim left behind by a crashed holder must lapse on its own.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { marchStepArriveAt, MARCH_SPEED_SEC_PER_TILE, SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import { createWorldMongo, type MarchDoc, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { MARCH_STEP_LEASE_MS } from '../src/combatMarch/arrivalWalk';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_step_lease_test';
const W = 's1-lease';
const DEPART = 1_000_000;
const STEP_MS = MARCH_SPEED_SEC_PER_TILE * 1000;

const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: async () => new Map(),
};

/** Per-field occupancy hash only (the fallback surface in core/push.ts). */
function memRedis(): WorldRedis {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (k: string) => { let h = hashes.get(k); if (!h) { h = new Map(); hashes.set(k, h); } return h; };
  return {
    async publish() { return 0; },
    async hset(k, f, v) { hash(k).set(f, v); return 1; },
    async hget(k, f) { return hashes.get(k)?.get(f) ?? null; },
    async hdel(k, ...fs) { for (const f of fs) hashes.get(k)?.delete(f); return 1; },
    async quit() { return 'OK'; },
  };
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
if (!mongo) console.warn(`[worldsvc.step-lease.e2e] Mongo unreachable (${URI}) — skipping.`);

function steppingMarch(id: string, ownerId: string, y: number, extra: Partial<MarchDoc> = {}): MarchDoc {
  const len = 8;
  const path = Array.from({ length: len }, (_, i) => ({ x: 100 + i, y }));
  return {
    _id: id, worldId: W, ownerId,
    fromTile: tileId(W, 100, y), toTile: tileId(W, 100 + len - 1, y),
    kind: 'move', teamId: 't1', troops: 500, army: [],
    departAt: DEPART, arriveAt: marchStepArriveAt(DEPART, len - 1),
    path, stepIndex: 0, nextStepAt: marchStepArriveAt(DEPART, 1),
    status: 'marching', minX: 100, maxX: 100 + len - 1, minY: y, maxY: y, rev: 1,
    ...extra,
  };
}

describe.skipIf(!mongo)('worldsvc march stepping claim', () => {
  const m = mongo!;
  let nowMs = DEPART;
  let svc: WorldService;
  const gateway: WorldGatewayClient = { available: true, async push() {}, async broadcast() {} };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = DEPART;
    svc = new WorldService({
      cols: m.collections, redis: memRedis(), gateway, meta: fakeMeta,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  const doc = async (id: string) => (await m.collections.marches.findOne({ _id: id }))!;

  // No world doc → advanceMarch's per-march path (the batch never takes a player it cannot resolve).
  it('per-march path: steps an unclaimed march and leaves no claim behind', async () => {
    await m.collections.marches.insertOne(steppingMarch('free', 'nobody', 900));
    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();
    const d = await doc('free');
    expect(d.stepIndex).toBe(1);
    expect(d.stepLeaseUntil).toBeUndefined();
  });

  it('per-march path: leaves a march alone while another processor holds it', async () => {
    const heldUntil = DEPART + STEP_MS + 10_000;
    await m.collections.marches.insertOne(steppingMarch('held', 'nobody', 900, { stepLeaseUntil: heldUntil }));
    nowMs = DEPART + STEP_MS;
    await svc.processDueArrivals();
    const d = await doc('held');
    expect(d.stepIndex).toBe(0);
    expect(d.stepLeaseUntil).toBe(heldUntil); // not stolen, not cleared
  });

  it('per-march path: takes over a claim that has lapsed (crashed holder)', async () => {
    nowMs = DEPART + STEP_MS;
    await m.collections.marches.insertOne(steppingMarch('stale', 'nobody', 900, { stepLeaseUntil: nowMs - 1 }));
    await svc.processDueArrivals();
    const d = await doc('stale');
    expect(d.stepIndex).toBe(1);
    expect(d.stepLeaseUntil).toBeUndefined();
  });

  it('batched path: refuses a held march and steps a free one', async () => {
    await svc.joinWorld(W, 'pa', 100, 300);
    await svc.joinWorld(W, 'pb', 100, 310);
    nowMs = DEPART + STEP_MS;
    await m.collections.marches.insertMany([
      steppingMarch('batch-held', 'pa', 300, { stepLeaseUntil: nowMs + MARCH_STEP_LEASE_MS }),
      steppingMarch('batch-free', 'pb', 310),
    ]);
    await svc.processDueArrivals();
    expect((await doc('batch-held')).stepIndex).toBe(0);
    expect((await doc('batch-free')).stepIndex).toBe(1);
  });
});
