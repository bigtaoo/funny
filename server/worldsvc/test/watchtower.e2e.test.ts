// worldsvc watchtower end-to-end (§18 G5 V2 remaining item "fixed-radius persistent vision source"): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Watchtower = spend WATCHTOWER_COST resources on an owned territory to create a large-radius (VISION_WATCHTOWER_RADIUS=8) persistent vision source;
//   persisted in TileDoc (lost when the territory is lost). Validation: own territory / not home tile / sufficient resources; idempotent, no double charge.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_WATCHTOWER_RADIUS,
  VISION_TERRITORY_RADIUS,
  WATCHTOWER_COST,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_watchtower_test';
const W = 's1-watchtower';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.watchtower.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spiral search around (sx,sy) for the first tile satisfying predicate (deterministic). */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
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
const NEUTRAL = (t: ReturnType<typeof proceduralTile>) => t.type === 'neutral';

describe.skipIf(!mongo)('worldsvc watchtower e2e (§18 G5 V2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Occupy a territory far from the home base and seed it with sufficient resources; returns the territory coordinates. */
  async function setupTerritoryWithResources(acct: string): Promise<{ x: number; y: number }> {
    await svc.joinWorld(W, acct, 5, 5);
    const terr = findCoord(NEUTRAL, 5, 60); // far from home base (outside base vision radius), to verify watchtower extends vision
    await svc.occupyTile(W, acct, terr.x, terr.y);
    // Starting resources are 0 (join gives emptyResources) → directly seed enough resources to build a watchtower (no yield accumulation needed).
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, acct) },
      { $set: { resources: { ink: 1000, paper: 5000, graphite: 5000, metal: 5000, sticker: 5000 }, lastTickAt: nowMs } },
    );
    return terr;
  }

  it('build watchtower on own territory: deducts resources + sets watchtower flag + visible in view', async () => {
    const terr = await setupTerritoryWithResources('a');
    const view = await svc.buildWatchtower(W, 'a', terr.x, terr.y);
    expect(view).toMatchObject({ x: terr.x, y: terr.y, mine: true, watchtower: true });

    // Persisted to DB: TileDoc.watchtower=true.
    const doc = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(doc?.watchtower).toBe(true);

    // Resources deducted by WATCHTOWER_COST (metal 5000-2000, paper 5000-3000).
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.resources.metal).toBe(5000 - WATCHTOWER_COST.metal);
    expect(pw?.resources.paper).toBe(5000 - WATCHTOWER_COST.paper);
  });

  it('extends vision: previously fogged distant tile becomes visible after watchtower, beyond radius stays fogged', async () => {
    const terr = await setupTerritoryWithResources('a');
    // F is at chebyshev distance 6 from the territory: > VISION_TERRITORY_RADIUS(2) and < VISION_WATCHTOWER_RADIUS(8).
    const dist = 6;
    expect(dist).toBeGreaterThan(VISION_TERRITORY_RADIUS);
    expect(dist).toBeLessThan(VISION_WATCHTOWER_RADIUS);
    const fx = terr.x;
    const fy = terr.y + dist;

    // Before building: F is in fog (territory vision radius is only 2, cannot reach it).
    const before = await svc.getMap(W, 'a', fx, fy, 0);
    expect(before.tiles.find((t) => t.x === fx && t.y === fy)!.visible).toBe(false);

    await svc.buildWatchtower(W, 'a', terr.x, terr.y);

    // After building: F enters watchtower vision (radius 8) → visible.
    const after = await svc.getMap(W, 'a', fx, fy, 0);
    expect(after.tiles.find((t) => t.x === fx && t.y === fy)!.visible).toBe(true);

    // Control: beyond watchtower radius (distance 10 > 8) still in fog.
    const farY = terr.y + 10;
    const far = await svc.getMap(W, 'a', fx, farY, 0);
    expect(far.tiles.find((t) => t.x === fx && t.y === farY)!.visible).toBe(false);
  });

  it('guard: non-own / unoccupied tile rejected (TILE_NOT_OWNED)', async () => {
    await setupTerritoryWithResources('a');
    const empty = findCoord(NEUTRAL, 5, 80); // unoccupied
    await expect(svc.buildWatchtower(W, 'a', empty.x, empty.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('guard: home base cannot have watchtower (BAD_REQUEST, home base has built-in vision)', async () => {
    await setupTerritoryWithResources('a');
    await expect(svc.buildWatchtower(W, 'a', 5, 5)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('guard: insufficient resources rejected (INSUFFICIENT_RESOURCES), map unchanged', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const terr = findCoord(NEUTRAL, 5, 60);
    await svc.occupyTile(W, 'a', terr.x, terr.y);
    // Insufficient resources (default 0) → rejected.
    await expect(svc.buildWatchtower(W, 'a', terr.x, terr.y)).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });
    const doc = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(doc?.watchtower).toBeUndefined(); // watchtower not built
  });

  it('idempotent: building watchtower again returns watchtower:true without double charging', async () => {
    const terr = await setupTerritoryWithResources('a');
    await svc.buildWatchtower(W, 'a', terr.x, terr.y);
    const pw1 = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    const view2 = await svc.buildWatchtower(W, 'a', terr.x, terr.y); // idempotent
    expect(view2.watchtower).toBe(true);
    const pw2 = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw2?.resources.metal).toBe(pw1?.resources.metal); // not charged a second time
    expect(pw2?.resources.paper).toBe(pw1?.resources.paper);
  });
});
