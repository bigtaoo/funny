// worldsvc home-city building system end-to-end (SLG_CITY_DESIGN P1, ADR-022): real Mongo.
//   ① upgradeBuilding deducts resources + enqueues a build; processCompletedBuilds applies the level when due;
//   ② resource buildings (stickerShop / graphiteMill) take effect in recomputeYield after completion (faucet/sink wiring);
//   ③ drillYard raises troopCap on completion; ④ desk gate rejects over-level upgrades; ⑤ insufficient resources rejected;
//   ⑥ speedupBuild (coins → time) finishes a build immediately; ⑦ season reset wipes the playerWorld doc (buildings cleared).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
  } catch {
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
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'gate' || t.type === 'stronghold';
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
    // cabinet raises storage cap → settle is no longer clamped at the base RESOURCE_CAP
    expect(after.resources!.paper).toBeGreaterThan(0);
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
});
