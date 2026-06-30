// worldsvc vision/fog end-to-end (G5-1, §8.2 / §15.2 G5): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Fog model 2a: terrain layer visible across the whole map; dynamic layer (ownership/garrison/shield) only visible within
//   current vision; falls back to procedural terrain outside vision.
//   Vision sources = own territories/home base + same-family member territories (shared) + marches in transit. getMap / getTile use the same gate.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_BASE_RADIUS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_fog_test';
const W = 's1-fog';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.fog.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spirally search around (sx,sy) for a tile satisfying predicate (deterministic). */
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

describe.skipIf(!mongo)('worldsvc fog/vision e2e (G5)', () => {
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

  it('within vision: own home base and surrounding dynamic layer visible (visible:true + mine + type:base)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const view = await svc.getMap(W, 'a', 5, 5, 2);
    const base = view.tiles.find((t) => t.x === 5 && t.y === 5)!;
    expect(base).toMatchObject({ type: 'base', mine: true, occupied: true, visible: true });
    // Surrounding tiles (within base vision radius) are also visible:true.
    expect(view.tiles.every((t) => t.visible === true)).toBe(true);
  });

  it('outside vision: distant enemy territory fully hidden (visible:false + falls back to procedural terrain, no owner/occupied)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Enemy e settles at (200,200), far beyond a's base vision radius.
    await svc.joinWorld(W, 'e', 200, 200);

    const view = await svc.getMap(W, 'a', 200, 200, 2);
    const enemyBase = view.tiles.find((t) => t.x === 200 && t.y === 200)!;
    // Key: enemy home base is outside vision → "occupied" status not exposed; type falls back to procedural base (not 'base'/'territory').
    const proc = proceduralTile(W, 200, 200);
    expect(enemyBase.visible).toBe(false);
    expect(enemyBase.type).toBe(proc.type);
    expect(enemyBase.occupied).toBeUndefined();
    expect(enemyBase.mine).toBeUndefined();
    expect(enemyBase.ownerPublicId).toBeUndefined();
    expect(enemyBase.garrison).toBeUndefined();
    // But the terrain layer (type/level) is still returned as-is (model 2a: terrain is not a secret).
    expect(enemyBase.level).toBe(proc.level);
  });

  it('getTile same gate: enemy tile outside vision also returns only procedural terrain (prevents getMap bypass)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 200, 200);
    const tile = await svc.getTile(W, 'a', 200, 200);
    expect(tile.visible).toBe(false);
    expect(tile.mine).toBeUndefined();
    expect(tile.occupied).toBeUndefined();
    expect(tile.type).toBe(proceduralTile(W, 200, 200).type);
  });

  it('family shared vision: distant territory of a same-family member is visible to me (occupied but not mine)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'mate', 250, 250); // distant, beyond a's base vision range
    // Write familyMembers directly: a and mate are in the same family (computeVisionSources looks up members from this).
    const fam = 'fam-1';
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:a`, worldId: W, accountId: 'a', familyId: fam, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:mate`, worldId: W, accountId: 'mate', familyId: fam, role: 'member', joinedAt: nowMs },
    ]);

    const view = await svc.getMap(W, 'a', 250, 250, 2);
    const mateBase = view.tiles.find((t) => t.x === 250 && t.y === 250)!;
    expect(mateBase).toMatchObject({ type: 'base', occupied: true, visible: true, ally: true });
    expect(mateBase.mine).toBeUndefined(); // belongs to ally, not me (ally=true tells the client to use ally color instead of enemy color)

    // Control: non-family e (distant) is still fogged.
    await svc.joinWorld(W, 'e', 280, 280);
    const v2 = await svc.getMap(W, 'e', 250, 250, 2); // from e's perspective, mate's base → fog
    expect(v2.tiles.find((t) => t.x === 250 && t.y === 250)!.visible).toBe(false);
  });

  it('march in transit illuminates path: tiles near the mid-march position are visible even outside base vision', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // March south to a distant neutral tile (outside base vision radius).
    const dst = findCoord(NEUTRAL, 5, 40);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', 500);

    // Advance to the midpoint of the march: interpolated position is far from the base (y well beyond 5+VISION_BASE_RADIUS).
    nowMs = Math.floor((mv.departAt + mv.arriveAt) / 2);
    const midY = Math.round(5 + (dst.y - 5) * 0.5);
    expect(midY).toBeGreaterThan(5 + VISION_BASE_RADIUS); // confirm it is truly outside base vision

    const view = await svc.getMap(W, 'a', dst.x, midY, 1);
    const here = view.tiles.find((t) => t.x === dst.x && t.y === midY)!;
    expect(here.visible).toBe(true); // march vision illuminates the tile

    // Control: tiles outside march vision radius and outside base vision remain fogged.
    const far = await svc.getMap(W, 'a', dst.x, midY + 20, 1);
    expect(far.tiles.find((t) => t.x === dst.x && t.y === midY + 20)!.visible).toBe(false);
    void (mv as { marchId: string });
  });
});
