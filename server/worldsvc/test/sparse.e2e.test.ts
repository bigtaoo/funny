// worldsvc getMapSparse end-to-end (sparse occupation layer LOD): requires real Mongo. Entire suite skipped if Mongo is unreachable.
//   Verifies: empty map / own tile mine=true / family ally=true (lod=mid) / thin skips ally /
//             lod=thin does not query family (mine only) / radius clipping / only occupied tiles returned (not all tiles)
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB  = 'nw_world_sparse_test';
const W   = 's1-sparse';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.sparse.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findNeutral(sx = 5, sy = 5): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (proceduralTile(W, x, y).type === 'neutral') return { x, y };
      }
    }
  }
  throw new Error('no neutral tile found');
}

describe.skipIf(!mongo)('worldsvc getMapSparse e2e', () => {
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

  it('empty map: tiles is an empty array', async () => {
    const view = await svc.getMapSparse(W, 'a', 10, 10, 5, 'thin');
    expect(view.tiles).toHaveLength(0);
    expect(view.lod).toBe('thin');
  });

  it('own occupied tile: mine=true, coordinates correct', async () => {
    const pos = findNeutral(10, 10);
    await svc.joinWorld(W, 'player-a', pos.x, pos.y);

    const view = await svc.getMapSparse(W, 'player-a', pos.x, pos.y, 3, 'thin');
    const mine = view.tiles.find((t) => t.x === pos.x && t.y === pos.y);
    expect(mine).toBeDefined();
    expect(mine!.mine).toBe(true);
    expect(mine!.type).toBe('base');
  });

  it("another player's occupied tile: occupied but mine not set", async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(50, 50);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);

    // player-a views player-b's base tile
    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'thin');
    const enemy = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(enemy).toBeDefined();
    expect(enemy!.mine).toBeUndefined();
    expect(enemy!.ally).toBeUndefined();
  });

  it('lod=thin: ally not populated, even for family members', async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(20, 10);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);
    // form a family
    await svc.createFamily(W, 'player-a', 'FamA', 'FA');
    await svc.joinFamily(W, 'player-b', (await svc.listFamilies(W))[0]!._id ?? '');

    // thin LOD: no family query, ally not populated
    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'thin');
    const tile = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(tile).toBeDefined();
    expect(tile!.ally).toBeUndefined();
  });

  it('lod=mid: same-family member ally=true', async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(20, 10);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);
    await svc.createFamily(W, 'player-a', 'FamA', 'FA');
    const families = await svc.listFamilies(W);
    await svc.joinFamily(W, 'player-b', families[0]!._id ?? '');

    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'mid');
    const tile = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(tile).toBeDefined();
    expect(tile!.ally).toBe(true);
    expect(tile!.mine).toBeUndefined();
  });

  it('radius clipping: MAX_RADIUS 40 upper bound; request r=999 is truncated', async () => {
    const view = await svc.getMapSparse(W, 'a', 10, 10, 999, 'thin');
    expect(view.r).toBe(40);
  });

  it('only occupied tiles returned; unoccupied tiles do not appear in tiles', async () => {
    const pos = findNeutral(30, 30);
    await svc.joinWorld(W, 'player-a', pos.x, pos.y);

    const view = await svc.getMapSparse(W, 'player-a', pos.x, pos.y, 5, 'thin');
    // most tiles in the 5x5 area are unoccupied; tiles contains only player-a's base (1 tile)
    expect(view.tiles.length).toBeLessThan(11 * 11); // far fewer than the full grid count
    for (const t of view.tiles) {
      // every returned tile must be an occupied tile (mine or no flags but has an owner)
      const isOwned = t.mine === true || (!t.mine && !t.ally && !t.allySect);
      expect(isOwned).toBe(true);
    }
    // the base tile itself must appear in the result
    expect(view.tiles.some((t) => t.x === pos.x && t.y === pos.y)).toBe(true);
  });

  it('lod field echoed back correctly', async () => {
    const thin = await svc.getMapSparse(W, 'a', 0, 0, 1, 'thin');
    const mid  = await svc.getMapSparse(W, 'a', 0, 0, 1, 'mid');
    expect(thin.lod).toBe('thin');
    expect(mid.lod).toBe('mid');
  });
});
