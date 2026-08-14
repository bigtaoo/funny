// worldsvc training-queue e2e (S8-2): locks in the `nextTrainingCompleteAt` mirror added 2026-07-26
// (VPS CPU investigation — processCompletedTraining's due-scan was a full COLLSCAN on `trainingQueue.0.completeAt`,
// which has no supporting index; this field mirrors the queue's head so the scan can use a real index).
//   ① trainTroops sets it to the new (only) entry; a second enqueue on top of an existing queue leaves it untouched;
//   ② processCompletedTraining advances it to the next entry after the first is done, and clears it once the queue drains;
//   ③ speedupTraining draining the queue also clears it.
// Also covers the S8-8 fix (2026-08-08): the shop `troop_speedup` items used to spend their whole duration as a
// one-time instant-skip against whatever was queued *at purchase time* — didn't match the item description
// ("speed up training for N hours") and gave zero benefit to anything queued afterward. They now start a
// persistent `speedupUntil` buff (TRAIN_SPEEDUP_BUFF_MULT×, stacks additively like protection) that speeds up
// the WHOLE queue — present and future batches alike — for as long as it's active; see applyTrainingSpeedupCatchup.
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
  TRAIN_SPEEDUP_BUFF_MULT,
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
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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

  it('trainTroops rejects once troops+inTraining+qty would exceed troopCap → TROOP_CAP_REACHED', async () => {
    const { x, y } = findCoord(45, 45);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    // A fresh capital starts with troops already at troopCap (territory.ts joinWorld) — deliberately
    // do NOT drain here, so any qty > 0 pushes troops+inTraining+qty over the cap.
    await expect(svc.trainTroops(W, 'a', 1)).rejects.toMatchObject({ code: 'TROOP_CAP_REACHED' });
    // rejected up-front: nothing was enqueued or debited.
    expect((await rawDoc('a'))!.trainingQueue ?? []).toHaveLength(0);
  });

  it('trainTroops rejects once the queue is at its slot cap (TROOP_TRAIN_QUEUE_MAX, no drillYard) → BAD_REQUEST', async () => {
    const { x, y } = findCoord(50, 50);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);
    await svc.trainTroops(W, 'a', 100); // fills the queue to TROOP_TRAIN_QUEUE_MAX (2, no drillYard built)
    await expect(svc.trainTroops(W, 'a', 100)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // the rejected 3rd attempt must not have been pushed onto the queue.
    expect((await rawDoc('a'))!.trainingQueue).toHaveLength(2);
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
    expect(doc!.troops).toBe(100);
  });

  it('S8-8 fix: the shop troop_speedup path no longer instant-drains the queue at purchase time', async () => {
    const { x, y } = findCoord(35, 35);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');
    await svc.trainTroops(W, 'a', 100);
    const before = await rawDoc('a');
    expect(before!.nextTrainingCompleteAt).toBeDefined();

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h');
    const doc = await rawDoc('a');
    // Still queued and unchanged at the instant of purchase (zero real time has elapsed yet) — the buff
    // plays out continuously over the next hour instead of being spent all at once.
    expect(doc!.trainingQueue).toHaveLength(1);
    expect(doc!.nextTrainingCompleteAt).toBe(before!.nextTrainingCompleteAt);
    expect(doc!.speedupUntil).toBe(nowMs + 3600 * 1000);
  });

  it('S8-8: a batch already queued when the buff is bought finishes at 2x speed via processCompletedTraining', async () => {
    const { x, y } = findCoord(55, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.trainTroops(W, 'a', 100); // nominal 1x duration: 100 * TROOP_TRAIN_TIME_SEC(5s) = 500_000ms
    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h');

    // Only half the nominal duration of real time needs to pass for a 2x buff to finish the whole batch.
    nowMs += 500_000 / TRAIN_SPEEDUP_BUFF_MULT;
    const applied = await svc.processCompletedTraining(nowMs);
    expect(applied).toBe(1);
    const doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.troops).toBe(100);
  });

  it('S8-8: a batch queued AFTER the buff was bought also gets the 2x speed (not just what was already queued)', async () => {
    const { x, y } = findCoord(56, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h'); // buff active for the next hour, queue currently empty
    await svc.trainTroops(W, 'a', 100); // nominal 500_000ms at 1x

    nowMs += 500_000 / TRAIN_SPEEDUP_BUFF_MULT;
    const applied = await svc.processCompletedTraining(nowMs);
    expect(applied).toBe(1);
    const doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.troops).toBe(100);
  });

  it('S8-8: repeat troop_speedup purchases stack speedupUntil additively, like protection', async () => {
    const { x, y } = findCoord(57, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h');
    const first = (await rawDoc('a'))!.speedupUntil!;
    expect(first).toBe(nowMs + 3600_000);

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_8h');
    const second = (await rawDoc('a'))!.speedupUntil!;
    expect(second).toBe(first + 28800_000); // stacked on top, not overwritten
  });

  it('S8-8: once speedupUntil has passed, newly-queued training reverts to normal (1x) speed', async () => {
    const { x, y } = findCoord(58, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h'); // active until nowMs + 3600_000
    nowMs += 3600_000 + 1; // buff fully expired; nothing was queued yet so there's nothing to catch up

    await svc.trainTroops(W, 'a', 100); // buff no longer active — full 1x duration
    const completeAt = (await rawDoc('a'))!.trainingQueue![0]!.completeAt;
    expect(completeAt - nowMs).toBe(500_000);

    // Half the nominal duration must NOT complete it anymore (no lingering 2x speed after expiry).
    nowMs += 250_000;
    const applied = await svc.processCompletedTraining(nowMs);
    expect(applied).toBe(0);
    expect((await rawDoc('a'))!.trainingQueue).toHaveLength(1);
  });

  it('S8-8: speedupTraining (coin instant-skip) folds in the buff before spending coins on top of it', async () => {
    const { x, y } = findCoord(59, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await drainTroops('a');

    await svc.trainTroops(W, 'a', 100); // nominal 500_000ms
    await svc.buySlgShopItem(W, 'a', 'slg_speedup_1h');
    nowMs += 500_000 / TRAIN_SPEEDUP_BUFF_MULT; // the buff alone has already finished this batch by now

    // 1 coin = 60s worth at 1x — nowhere near enough on its own; if the buff catch-up runs first, the batch
    // is already complete before this coin-spend loop even starts.
    await svc.speedupTraining(W, 'a', 1);
    const doc = await rawDoc('a');
    expect(doc!.trainingQueue ?? []).toHaveLength(0);
    expect(doc!.troops).toBe(100);
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
