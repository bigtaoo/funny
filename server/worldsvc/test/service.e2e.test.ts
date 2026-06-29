// worldsvc WorldService end-to-end (S8-1): real Mongo dedicated database. Entire suite skips if Mongo is unreachable.
//   Procedural map merge / join world (main base + shield + idempotency) / occupy (write TileDoc + deduct troops + yield rate) / abandon (return troops + recalculate) /
//   lazy resource settlement / occupy validation (out-of-bounds / center tile / others' territory / protection period / insufficient troops) / world full.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  RESOURCE_YIELD_BASE,
  GARRISON_PER_TILE,
  TROOP_CAP_BASE,
  RELOCATE_COST,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_test';
const W = 's1-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spiral search around (sx, sy) for a tile satisfying predicate (deterministic; used to locate resource tiles). */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx = 5,
  sy = 5,
): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('worldsvc WorldService e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('getMap: procedural default + unique world center', async () => {
    const view = await svc.getMap(W, 'a', CENTER_X, CENTER_Y, 2);
    expect(view.tiles).toHaveLength(25); // 5×5
    const centers = view.tiles.filter((t) => t.type === 'center');
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: CENTER_X, y: CENTER_Y });
  });

  it('not joined: getMe joined=false', async () => {
    // worldId is always returned (G6/§20 R3: join-season resolution result; includes the queried shard even when not joined).
    expect(await svc.getMe(W, 'a')).toEqual({ joined: false, worldId: W });
  });

  it('join world: create main base + shield + full troops + initial yield rate; idempotent', async () => {
    const neutral = findCoord((t) => t.type === 'neutral');
    const me = await svc.joinWorld(W, 'a', neutral.x, neutral.y);
    expect(me).toMatchObject({
      joined: true,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      mainBaseTile: tileId(W, neutral.x, neutral.y),
      territoryCount: 1,
    });
    expect(me.yieldRate?.food).toBe(RESOURCE_YIELD_BASE); // base starting food trickle

    const tile = await svc.getTile(W, 'a', neutral.x, neutral.y);
    expect(tile).toMatchObject({ type: 'base', mine: true, occupied: true });
    expect(tile.protectedUntil).toBe(nowMs + 8 * 3600 * 1000);

    // Idempotent: joining again with different coordinates does not create a second base.
    const me2 = await svc.joinWorld(W, 'a', neutral.x + 3, neutral.y + 3);
    expect(me2.mainBaseTile).toBe(tileId(W, neutral.x, neutral.y));
    expect(me2.territoryCount).toBe(1);
  });

  it('occupy resource tile: write territory + deduct troops + increase yield rate; abandon returns troops + recalculates', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const res = findCoord((t) => t.type === 'resource', 50, 50); // far from main base at (5,5), guaranteed to be a different tile
    const procRes = proceduralTile(W, res.x, res.y);
    const rt = procRes.resType as ResourceType;

    const tv = await svc.occupyTile(W, 'a', res.x, res.y);
    expect(tv).toMatchObject({ type: 'territory', mine: true, occupied: true, resType: rt });

    const me = await svc.getMe(W, 'a');
    expect(me.troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE);
    expect(me.territoryCount).toBe(2);
    expect(me.yieldRate?.[rt]).toBe(RESOURCE_YIELD_BASE * procRes.level + (rt === 'food' ? RESOURCE_YIELD_BASE : 0));

    // Occupy is idempotent: re-occupying the same tile does not deduct additional troops.
    await svc.occupyTile(W, 'a', res.x, res.y);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE);

    // Abandon: return troops + territory count decreases + tile reverts to procedural (no ghost doc left in DB).
    const after = await svc.abandonTile(W, 'a', res.x, res.y);
    expect(after.troops).toBe(TROOP_CAP_BASE);
    expect(after.territoryCount).toBe(1);
    expect(await m.collections.tiles.findOne({ _id: tileId(W, res.x, res.y) })).toBeNull();
  });

  it('voluntary relocation: deduct RELOCATE_COST coins + old site reverts to neutral + new site becomes main base + territory retained', async () => {
    const spends: Array<{ accountId: string; amount: number }> = [];
    const commercial = {
      available: true,
      async spend(accountId: string, amount: number) { spends.push({ accountId, amount }); },
      async grant() { /* unused */ },
    };
    const svc2 = new WorldService({
      cols: m.collections, redis: null, commercial,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });

    await svc2.joinWorld(W, 'a', 5, 5);
    const res = findCoord((t) => t.type === 'resource', 50, 50);
    await svc2.occupyTile(W, 'a', res.x, res.y); // one territory tile, should be retained after relocation

    const dst = findCoord((t) => t.type === 'neutral', 80, 80);
    const me = await svc2.relocateBase(W, 'a', dst.x, dst.y);

    expect(spends).toEqual([{ accountId: 'a', amount: RELOCATE_COST }]);
    expect(me.mainBaseTile).toBe(tileId(W, dst.x, dst.y));
    expect(me.territoryCount).toBe(2); // new main base + retained territory
    // Old main base tile reverts to neutral (deleted).
    expect(await m.collections.tiles.findOne({ _id: tileId(W, 5, 5) })).toBeNull();
    // New site becomes main base.
    const newBase = await m.collections.tiles.findOne({ _id: tileId(W, dst.x, dst.y) });
    expect(newBase).toMatchObject({ type: 'base', ownerId: 'a' });
    // Territory tile is still present.
    expect(await m.collections.tiles.findOne({ _id: tileId(W, res.x, res.y), ownerId: 'a' })).not.toBeNull();

    // Relocating to the same spot = no-op (no duplicate charge).
    await svc2.relocateBase(W, 'a', dst.x, dst.y);
    expect(spends).toHaveLength(1);
  });

  it('relocation validation: not joined / out of bounds / target occupied', async () => {
    const commercial = { available: true, async spend() {}, async grant() {} };
    const svc2 = new WorldService({
      cols: m.collections, redis: null, commercial,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });
    await expect(svc2.relocateBase(W, 'ghost', 5, 5)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    await svc2.joinWorld(W, 'a', 5, 5);
    await expect(svc2.relocateBase(W, 'a', -1, 0)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    // Target occupied by another player (b's main base) → TILE_OCCUPIED.
    await svc2.joinWorld(W, 'b', 200, 200);
    await expect(svc2.relocateBase(W, 'a', 200, 200)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('lazy resource settlement: catch-up calculation using yieldRate × dt', async () => {
    await svc.joinWorld(W, 'a', 5, 5); // main base only → food yield 100/h
    nowMs += 3_600_000; // +1h
    const me = await svc.getMe(W, 'a');
    expect(me.resources?.food).toBe(RESOURCE_YIELD_BASE);
    nowMs += 1_800_000; // another +0.5h
    expect((await svc.getMe(W, 'a')).resources?.food).toBe(Math.floor(RESOURCE_YIELD_BASE * 1.5));
  });

  it('occupy validation: out of bounds / center tile / insufficient troops', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.occupyTile(W, 'a', -1, 0)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    await expect(svc.occupyTile(W, 'a', CENTER_X, CENTER_Y)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // Fill 3 tiles (base costs no troops; 2000/500=4 squads, leave 1 to test NO_TROOPS: 5th tile is rejected after occupying 4).
    const frees: { x: number; y: number }[] = [];
    let scanX = 5;
    while (frees.length < 4) {
      scanX += 1;
      const t = proceduralTile(W, scanX, 5);
      if (t.type !== 'center' && !(scanX === CENTER_X && 5 === CENTER_Y)) frees.push({ x: scanX, y: 5 });
    }
    for (const f of frees) await svc.occupyTile(W, 'a', f.x, f.y);
    expect((await svc.getMe(W, 'a')).troops).toBe(0);
    // 5th tile: troops exhausted.
    await expect(svc.occupyTile(W, 'a', scanX + 1, 5)).rejects.toMatchObject({ code: 'NO_TROOPS' });
  });

  it("other player's territory: occupy their main base → PROTECTED; occupy their regular territory → TILE_OCCUPIED", async () => {
    await svc.joinWorld(W, 'b', 200, 200);
    const bTerr = findCoord((t) => t.type === 'resource', 201, 200);
    await svc.occupyTile(W, 'b', bTerr.x, bTerr.y);

    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.occupyTile(W, 'a', 200, 200)).rejects.toMatchObject({ code: 'PROTECTED' });
    await expect(svc.occupyTile(W, 'a', bTerr.x, bTerr.y)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
  });

  it('capacity guard: world document at capacity → WORLD_FULL', async () => {
    await m.collections.worlds.insertOne({
      _id: W,
      season: 1,
      shard: 0,
      status: 'open',
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      openAt: now(),
      capacity: 1,
      population: 0,
      rev: 0,
    });
    await svc.joinWorld(W, 'a', 5, 5);
    expect((await m.collections.worlds.findOne({ _id: W }))?.population).toBe(1);
    await expect(svc.joinWorld(W, 'b', 200, 200)).rejects.toMatchObject({ code: 'WORLD_FULL' });
    // playerWorld document for the rejected player must not be created.
    expect(await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'b') })).toBeNull();
  });
});
