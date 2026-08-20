// worldsvc crossing (bridge / plankway) end-to-end: real Mongo + fake clock + captured pushes.
//   A crossing = a capturable passage building embedded in an impassable mountain/river band (gate→bridge/plankway
//   migration). It replaces the old free-passage 'gate' terrain: to march across the band you must first CAPTURE
//   the crossing (defeat its NPC garrison); an uncaptured crossing blocks like an obstacle.
//   ① Generation: procedural worlds carry both bridge (over river) and plankway (over mountain) crossings, and
//      never the retired 'gate' type; passage garrison sits between an ordinary tile and a stronghold.
//   ② Validation: direct occupy / sweep on a crossing → throws (must use attack siege); base on a crossing → throws.
//   ③ Attack wins → 2026-08-09 (user decision — "nothing transfers instantly after a battle win"): capture no
//      longer lands immediately — enters an OCCUPY_HOLD_SEC occupation hold (same machinery as ADR-037 §5.4's
//      neutral-land occupy); only once the hold elapses (processDueOccupations) does the tile settle — and it
//      settles by KEEPING its bridge/plankway type (never becomes plain territory, unlike every other capture),
//      gaining ownerId (+ familyId when the attacker has a family, so allies get transit) and survivors folded
//      into garrison; sieges attacker_win still fires at the moment of victory, unaffected by the hold.
//   ④ Attack loses → not captured (remains an ownerless procedural crossing).
//   ⑤ A player-OWNED crossing can also be PvP-attacked by another player (writeContestedHold with a defenderId):
//      same hold mechanics, defender loses ownerId/yield right away, winner's claim confirms after the hold —
//      and, same as the PvE case, settlement keeps the crossing type instead of turning it into territory.
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
  OCCUPY_HOLD_SEC,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_passage_test';
const W = 's1-passage';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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
 * `approach2` (2026-08-09, PvP-on-owned-crossing test) is a SECOND open neighbor on the opposite side of the
 * band, when one exists — a crossing connects two regions, so a second player can anchor a base on the far
 * side without overlapping the first player's base footprint near `approach`.
 */
function findCrossing(type: 'bridge' | 'plankway'): { x: number; y: number; level: number; approach: { x: number; y: number }; approach2?: { x: number; y: number } } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (proceduralTile(W, x, y).type !== type) continue;
      const opens: { x: number; y: number }[] = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (isOpenTile(x + dx, y + dy)) opens.push({ x: x + dx, y: y + dy });
      }
      if (opens.length > 0) {
        return { x, y, level: proceduralTile(W, x, y).level, approach: opens[0]!, ...(opens[1] ? { approach2: opens[1] } : {}) };
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
    async grantMaterial() {},
    async getProfile() { return null; },
    async getSaveFields() { return null; },
    batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
    grantTitle: () => { throw new Error('fake WorldMetaClient.grantTitle() is not stubbed in this test'); },
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

  it('attack wins: enters an occupation hold (still bridge, no owner yet); once the hold elapses, crossing KEEPS its bridge type + becomes mine + survivors garrison + sieges attacker_win fired at victory', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 15_000); // overwhelming (drillYard+5) → guaranteed win over the passage garrison (10,440)
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 15_000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    expect(pushes.find((p) => p.msg.kind === 'under_attack')).toBeUndefined(); // NPC defender

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09: win → occupation hold, not instant capture. Tile stays a bridge, no ownerId yet.
    const held = await svc.getTile(W, 'a', bridge.x, bridge.y);
    expect(held.mine).toBeUndefined();
    expect(held.contestedByMe).toBe(true);
    expect(held.contestedUntil).toBe(mv.arriveAt + OCCUPY_HOLD_SEC * 1000);
    const rawHeld = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(rawHeld?.type).toBe('bridge');
    expect(rawHeld?.ownerId).toBeUndefined();

    // sieges attacker_win fires at the moment of victory, unaffected by the hold.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, bridge.x, bridge.y) });
    expect(siege?.defenderId).toBeUndefined();

    // Hold elapses → settleOccupation finalizes: MUST still be 'bridge' (a passage), not flipped to plain
    // territory like every other capture — this is the core regression this test guards against.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.ownerId).toBe('a');
    expect(raw?.garrison ?? 0).toBeGreaterThan(0);
  });

  it('attack wins with a family: captured crossing carries familyId (so allies get transit via passableGateKeys), still a bridge after the hold settles', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { familyId: 'fam-1' } });
    await setTroops('a', 15_000);
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 15_000);
    nowMs = mv.arriveAt;
    await svc.processDueArrivals();

    const held = await svc.getTile(W, 'a', bridge.x, bridge.y);
    expect(held.contestedByMe).toBe(true);
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);

    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.familyId).toBe('fam-1');
  });

  it('attack loses: crossing not captured, remains an ownerless procedural bridge', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 500); // meets the siege minimum but far below the passage garrison (10,440) → guaranteed loss
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
    // Same board-overflow guard as the stronghold test: 12,000 is past synthesizeArmy's 10 lanes × 16 rows ×
    // 60hp = 9,600 troop placement capacity (well below the actual max satchel/troopCap a maxed drillYard+
    // satchel allows, 20,000, D-CITY-9) — plenty to exercise the overflow guard and beat the 10,440 garrison.
    await setTroops('a', 12_000);
    const mv = await svc.startMarch(W, 'a', base.x, base.y, bridge.x, bridge.y, 'attack', 12_000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09: win → occupation hold, not instant capture; settle it before asserting final ownership.
    const held = await svc.getTile(W, 'a', bridge.x, bridge.y);
    expect(held.contestedByMe).toBe(true);
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);

    const raw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(raw?.type).toBe('bridge');
    expect(raw?.ownerId).toBe('a');

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    // 2026-08-01 traceability decision: the cheap linear path still persists replay inputs (so a lopsided/
    // skipped battle stays inspectable afterward) — only a genuine engine crash drops them. Deterministic
    // attacker_win regardless of run-to-run engine congestion is still the actual bug-guard here.
    expect(siege?.seed).toEqual(expect.any(Number));
    expect(siege?.attackerArmy?.length).toBeGreaterThan(0);
  });

  it('PvP: a player-owned crossing can be attacked by another player — enters an occupation hold (defender loses ownerId/yield right away), and settles back into the SAME crossing type (never plain territory) once the hold elapses', async () => {
    // Fabricate 'a' already owning the bridge (as if a PvE capture had already settled earlier) — mirrors
    // siege.e2e.test.ts's setupDefender convention (direct TileDoc/PlayerWorldDoc writes, bypassing the PvE
    // capture flow itself, which is already covered by the tests above).
    const aGarrison = 500;
    const aTile: TileDoc = {
      _id: tileId(W, bridge.x, bridge.y),
      worldId: W,
      x: bridge.x,
      y: bridge.y,
      type: 'bridge',
      level: bridge.level,
      ownerId: 'a',
      garrison: aGarrison,
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: aTile._id }, { $set: aTile }, { upsert: true });
    const aPw: PlayerWorldDoc = {
      _id: playerWorldId(W, 'a'),
      worldId: W,
      accountId: 'a',
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { ink: 1000, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: nowMs,
      mainBaseTile: tileId(W, bridge.x, bridge.y),
      rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: aPw._id }, { $set: aPw }, { upsert: true });
    const aRevBefore = (await m.collections.playerWorld.findOne({ _id: aPw._id }))!.rev;

    // b's own base directly borders the bridge from the OTHER open side (approach2) — real ADR-039
    // connectivity via its own capital footprint, same as every other attacker in this file, no test-only
    // occupyTile shortcut needed. (approach2 is guaranteed for this world's bridge fixture — asserted below.)
    expect(bridge.approach2).toBeDefined();
    const baseB = findNearbyBase(bridge.approach2!.x, bridge.approach2!.y);
    await svc.joinWorld(W, 'b', baseB.x, baseB.y);
    await setTroops('b', 15_000); // overwhelming vs a's 500 garrison

    const mv = await svc.startMarch(W, 'b', baseB.x, baseB.y, bridge.x, bridge.y, 'attack', 15_000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    // PvP target (unlike the NPC-defended tests above): departure pushes an under_attack warning to a — fired
    // via a fire-and-forget getProfile().then(...) chain (this file's shared `svc` has meta.available=true,
    // unlike other suites' meta-less default), so flush pending microtasks before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'under_attack' && p.msg.tile === tileId(W, bridge.x, bridge.y))).toBe(true);

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Win → occupation hold (writeContestedHold with defenderId='a'): tile stays 'bridge', contestedBy=b,
    // ownerId cleared — a no longer owns it, but b's claim hasn't landed yet either.
    const held = await svc.getTile(W, 'b', bridge.x, bridge.y);
    expect(held.mine).toBeUndefined();
    expect(held.contestedByMe).toBe(true);
    const rawHeld = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(rawHeld?.type).toBe('bridge'); // pre-capture look preserved through the hold, same as every other crossing capture
    expect(rawHeld?.contestedBy).toBe('b');
    expect(rawHeld?.ownerId).toBeUndefined();
    const occDoc = await m.collections.occupations.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(occDoc).toMatchObject({ ownerId: 'b', dueAt: held.contestedUntil });
    expect(occDoc?.type).toBe('bridge'); // settleType carried on the OccupationDoc too — settlement must keep it a passage

    // a's yield is recomputed (and the doc's rev bumped) right away — losing the tile's yield the instant it
    // loses the battle, even though b's claim is still pending (writeContestedHold's defenderId branch).
    const aAfterLoss = await m.collections.playerWorld.findOne({ _id: aPw._id });
    expect(aAfterLoss!.rev).toBeGreaterThan(aRevBefore);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'b' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', defenderId: 'a', tile: tileId(W, bridge.x, bridge.y) });

    // Hold elapses → settleOccupation finalizes: MUST still be 'bridge' (never plain territory), ownerId now b.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const finalRaw = await m.collections.tiles.findOne({ _id: tileId(W, bridge.x, bridge.y) });
    expect(finalRaw?.type).toBe('bridge');
    expect(finalRaw?.ownerId).toBe('b');
    expect(finalRaw?.garrison ?? 0).toBeGreaterThan(0);
  });
});
