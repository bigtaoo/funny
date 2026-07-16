// worldsvc crossing (bridge / plankway) end-to-end: real Mongo + fake clock + captured pushes.
//   A crossing = a capturable passage building embedded in an impassable mountain/river band (gate→bridge/plankway
//   migration). It replaces the old free-passage 'gate' terrain: to march across the band you must first CAPTURE
//   the crossing (defeat its NPC garrison); an uncaptured crossing blocks like an obstacle.
//   ① Generation: procedural worlds carry both bridge (over river) and plankway (over mountain) crossings, and
//      never the retired 'gate' type; passage garrison sits between an ordinary tile and a stronghold.
//   ② Validation: direct occupy / sweep on a crossing → throws (must use attack siege); base on a crossing → throws.
//   ③ Attack wins → tile KEEPS its bridge/plankway type (stays a passage), gains ownerId (+ familyId when the
//      attacker has a family, so allies get transit), survivors fold into garrison, sieges attacker_win.
//   ④ Attack loses → not captured (remains an ownerless procedural crossing).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  passageGarrison,
  strongholdGarrison,
  npcGarrison,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_passage_test';
const W = 's1-passage';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.passage.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const isOpenTile = (x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) return false;
  const t = proceduralTile(W, x, y).type;
  return t !== 'obstacle' && t !== 'bridge' && t !== 'plankway' && t !== 'center' && t !== 'stronghold';
};

/**
 * Scan for a crossing tile of the given type that has an open orthogonal neighbour (`approach`) — a crossing is
 * a 1-wide strip THROUGH an obstacle band, so a marcher must reach it from that open side. Returning the approach
 * lets the test anchor the attacker's base in the same open region, guaranteeing a march path to the crossing.
 */
function findCrossing(type: 'bridge' | 'plankway'): { x: number; y: number; level: number; approach: { x: number; y: number } } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (proceduralTile(W, x, y).type !== type) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (isOpenTile(x + dx, y + dy)) {
          return { x, y, level: proceduralTile(W, x, y).level, approach: { x: x + dx, y: y + dy } };
        }
      }
    }
  }
  throw new Error(`no ${type} crossing with an open approach in world (check mapgen auto-crossing fallback)`);
}

/** Nearest placeable capital anchor near a crossing (ADR-025): the whole 3×3 footprint must be in-bounds and clear. */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 1; r < 80; r++) {
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
  throw new Error('no base tile near crossing');
}

describe.skipIf(!mongo)('worldsvc crossing (bridge/plankway) e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
    async broadcast(recipients, msg) { for (const accountId of recipients) pushes.push({ accountId, msg }); },
  };
  const fakeMeta: WorldMetaClient = {
    available: true,
    async deductMaterial() {},
    async grantMaterial() {},
    async getProfile() { return null; },
    async getSaveFields() { return null; },
  };

  const bridge = findCrossing('bridge');
  const plankway = findCrossing('plankway');
  const base = findNearbyBase(bridge.approach.x, bridge.approach.y);

  async function setTroops(accountId: string, troops: number): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { troops, troopCap: Math.max(troops, TROOP_CAP_BASE) } },
    );
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({
      cols: m.collections, redis: null, gateway: fakeGateway, meta: fakeMeta,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('generation: world carries bridge + plankway crossings, never the retired gate type; garrison sits between tile and stronghold', () => {
    expect(proceduralTile(W, bridge.x, bridge.y).type).toBe('bridge');
    expect(proceduralTile(W, plankway.x, plankway.y).type).toBe('plankway');
    // Passage garrison is a real chokepoint: harder than an ordinary tile, easier than a stronghold.
    expect(passageGarrison(bridge.level)).toBeGreaterThan(npcGarrison(bridge.level));
    expect(passageGarrison(bridge.level)).toBeLessThan(strongholdGarrison(bridge.level));
    // No 'gate' tiles anywhere (migration is complete).
    let gateCount = 0;
    for (let y = 0; y < SLG_MAP_H; y += 7) for (let x = 0; x < SLG_MAP_W; x += 7) {
      if ((proceduralTile(W, x, y).type as string) === 'gate') gateCount++;
    }
    expect(gateCount).toBe(0);
  });

  it('direct occupy / sweep on a crossing → throws (must use siege attack)', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await expect(svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'occupy', 600)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    await expect(svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'sweep', 600)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('place base on a crossing → throws (crossing cannot be a home base landing point)', async () => {
    await expect(svc.joinWorld(W, 'z', bridge.x, bridge.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('attack wins: crossing KEEPS its bridge type + becomes mine + survivors garrison + sieges attacker_win', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 6000); // overwhelming → guaranteed win over the passage garrison
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 6000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    expect(pushes.find((p) => p.msg.kind === 'under_attack')).toBeUndefined(); // NPC defender

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Captured, but STILL a bridge (a passage), not converted to plain territory.
    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.ownerId).toBe('a');
    expect(raw?.garrison ?? 0).toBeGreaterThan(0);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, bridge.x, bridge.y) });
    expect(siege?.defenderId).toBeUndefined();
  });

  it('attack wins with a family: captured crossing carries familyId (so allies get transit via passableGateKeys)', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { familyId: 'fam-1' } });
    await setTroops('a', 6000);
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 6000);
    nowMs = mv.arriveAt;
    await svc.processDueArrivals();

    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.familyId).toBe('fam-1');
  });

  it('attack loses: crossing not captured, remains an ownerless procedural bridge', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 500); // meets the siege minimum but far below the passage garrison (1800) → guaranteed loss
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 500);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect(proceduralTile(W, bridge.x, bridge.y).type).toBe('bridge');
    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.ownerId).toBeUndefined();
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('overwhelming synthesized army (12,000 troops, beyond synthesizeArmy board capacity of 9,600) still resolves attacker_win via the cheap fallback — not the flaky congested-engine path', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    // Same board-overflow guard as the stronghold test: 12,000 = the max satchel/troopCap a maxed drillYard+satchel
    // allows (D-CITY-9), well past synthesizeArmy's 10 lanes × 16 rows × 60hp = 9,600 troop placement capacity.
    await setTroops('a', 12_000);
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 12_000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.ownerId).toBe('a');

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    // No replay fields persisted → confirms the cheap linear path ran, not the congested real engine.
    expect(siege?.seed).toBeUndefined();
    expect(siege?.attackerArmy).toBeUndefined();
  });
});
