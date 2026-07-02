// worldsvc stronghold (G8 §3.1) end-to-end: real Mongo + fake clock + captured pushes.
//   Stronghold = a procedurally generated high-strategic-value PvE tile, defended by an overwhelmingly strong NPC;
//   cannot be occupied directly or swept — must be taken via siege attack.
//   ① Attack wins (overwhelming force) → tile becomes a territory (survivors fold back into garrison) +
//      one-time rich resource reward + sieges attacker_win + siege_result/tile_update push + territoryCount +1;
//   ② Attack loses (insufficient troops) → tile not captured (remains an ownerless procedural stronghold) +
//      surviving troops retreat home + sieges defender_win + no reward;
//   ③ Validation: direct occupy / sweep on a stronghold → throws error (must use attack siege);
//      placing a base on a stronghold → throws error.
// Note: troop counts → army formation via synthesizeArmy; survivors determined by engine/fallback;
//       assertions only verify "direction + structural effect".
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
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
const DB = 'nw_world_stronghold_test';
const W = 's1-stronghold';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.stronghold.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Scan the entire map to find the first stronghold tile (procedural, deterministic). */
function findStronghold(): { x: number; y: number; level: number } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      const t = proceduralTile(W, x, y);
      if (t.type === 'stronghold') return { x, y, level: t.level };
    }
  }
  throw new Error('no stronghold tile in world (check SLG_GEN.stronghold* parameters)');
}

/**
 * Nearest placeable capital anchor near the stronghold (ADR-025): the whole 3×3 footprint must be in-bounds
 * and clear of center/obstacle/gate/stronghold (mirrors joinWorld's footprintFree). The footprint constraint
 * naturally keeps the base's cells from overlapping the stronghold-under-test.
 */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 1; r < 60; r++) {
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
  throw new Error('no base tile near stronghold');
}

describe.skipIf(!mongo)('worldsvc stronghold e2e (G8)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  let matGrants: { accountId: string; material: string; qty: number; orderId: string }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  // Capture grantMaterial (verifies stronghold material loot enters the unified progression pool, §19.5 / G4 §15.6).
  const fakeMeta: WorldMetaClient = {
    available: true,
    async deductMaterial() { /* stronghold does not deduct materials */ },
    async grantMaterial(accountId, material, qty, orderId) { matGrants.push({ accountId, material, qty, orderId }); },
    async getProfile() { return null; },
    async getSaveFields() { return null; }, // no equipment snapshot → siege engine degrades to plain troop math (E8)
  };

  const sh = findStronghold();
  const base = findNearbyBase(sh.x, sh.y);

  /** Directly set the attacker's troop pool to the specified value (bypasses training, simulates a well-developed army). */
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
    matGrants = [];
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('stronghold generation: max level + has resource type + garrison far exceeds normal tiles', () => {
    expect(sh.level).toBeGreaterThanOrEqual(1);
    const proc = proceduralTile(W, sh.x, sh.y);
    expect(proc.type).toBe('stronghold');
    expect(proc.resType).toBeDefined();
    expect(strongholdGarrison(sh.level)).toBeGreaterThan(500); // far exceeds GARRISON_PER_TILE
  });

  it('direct occupy / sweep on stronghold → throws error (must use siege attack)', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await expect(svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'occupy', 600)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    await expect(svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'sweep', 600)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
  });

  it('place base on stronghold → throws error (stronghold cannot be a home base landing point)', async () => {
    await expect(svc.joinWorld(W, 'z', sh.x, sh.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('attack wins (overwhelming force): captured as territory mine + surviving garrison + rich reward + sieges attacker_win + push', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 6000); // well-developed army, far exceeds the stronghold garrison → guaranteed win
    const before = (await svc.getMe(W, 'a')).resources!;

    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 6000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    // Stronghold PvE: defender is an NPC, no under_attack push.
    expect(pushes.find((p) => p.msg.kind === 'under_attack')).toBeUndefined();

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Captured → tile becomes a territory.
    const tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(10); // ADR-025: 3×3 capital (9 tiles) + captured stronghold (1)

    // One-time rich reward credited (based on tile level × resource kind).
    const proc = proceduralTile(W, sh.x, sh.y);
    const rt = proc.resType ?? 'ink';
    expect((me.resources?.[rt] ?? 0) - (before[rt] ?? 0)).toBeGreaterThanOrEqual(
      STRONGHOLD_LOOT_PER_LEVEL * sh.level,
    );

    // Additional progression material loot into the unified pool (§19.5 / G4): grantMaterial scales linearly by level, orderId is idempotent.
    const expected = strongholdMaterialLoot(sh.level);
    const grant = matGrants.find((g) => g.accountId === 'a');
    expect(grant).toMatchObject({ material: expected.material, qty: expected.qty });
    expect(grant!.orderId).toBe(`stronghold_loot:${W}:${tileId(W, sh.x, sh.y)}:${mv.arriveAt}`);

    // sieges attacker_win (NPC defender → no defenderId) + siege_result pushed to attacker + tile_update.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, sh.x, sh.y) });
    expect(siege?.defenderId).toBeUndefined();
    expect(pushes.some((p) => p.msg.kind === 'siege_result' && p.accountId === 'a')).toBe(true);
    expect(pushes.some((p) => p.msg.kind === 'tile_update' && p.accountId === 'a')).toBe(true);
  });

  it('attack loses (insufficient troops): not captured + surviving troops retreat home + sieges defender_win + no reward', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 600); // far fewer than the stronghold garrison → guaranteed loss
    const before = (await svc.getMe(W, 'a')).resources!;

    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 600);
    expect((await svc.getMe(W, 'a')).troops).toBe(0); // troops deducted on march (all 600 deployed)

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Not captured: stronghold remains ownerless (procedural layer writes nothing to DB).
    const proc = proceduralTile(W, sh.x, sh.y);
    expect(proc.type).toBe('stronghold');
    const raw = await m.collections.tiles.findOne({ _id: tileId(W, sh.x, sh.y) });
    expect(raw?.ownerId).toBeUndefined();

    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(9); // ADR-025: 3×3 capital only (9 tiles), stronghold not captured
    // No reward (resources settled from own production only, no plunder).
    const proc2 = proceduralTile(W, sh.x, sh.y);
    const rt = proc2.resType ?? 'ink';
    expect((me.resources?.[rt] ?? 0)).toBeLessThan((before[rt] ?? 0) + STRONGHOLD_LOOT_PER_LEVEL);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
    // Attack lost → no material loot.
    expect(matGrants).toHaveLength(0);
  });
});
