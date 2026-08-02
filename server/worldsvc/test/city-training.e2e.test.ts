// worldsvc training-queue e2e (S8-2): locks in the `nextTrainingCompleteAt` mirror added 2026-07-26
// (VPS CPU investigation — processCompletedTraining's due-scan was a full COLLSCAN on `trainingQueue.0.completeAt`,
// which has no supporting index; this field mirrors the queue's head so the scan can use a real index).
//   ① trainTroops sets it to the new (only) entry; a second enqueue on top of an existing queue leaves it untouched;
//   ② processCompletedTraining advances it to the next entry after the first is done, and clears it once the queue drains;
//   ③ speedupTraining / the shop troop_speedup path draining the queue also clears it.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_TRAIN_INK_COST,
  TROOP_TRAIN_PAPER_COST,
  TROOP_TRAIN_GRAPHITE_COST,
  TROOP_TRAIN_METAL_COST,
  TROOP_TRAIN_STICKER_COST,
  TROOP_TRAIN_TIME_SEC,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_training_test';
const W = 's1-training';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city-training.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Mirrors city-buildings.e2e.test.ts's findCoord: a spawnable capital anchor free of procedural obstacles. */
function findCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('worldsvc training-queue nextTrainingCompleteAt mirror e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend() { /* no-op */ },
    async grant() { /* no-op */ },
  };

  async function fund(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 }, lastTickAt: nowMs } },
    );
  }

  /** A fresh capital starts with troops already at troopCap (territory.ts joinWorld) — drain it first so trainTroops has room. */
  async function drainTroops(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, accountId) }, { $set: { troops: 0 } });
  }

  /** Raw doc read — nextTrainingCompleteAt is scheduler-only and not part of PlayerWorldView. */
  async function rawDoc(accountId: string) {
    return m.collections.playerWorld.findOne({ _id: playerWorldId(W, accountId) });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      commercial: fakeCommercial,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('trainTroops sets nextTrainingCompleteAt to the new entry when the queue was empty', async () => {
    const { x, y } = findCoord(10, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    const after = await svc.trainTroops(W, 'a', 100);
    expect(after.trainingQueue).toHaveLength(1);
    const doc = await rawDoc('a');
    expect(doc!.nextTrainingCompleteAt).toBe(doc!.trainingQueue![0]!.completeAt);
  });

  // 2026-08-01: training was widened from an ink-only sink to ink+paper+graphite+metal+sticker (troopTrainCost).
  it('trainTroops deducts all five resources (ink/paper/graphite/metal/sticker), not ink alone', async () => {
    const { x, y } = findCoord(70, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    // getMe's resources are lazily-settled + capped at RESOURCE_CAP (core/map.ts); fund() stores a raw 1,000,000
    // that's well above the cap, so the settled baseline must come from getMe too — comparing against the raw
    // doc would also count the cap-clamp as part of the "deduction" and inflate every delta.
    const before = (await svc.getMe(W, 'a')).resources!;
    const after = (await svc.trainTroops(W, 'a', 100)).resources!;
    expect(before.ink! - after.ink!).toBe(100 * TROOP_TRAIN_INK_COST);
    expect(before.paper! - after.paper!).toBe(100 * TROOP_TRAIN_PAPER_COST);
    expect(before.graphite! - after.graphite!).toBe(100 * TROOP_TRAIN_GRAPHITE_COST);
    expect(before.metal! - after.metal!).toBe(100 * TROOP_TRAIN_METAL_COST);
    expect(before.sticker! - after.sticker!).toBe(100 * TROOP_TRAIN_STICKER_COST);
  });

  it('rejects training when a non-ink resource (paper) is short, even with abundant ink/graphite/metal/sticker', async () => {
    const { x, y } = findCoord(75, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    // 100 troops need 100 * TROOP_TRAIN_PAPER_COST paper — leave far less than that, everything else stays abundant.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { 'resources.paper': 10 } });

    await expect(svc.trainTroops(W, 'a', 100)).rejects.toThrow(/Insufficient paper/i);
    // rejected up-front: no partial debit of the other four resources.
    const doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.resources!.ink).toBe(1_000_000);
  });

  it('a second trainTroops call (queue already non-empty) leaves nextTrainingCompleteAt at the existing head', async () => {
    const { x, y } = findCoord(15, 15);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.trainTroops(W, 'a', 100);
    const firstHead = (await rawDoc('a'))!.nextTrainingCompleteAt;

    const after = await svc.trainTroops(W, 'a', 100); // chains after the first (queue max is 2 by default)
    expect(after.trainingQueue).toHaveLength(2);
    expect((await rawDoc('a'))!.nextTrainingCompleteAt).toBe(firstHead);
  });

  it('processCompletedTraining advances the mirror to the next entry, then clears it once the queue drains', async () => {
    const { x, y } = findCoord(20, 20);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.trainTroops(W, 'a', 100);
    await svc.trainTroops(W, 'a', 100);
    const secondCompleteAt = (await rawDoc('a'))!.trainingQueue![1]!.completeAt;

    // advance just past the first batch's completeAt
    nowMs += TROOP_TRAIN_TIME_SEC * 100 * 1000 + 1;
    const applied = await svc.processCompletedTraining(nowMs);
    expect(applied).toBe(1);
    let doc = await rawDoc('a');
    expect(doc!.trainingQueue).toHaveLength(1);
    expect(doc!.nextTrainingCompleteAt).toBe(secondCompleteAt); // mirror advanced, not stuck or cleared

    // advance past the second batch too — queue drains, mirror must be unset (not left stale/zero)
    nowMs = secondCompleteAt + 1;
    const applied2 = await svc.processCompletedTraining(nowMs);
    expect(applied2).toBe(1);
    doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.nextTrainingCompleteAt).toBeUndefined();
    expect(doc!.troops).toBe(200);
  });

  it('processCompletedTraining is a no-op (and does not touch the mirror) before completeAt', async () => {
    const { x, y } = findCoord(25, 25);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);
    const before = await rawDoc('a');

    const applied = await svc.processCompletedTraining(nowMs); // still at enqueue time, nothing due
    expect(applied).toBe(0);
    const after = await rawDoc('a');
    expect(after!.nextTrainingCompleteAt).toBe(before!.nextTrainingCompleteAt);
    expect(after!.trainingQueue).toHaveLength(1);
  });

  it('speedupTraining draining the whole queue clears nextTrainingCompleteAt', async () => {
    const { x, y } = findCoord(30, 30);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);
    expect((await rawDoc('a'))!.nextTrainingCompleteAt).toBeDefined();

    // enough coins to cover the whole remaining duration
    await svc.speedupTraining(W, 'a', 100_000);
    const doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.nextTrainingCompleteAt).toBeUndefined();
    expect(doc!.troops).toBeGreaterThanOrEqual(100);
  });

  it('the shop troop_speedup path draining the queue also clears nextTrainingCompleteAt', async () => {
    const { x, y } = findCoord(35, 35);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);
    expect((await rawDoc('a'))!.nextTrainingCompleteAt).toBeDefined();

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h');
    const doc = await rawDoc('a');
    expect(doc!.nextTrainingCompleteAt).toBeUndefined();
  });

  it('ensureIndexes builds a partial index on nextTrainingCompleteAt (not a full-collection scan)', async () => {
    const { x, y } = findCoord(40, 40);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);

    const explain = await m.collections.playerWorld
      .find({ nextTrainingCompleteAt: { $lte: nowMs + 10_000_000 } })
      .explain('executionStats');
    const stats = (explain as { executionStats?: { totalKeysExamined: number; totalDocsExamined: number } }).executionStats;
    expect(stats).toBeDefined();
    expect(stats!.totalKeysExamined).toBeGreaterThan(0); // used the index, not a bare collection scan
  });
});
