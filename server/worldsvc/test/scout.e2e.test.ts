// worldsvc scout march end-to-end (G5 V2 remaining items, §18.1 V2 / §18.2): real Mongo. Entire suite skipped if Mongo is unreachable.
//   scout = a non-combat, non-occupying march: dispatch a small number of troops to any non-obstacle tile (including enemy/neutral),
//   illuminating a larger vision radius along the path and at the destination (VISION_SCOUT_RADIUS=4 > normal march 2);
//   automatically flips to a return leg on arrival and refunds troops to pool.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_SCOUT_RADIUS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_scout_test';
const W = 's1-scout';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.scout.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

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

describe.skipIf(!mongo)('worldsvc scout march e2e (G5 V2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('scout to enemy tile: no combat, no occupation, no under_attack warning, tile ownership unchanged', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'def', 40, 40); // def's home tile (enemy tile, has protection period / garrison)
    pushes = [];

    // a scouts def's home tile (an occupied tile) — startMarch must not throw; kind=scout.
    const mv = await svc.startMarch(W, 'a', 5, 5, 40, 40, 'scout', 1);
    expect(mv.kind).toBe('scout');
    // Scout is not an attack: def must not receive an under_attack warning.
    expect(pushes.filter((p) => p.accountId === 'def' && p.msg.kind === 'under_attack')).toHaveLength(0);

    // On arrival: no occupation — def is still the tile owner (ownership signalled via mine/occupied, no raw ownerId).
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const tile = await svc.getTile(W, 'def', 40, 40);
    expect(tile.mine).toBe(true);
    expect(tile.occupied).toBe(true);
  });

  it('scout has deeper vision: destination illuminates tiles at chebyshev≤4, >4 still fogged (radius = VISION_SCOUT_RADIUS)', async () => {
    expect(VISION_SCOUT_RADIUS).toBe(4); // enforces the contract that scout vision (4) is deeper than normal march vision (2)
    await svc.joinWorld(W, 'a', 5, 5);
    // A neutral target well outside the home base vision radius (5).
    const dst = findCoord(NEUTRAL, 5, 30);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'scout', 1);

    // now=arriveAt: interpolated position = dst (march document still present; getMap does not consume the arrival). visible flag for fog tiles is only produced by getMap.
    nowMs = mv.arriveAt;
    const map = await svc.getMap(W, 'a', dst.x, dst.y, 6);
    const at = (x: number, y: number) => map.tiles.find((tt) => tt.x === x && tt.y === y);
    // chebyshev 4 = vision edge → visible (normal march radius 2 cannot reach this far).
    expect(at(dst.x + 4, dst.y)?.visible).toBe(true);
    // chebyshev 5 → out of range, no other vision source → fog.
    expect(at(dst.x + 5, dst.y)?.visible).toBe(false);
  });

  it('scout auto-returns: on arrival flips to return leg, troops return along same path and are refunded to pool', async () => {
    const me0 = await svc.joinWorld(W, 'a', 5, 5);
    const troops0 = me0.troops ?? 0;
    expect(troops0).toBeGreaterThan(0);

    const dst = findCoord(NEUTRAL, 5, 30);
    const out = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'scout', 1);
    expect((await svc.getMe(W, 'a')).troops).toBe(troops0 - 1); // troops deducted on departure (in transit)

    // Outbound leg arrives → return leg automatically created (troops not yet refunded).
    nowMs = out.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const afterArrive = await svc.getMarches(W, 'a');
    const back = afterArrive.find((mm) => mm.kind === 'return' && mm.mine);
    expect(back).toBeTruthy();
    expect(back!.fromTile).toBe(`${W}:${dst.x}:${dst.y}`); // returning from destination
    expect(back!.toTile).toBe(`${W}:5:5`);                 // back to origin tile
    expect((await svc.getMe(W, 'a')).troops).toBe(troops0 - 1); // return leg in transit, not yet refunded

    // Return leg arrives → troops refunded to pool.
    nowMs = back!.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const meEnd = await svc.getMe(W, 'a');
    expect(meEnd.troops).toBe(troops0);
    // Scout never occupies territory: territory count remains 1 (home only); dst was not written as a new territory.
    expect(meEnd.territoryCount).toBe(1);
    expect(await m.collections.tiles.findOne({ _id: `${W}:${dst.x}:${dst.y}` })).toBeNull();
  });
});
