// worldsvc home-city building system end-to-end (SLG_CITY_DESIGN P1, ADR-022): real Mongo.
//   ① upgradeBuilding deducts resources + enqueues a build; processCompletedBuilds applies the level when due;
//   ② resource buildings (stickerShop / graphiteMill) take effect in recomputeYield after completion (faucet/sink wiring);
//   ③ drillYard raises troopCap on completion; ④ desk gate rejects over-level upgrades; ⑤ insufficient resources rejected;
//   ⑥ speedupBuild (coins → time) finishes a build immediately; ⑦ season reset wipes the playerWorld doc (buildings cleared).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  DRILL_TROOPCAP_STEP,
  STICKER_SELF_BASE,
  RESOURCE_CAP,
  buildCost,
  buildTimeSec,
  baseFootprintCells,
  baseFootprintInBounds,
  isCityGroundTile,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_city_test';
const W = 's1-city';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * Find a spawnable capital anchor (ADR-025): the whole 3×3 footprint must be in-bounds
 * and free of center/obstacle/gate/stronghold procedural terrain (mirrors joinWorld's footprintFree).
 */
function findCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return isCityGroundTile(t.type) || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('worldsvc home-city buildings e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let spent: { accountId: string; amount: number }[];

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spent.push({ accountId, amount }); },
    async grant() { /* no-op */ },
  };

  /** Give the player a big resource stockpile so upgrades aren't blocked by cost. */
  async function fund(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 }, lastTickAt: nowMs } },
    );
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    spent = [];
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

  it('new capital starts with desk:1 and base troopCap', async () => {
    const { x, y } = findCoord(10, 10);
    const me = await svc.joinWorld(W, 'a', x, y);
    expect(me.buildings).toEqual({ desk: 1 });
    expect(me.troopCap).toBe(TROOP_CAP_BASE);
  });

  it('upgradeBuilding deducts resources, enqueues, and applies the level when due', async () => {
    const { x, y } = findCoord(10, 10);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');

    const before = (await svc.getMe(W, 'a')).resources!.paper;
    const after = await svc.upgradeBuilding(W, 'a', 'inkPot');
    expect(after.buildQueue).toHaveLength(1);
    expect(after.buildQueue![0]!.key).toBe('inkPot');
    expect(after.buildQueue![0]!.toLevel).toBe(1);
    // cost deducted
    expect(before - after.resources!.paper).toBe(buildCost('inkPot', 1).paper);
    // not yet applied
    expect(after.buildings).toEqual({ desk: 1 });

    // advance past completeAt → scheduler applies it
    nowMs += buildTimeSec('inkPot', 1) * 1000 + 1;
    const applied = await svc.processCompletedBuilds();
    expect(applied).toBe(1);
    const me = await svc.getMe(W, 'a');
    expect(me.buildings).toEqual({ desk: 1, inkPot: 1 });
    expect(me.buildQueue ?? []).toHaveLength(0);
  });

  it('upgradeBuilding rejects a second build while the queue is already at BUILD_QUEUE_SLOTS(1) → BAD_REQUEST', async () => {
    const { x, y } = findCoord(12, 12);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'inkPot');
    expect((await svc.getMe(W, 'a')).buildQueue).toHaveLength(1);
    // A different building key still hits the queue-full check first (checked before the per-key desk gate).
    await expect(svc.upgradeBuilding(W, 'a', 'cabinet')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // the rejected attempt must not have been enqueued or debited.
    const after = await svc.getMe(W, 'a');
    expect(after.buildQueue).toHaveLength(1);
    expect(after.buildQueue![0]!.key).toBe('inkPot');
  });

  it('upgradeBuilding: concurrent calls cannot double-queue off a shared stale resource read', async () => {
    const { x, y } = findCoord(15, 15);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    const before = (await svc.getMe(W, 'a')).resources!.paper;
    // All four calls read the same pre-debit resources/queue snapshot; without a rev guard on the write, each
    // would independently pass the sufficiency check and $set its own (stale) resources object, so whichever
    // commits last silently erases the others' deduction while every build still gets queued.
    const calls = Array.from({ length: 4 }, () => svc.upgradeBuilding(W, 'a', 'inkPot'));
    const res = await Promise.allSettled(calls);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(res.filter((r) => r.status === 'rejected').length).toBe(3);
    const after = await svc.getMe(W, 'a');
    expect(after.buildQueue).toHaveLength(1);
    expect(before - after.resources!.paper).toBe(buildCost('inkPot', 1).paper);
  });

  it('stickerShop self-produces sticker after completion (sticker faucet activated)', async () => {
    const { x, y } = findCoord(20, 20);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    // before: no sticker yield
    expect((await svc.getMe(W, 'a')).yieldRate!.sticker).toBe(0);

    await svc.upgradeBuilding(W, 'a', 'stickerShop');
    nowMs += buildTimeSec('stickerShop', 1) * 1000 + 1;
    await svc.processCompletedBuilds();
    expect((await svc.getMe(W, 'a')).yieldRate!.sticker).toBe(STICKER_SELF_BASE);
  });

  it('drillYard raises troopCap after completion', async () => {
    const { x, y } = findCoord(30, 30);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'drillYard');
    nowMs += buildTimeSec('drillYard', 1) * 1000 + 1;
    await svc.processCompletedBuilds();
    expect((await svc.getMe(W, 'a')).troopCap).toBe(TROOP_CAP_BASE + DRILL_TROOPCAP_STEP);
  });

  it('desk gate rejects upgrading a building above the desk level', async () => {
    const { x, y } = findCoord(40, 40);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    // build inkPot to level 1 (allowed at desk 1)
    await svc.upgradeBuilding(W, 'a', 'inkPot');
    nowMs += buildTimeSec('inkPot', 1) * 1000 + 1;
    await svc.processCompletedBuilds();
    // inkPot → level 2 needs desk ≥ 2 → rejected
    await expect(svc.upgradeBuilding(W, 'a', 'inkPot')).rejects.toThrow(/desk level too low/);
  });

  it('rejects upgrade when resources are insufficient', async () => {
    const { x, y } = findCoord(50, 50);
    await svc.joinWorld(W, 'a', x, y);
    // fresh capital has zero resources
    await expect(svc.upgradeBuilding(W, 'a', 'cabinet')).rejects.toThrow(/Insufficient/i);
  });

  it('speedupBuild finishes a queued build immediately via coins', async () => {
    const { x, y } = findCoord(60, 60);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    // still queued
    expect((await svc.getMe(W, 'a')).buildQueue ?? []).toHaveLength(1);
    const after = await svc.speedupBuild(W, 'a', 100_000);
    expect(spent.length).toBe(1);
    expect(after.buildings).toEqual({ desk: 1, cabinet: 1 });
    expect(after.buildQueue ?? []).toHaveLength(0);
  });

  it('speedupBuild: insufficient coins (commercial rejects spend) → build stays queued, untouched', async () => {
    const { x, y } = findCoord(65, 65);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    expect((await svc.getMe(W, 'a')).buildQueue ?? []).toHaveLength(1);
    const before = await svc.getMe(W, 'a');
    const originalSpend = fakeCommercial.spend;
    fakeCommercial.spend = async () => { throw new Error('INSUFFICIENT_FUNDS'); };
    try {
      await expect(svc.speedupBuild(W, 'a', 100_000)).rejects.toThrow('INSUFFICIENT_FUNDS');
    } finally {
      fakeCommercial.spend = originalSpend;
    }
    const after = await svc.getMe(W, 'a');
    expect(after.buildQueue).toEqual(before.buildQueue);
    expect(after.buildings).toEqual(before.buildings);
  });

  it('cabinet raises the storage cap (resources settle above base RESOURCE_CAP)', async () => {
    const { x, y } = findCoord(70, 70);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    nowMs += buildTimeSec('cabinet', 1) * 1000 + 1;
    await svc.processCompletedBuilds();
    // stuff the stockpile above the base cap then read back
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { resources: { ink: RESOURCE_CAP + 50_000, paper: 0, graphite: 0, metal: 0, sticker: 0 }, lastTickAt: nowMs } },
    );
    expect((await svc.getMe(W, 'a')).resources!.ink).toBeGreaterThan(RESOURCE_CAP);
  });

  // D-CITY-8: a completed `wall` upgrade raises durabilityMax and the anchor tile's durability is
  // regened up to now, then the delta (newMax - oldMax) is added on top — preserving absolute damage
  // already taken rather than resetting to full (buildings.ts lines ~185-199).
  it('wall upgrade completion regens + raises the main-base tile durabilityMax by the delta', async () => {
    const { x, y } = findCoord(80, 80);
    const me = await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    const oldMax = (await svc.getMe(W, 'a')).maxHp;
    // Chip the base's durability down so we can observe both regen and the level-up delta.
    await m.collections.tiles.updateOne(
      { _id: me.mainBaseTile! },
      { $set: { durability: 10, durabilityMax: oldMax, durabilityRegenAt: nowMs } },
    );
    await svc.upgradeBuilding(W, 'a', 'wall');
    nowMs += buildTimeSec('wall', 1) * 1000 + 1;
    const applied = await svc.processCompletedBuilds();
    expect(applied).toBe(1);
    const tile = await m.collections.tiles.findOne({ _id: me.mainBaseTile! });
    const newMax = (await svc.getMe(W, 'a')).maxHp!;
    expect(newMax).toBeGreaterThan(oldMax!);
    expect(tile!.durabilityMax).toBe(newMax);
    // regened (from 10, over the elapsed build time) plus the raw (newMax-oldMax) delta, capped at newMax.
    expect(tile!.durability!).toBeGreaterThan(10);
    expect(tile!.durability!).toBeLessThanOrEqual(newMax);
  });

  // Mirrors the new desk level onto the anchor tile (TileDoc.deskLevel) so the world map can render
  // the matching player-base art frame (buildings.ts lines ~202-207).
  it('desk upgrade completion mirrors the new level onto the anchor tile as deskLevel', async () => {
    const { x, y } = findCoord(85, 85);
    const me = await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'desk');
    nowMs += buildTimeSec('desk', 2) * 1000 + 1;
    await svc.processCompletedBuilds();
    const tile = await m.collections.tiles.findOne({ _id: me.mainBaseTile! });
    expect((tile as unknown as { deskLevel?: number }).deskLevel).toBe(2);
  });

  it('speedupBuild: a partial speedup only trims time off the front, without finishing the build', async () => {
    const { x, y } = findCoord(90, 90);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    const before = (await svc.getMe(W, 'a')).buildQueue![0]!.completeAt;
    // 1 coin → BUILD_SPEEDUP_SECS_PER_COIN(60)s, far short of cabinet's full build time.
    const after = await svc.speedupBuild(W, 'a', 1);
    const me = await svc.getMe(W, 'a');
    expect(me.buildings).toEqual({ desk: 1 }); // not yet applied
    expect(me.buildQueue).toHaveLength(1);
    expect(me.buildQueue![0]!.completeAt).toBeLessThan(before);
    expect(after.buildQueue![0]!.completeAt).toBe(me.buildQueue![0]!.completeAt);
  });

  // applyDueBuilds is idempotent: re-entry against a doc whose buildQueue has already been drained
  // (e.g. a stale nextBuildCompleteAt mirror pointing at an already-cleared queue) is a no-op that
  // returns 0 rather than throwing (buildings.ts line ~166).
  it('processCompletedBuilds no-ops (returns 0 applied) for a doc with an empty buildQueue', async () => {
    const { x, y } = findCoord(95, 95);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    // Simulate a stale mirror: nextBuildCompleteAt due, but buildQueue already empty.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { nextBuildCompleteAt: nowMs - 1, buildQueue: [] } },
    );
    const applied = await svc.processCompletedBuilds();
    expect(applied).toBe(0);
  });

  // speedupBuild's finalize retry loop re-reads the doc fresh each attempt; if the doc vanished
  // between the initial read and a retry (e.g. season reset raced in), it bails out via getMe
  // instead of throwing (buildings.ts line ~93).
  it('speedupBuild bails via getMe when the playerWorld doc vanishes mid-retry', async () => {
    const { x, y } = findCoord(96, 12);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    const originalSpend = fakeCommercial.spend;
    fakeCommercial.spend = async (accountId, amount) => {
      spent.push({ accountId, amount });
      // Delete the doc so the loop's fresh findOne comes back null.
      await m.collections.playerWorld.deleteOne({ _id: playerWorldId(W, 'a') });
    };
    try {
      const result = await svc.speedupBuild(W, 'a', 100_000);
      // getMe on a missing doc re-derives a fresh view rather than throwing.
      expect(result).toBeTruthy();
    } finally {
      fakeCommercial.spend = originalSpend;
    }
  });

  // Every rev-guarded finalize write in speedupBuild's retry loop losing the race (MAX_ATTEMPTS
  // times) throws REV_CONFLICT rather than silently stranding the already-spent coins
  // (buildings.ts line ~130).
  it('speedupBuild throws REV_CONFLICT when every finalize attempt loses the rev race', async () => {
    const { x, y } = findCoord(97, 40);
    await svc.joinWorld(W, 'a', x, y);
    await fund('a');
    await svc.upgradeBuilding(W, 'a', 'cabinet');
    const spy = vi.spyOn(m.collections.playerWorld, 'updateOne').mockResolvedValue({ matchedCount: 0 } as never);
    try {
      await expect(svc.speedupBuild(W, 'a', 100_000)).rejects.toMatchObject({ code: 'REV_CONFLICT' });
    } finally {
      spy.mockRestore();
    }
    // the spend already went through — coins were not refunded, matching upgradeBuilding's own comment.
    expect(spent.length).toBe(1);
  });
});
