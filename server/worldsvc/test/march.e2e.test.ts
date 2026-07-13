// worldsvc march end-to-end (S8-2): real dedicated Mongo DB + fake clock + captured push messages.
//   Troop deduction on departure / travel time / arrival occupation (writes territory + yield rate) / arrival reinforcement (adds garrison) /
//   recall return leg + troop refund / occupation validation (non-owned tile / center / already occupied) / target occupied on arrival → refund troops / march_update+tile_update push.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  findMarchPath,
  MARCH_SPEED_SEC_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  TROOP_CAP_BASE,
  npcGarrison,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_march_test';
const W = 's1-march';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.march.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spiral search for the first tile satisfying predicate (deterministic). */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
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

describe.skipIf(!mongo)('worldsvc march e2e', () => {
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
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('occupy march: deduct troops on departure + travel time + write territory on arrival + yield rate increases + push', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Low-level target + a comfortable troop margin over npcGarrison(level) (same convention as the siege e2e
    // sweep test: `npc + 600`) so the ADR-037 PvE battle (real deterministic engine, not a linear formula) reliably favors the attacker.
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
    const procT = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(procT.level);
    const troops = npc + 600;
    const expectedPath = findMarchPath(W, SLG_MAP_W, SLG_MAP_H, 5, 5, target.x, target.y, new Set());

    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', troops);
    expect(mv).toMatchObject({ kind: 'occupy', status: 'marching', troops });
    expect(mv.arriveAt).toBe(nowMs + (expectedPath!.length - 1) * MARCH_SPEED_SEC_PER_TILE * 1000);
    expect(mv.fromTile).toBe(tileId(W, 5, 5));
    expect(mv.toTile).toBe(tileId(W, target.x, target.y));

    // Troops deducted on departure (in transit).
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - troops);
    // march_update pushed immediately on departure.
    expect(pushes.some((p) => p.msg.kind === 'march_update' && p.msg.status === 'marching')).toBe(true);

    // Not arrived yet: no processing result, target tile still neutral.
    nowMs = mv.arriveAt - 1000;
    expect(await svc.processDueArrivals()).toBe(0);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();

    // Arrived: ADR-037 (§5.4) — occupy now fights the tile's system garrison (npcGarrison(level)) via the same
    // deterministic engine as siege; victory starts an occupation hold rather than writing ownership immediately.
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.mine).toBeUndefined();
    expect(held.occupied).toBeUndefined();
    expect(held.contestedByMe).toBe(true);
    expect(held.contestedUntil).toBeGreaterThan(nowMs);

    // Committed troops (minus any battle casualties) are neither a garrison yet nor refunded — they're holding the tile.
    let me = await svc.getMe(W, 'a');
    expect(me.troops).toBe(TROOP_CAP_BASE - troops);

    // Hold elapses: ownership is finalized with the battle's surviving troops as garrison.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const tile = await svc.getTile(W, 'a', target.x, target.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true, occupied: true });
    expect(tile.garrison).toBeGreaterThan(0);
    expect(tile.garrison).toBeLessThanOrEqual(troops);

    me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(10); // ADR-025: 9 base footprint cells + 1 marched-and-occupied tile
    // Troops converted to garrison; pool unchanged (still deducted).
    expect(me.troops).toBe(TROOP_CAP_BASE - troops);
    const rt = procT.resType!;
    expect(me.yieldRate?.[rt]).toBeGreaterThan(0);

    // Arrival pushes march_update(arrived) + tile_update.
    expect(pushes.some((p) => p.msg.kind === 'march_update' && p.msg.status === 'arrived')).toBe(true);
    expect(pushes.some((p) => p.msg.kind === 'tile_update')).toBe(true);
    // Transient march document has been deleted.
    expect(await m.collections.marches.findOne({ _id: mv.marchId })).toBeNull();
  });

  it('reinforce march: adds garrison to own tile on arrival (troops not returned to pool)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const terr = findCoord((t) => t.type === 'resource', 30, 30);
    await svc.occupyTile(W, 'a', terr.x, terr.y); // direct occupy to create one owned territory (garrison=500)
    const before = (await svc.getMe(W, 'a')).troops;

    const mv = await svc.startMarch(W, 'a', 5, 5, terr.x, terr.y, 'reinforce', 300);
    expect((await svc.getMe(W, 'a')).troops).toBe(before - 300); // troops deducted on departure

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const tile = await svc.getTile(W, 'a', terr.x, terr.y);
    expect(tile.garrison).toBe(GARRISON_PER_TILE + 300); // added to garrison
    expect((await svc.getMe(W, 'a')).troops).toBe(before - 300); // troops not returned to pool
    void mv;
  });

  it('recall: return leg + troops refunded to pool on arrival', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 40, 40);
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    nowMs += Math.floor((mv.arriveAt - nowMs) / 2); // recall halfway through the march
    const back = await svc.recallMarch(W, 'a', mv.marchId);
    expect(back.kind).toBe('return');
    expect(back.fromTile).toBe(mv.toTile);
    expect(back.toTile).toBe(mv.fromTile);

    // Return leg in transit: troops still en route.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - OCCUPY_MIN_TROOPS);
    nowMs = back.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    // Troops returned to pool; target tile not occupied.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();
  });

  it('validation: departing from non-owned tile / center / already own / insufficient troops / siege type', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Departing from a non-owned tile.
    await expect(svc.startMarch(W, 'a', 50, 50, 51, 51, 'occupy', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // Targeting the world center.
    await expect(svc.startMarch(W, 'a', 5, 5, CENTER_X, CENTER_Y, 'occupy', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // Occupy with fewer troops than OCCUPY_MIN_TROOPS.
    const free = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 30, 30);
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'occupy', 10)).rejects.toMatchObject({
      code: 'NO_TROOPS',
    });
    // Siege against an unowned tile → TILE_NOT_OWNED (siege S8-3 is implemented; target must be another player's territory; use occupy/sweep for neutral tiles).
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // Reinforce a non-owned tile.
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'reinforce', 100)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
  });

  it('target already occupied by another player on arrival → refund troops (no capture, S8-3)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 40, 40);
    const mv2 = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    // While march is in transit, b directly occupies the tile (simulating protection period expired: write another player's territory directly).
    await m.collections.tiles.insertOne({
      _id: tileId(W, target.x, target.y),
      worldId: W,
      x: target.x,
      y: target.y,
      type: 'territory',
      level: 1,
      ownerId: 'b',
      garrison: GARRISON_PER_TILE,
      rev: 0,
    });

    nowMs = mv2.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    // a failed to capture; troops returned to pool; tile still belongs to b.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();
  });
});
