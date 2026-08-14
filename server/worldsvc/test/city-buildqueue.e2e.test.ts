// worldsvc build-queue e2e (SLG_CITY_DESIGN P1): locks in the `nextBuildCompleteAt` mirror added 2026-07-26
// (VPS CPU investigation — processCompletedBuilds' due-scan was a full COLLSCAN on `buildQueue.0.completeAt`,
// which has no supporting index, exactly like the training-queue's own scan; same fix, see city-training.e2e.test.ts).
//   ① upgradeBuilding sets it to the new entry; ② processCompletedBuilds clears it once the (single-slot) queue drains;
//   ③ speedupBuild draining the queue also clears it; ④ the due-scan actually uses the new index.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_buildqueue_test';
const W = 's1-buildqueue';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city-buildqueue.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

describe.skipIf(!mongo)('worldsvc build-queue nextBuildCompleteAt mirror e2e', () => {
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

  /** Raw doc read — nextBuildCompleteAt is scheduler-only and not part of PlayerWorldView. */
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

  it('upgradeBuilding sets nextBuildCompleteAt to the new (only) entry', async () => {
    const { x, y } = findCoord(10, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');

    const after = await svc.upgradeBuilding(W, 'a', 'inkPot');
    expect(after.buildQueue).toHaveLength(1);
    const doc = await rawDoc('a');
    expect(doc!.nextBuildCompleteAt).toBe(doc!.buildQueue![0]!.completeAt);
  });

  it('processCompletedBuilds clears nextBuildCompleteAt once the (single-slot) queue drains', async () => {
    const { x, y } = findCoord(15, 15);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'inkPot');
    const completeAt = (await rawDoc('a'))!.buildQueue![0]!.completeAt;
    expect((await rawDoc('a'))!.nextBuildCompleteAt).toBe(completeAt);

    nowMs = completeAt + 1;
    const applied = await svc.processCompletedBuilds(nowMs);
    expect(applied).toBe(1);
    const doc = await rawDoc('a');
    expect(doc!.buildQueue ?? []).toHaveLength(0);
    expect(doc!.nextBuildCompleteAt).toBeUndefined();
    expect(doc!.buildings).toEqual({ desk: 1, inkPot: 1 });
  });

  it('processCompletedBuilds is a no-op (and does not touch the mirror) before completeAt', async () => {
    const { x, y } = findCoord(20, 20);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'inkPot');
    const before = await rawDoc('a');

    const applied = await svc.processCompletedBuilds(nowMs); // still at enqueue time, nothing due
    expect(applied).toBe(0);
    const after = await rawDoc('a');
    expect(after!.nextBuildCompleteAt).toBe(before!.nextBuildCompleteAt);
    expect(after!.buildQueue).toHaveLength(1);
  });

  it('speedupBuild draining the queue also clears nextBuildCompleteAt', async () => {
    const { x, y } = findCoord(25, 25);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    expect((await rawDoc('a'))!.nextBuildCompleteAt).toBeDefined();

    const after = await svc.speedupBuild(W, 'a', 100_000); // enough coins to finish immediately
    expect(after.buildQueue ?? []).toHaveLength(0);
    const doc = await rawDoc('a');
    expect(doc!.nextBuildCompleteAt).toBeUndefined();
    expect(doc!.buildings).toEqual({ desk: 1, cabinet: 1 });
  });

  it('ensureIndexes builds a partial index on nextBuildCompleteAt (not a full-collection scan)', async () => {
    const { x, y } = findCoord(30, 30);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'inkPot');

    const explain = await m.collections.playerWorld
      .find({ nextBuildCompleteAt: { $lte: nowMs + 10_000_000 } })
      .explain('executionStats');
    const stats = (explain as { executionStats?: { totalKeysExamined: number; totalDocsExamined: number } }).executionStats;
    expect(stats).toBeDefined();
    expect(stats!.totalKeysExamined).toBeGreaterThan(0); // used the index, not a bare collection scan
  });
});
