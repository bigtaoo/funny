// worldsvc reverse-vision push end-to-end (G5-2, §18.1 V4): real Mongo. Entire suite skipped if Mongo is unreachable.
//   When a march starts or a tile changes owner, push the event to observers whose vision covers that tile
//   (enemy march enters my vision → push immediately); players whose vision does not reach do not receive the push.
//   A single reverse lookup is performed at low-frequency event points (not every tick).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_vpush_test';
const W = 's1-vpush';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.vision-push.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
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
// ADR-032 follow-up: resourceDensity=1.0 means 'neutral' tiles no longer occur; any occupiable land is 'resource'.
const NEUTRAL = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

describe.skipIf(!mongo)('worldsvc reverse-vision push e2e (G5-2)', () => {
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

  const marchUpdatesTo = (acct: string) =>
    pushes.filter((p) => p.accountId === acct && p.msg.kind === 'march_update');
  const tileUpdatesTo = (acct: string) =>
    pushes.filter((p) => p.accountId === acct && p.msg.kind === 'tile_update');

  it('march start: path enters observer vision → push march_update; players out of vision range not pushed', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // obs home base at (5,20): base vision radius covers the mid-section of a's path from (5,5)→(5,40).
    await svc.joinWorld(W, 'obs', 5, 20);
    // far is at (400, 400), outside vision range.
    await svc.joinWorld(W, 'far', 400, 400);

    const dst = findCoord(NEUTRAL, 5, 40);
    await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', OCCUPY_MIN_TROOPS);

    // The marching player themselves receives the push.
    expect(marchUpdatesTo('a').length).toBeGreaterThan(0);
    // The observer (vision covers the path) receives the push.
    expect(marchUpdatesTo('obs').length).toBeGreaterThan(0);
    // Players out of vision range do not receive the push.
    expect(marchUpdatesTo('far')).toHaveLength(0);
  });

  it('direct tile capture: falls within observer vision → push tile_update (capturer not re-pushed, far not pushed)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'obs', 10, 10); // base vision radius 5 covers (12,11)
    await svc.joinWorld(W, 'far', 400, 400);
    pushes = []; // clear pushes from the join events themselves

    // a directly captures (12,11) (falls within obs's vision).
    await svc.occupyTile(W, 'a', 12, 11);

    // obs can see this newly captured tile → receives tile_update for that exact tile.
    // (The tile_update payload identifies the tile by tileId and the occupier by ownerPublicId/ownerName;
    // there is no raw ownerId field, and without a meta client the identity fields are empty — so we
    // assert the push targeted a's freshly captured tile (12,11) rather than the occupier's accountId.)
    const obsTu = tileUpdatesTo('obs');
    expect(obsTu.length).toBeGreaterThan(0);
    expect((obsTu[0]!.msg as { tileId: string }).tileId).toBe(`${W}:12:11`);
    // Capturer a does not receive a reverse push (capture is acknowledged via REST response; pushTileToObservers excludes the actor).
    expect(tileUpdatesTo('a')).toHaveLength(0);
    // Remote far cannot see the tile → not pushed.
    expect(tileUpdatesTo('far')).toHaveLength(0);
  });

  it('siege tile transfer: new ownership visible to third-party observers within vision (attacker and defender receive their own pushes, not counted as observers)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Defender def owns tile (8,8); third-party obs home base at (10,10) covers (8,8) with vision.
    await svc.joinWorld(W, 'def', 40, 40);
    await svc.joinWorld(W, 'obs', 10, 10);
    // def has a territory at (8,8) that can be attacked (written directly as TileDoc, weak garrison, no shield).
    const tgt = findCoord((t) => t.type !== 'obstacle' && t.type !== 'center', 8, 8);
    await m.collections.tiles.updateOne(
      { _id: `${W}:${tgt.x}:${tgt.y}` },
      { $set: { _id: `${W}:${tgt.x}:${tgt.y}`, worldId: W, x: tgt.x, y: tgt.y, type: 'territory', level: 1, ownerId: 'def', garrison: 1, rev: 0 } },
      { upsert: true },
    );
    pushes = [];

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // After the transfer, third-party observer obs (vision covers that tile) receives tile_update.
    const obsTu = tileUpdatesTo('obs');
    expect(obsTu.length).toBeGreaterThan(0);
  });

  it('getMarches: own marches mine:true + enemy marches within vision mine:false + enemy outside vision not returned', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 8, 8);        // within a's base vision (chebyshev 3 ≤ 5)
    await svc.joinWorld(W, 'far', 400, 400);  // outside vision

    // a's own occupy march.
    const aDst = findCoord(NEUTRAL, 5, 9);
    await svc.startMarch(W, 'a', 5, 5, aDst.x, aDst.y, 'occupy', OCCUPY_MIN_TROOPS);
    // e's march: departure point (8,8) is within a's vision → the march is visible at departure (interp≈(8,8)).
    const eDst = findCoord(NEUTRAL, 8, 12);
    await svc.startMarch(W, 'e', 8, 8, eDst.x, eDst.y, 'occupy', OCCUPY_MIN_TROOPS);
    // far's march: remote, outside a's vision range.
    const fDst = findCoord(NEUTRAL, 400, 405);
    await svc.startMarch(W, 'far', 400, 400, fDst.x, fDst.y, 'occupy', OCCUPY_MIN_TROOPS);

    const marches = await svc.getMarches(W, 'a');
    const own = marches.filter((m) => m.mine);
    const enemy = marches.filter((m) => m.mine === false);
    expect(own.length).toBe(1);
    expect(own[0]!.fromTile).toBe(`${W}:5:5`);
    // Enemy march e within vision is returned (mine:false); far outside vision is not returned.
    expect(enemy.length).toBe(1);
    expect(enemy[0]!.fromTile).toBe(`${W}:8:8`);
  });
});
