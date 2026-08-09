// worldsvc stronghold (G8 §3.1) end-to-end: real Mongo + fake clock + captured pushes.
//   Stronghold = a procedurally generated high-strategic-value PvE tile, defended by an overwhelmingly strong NPC;
//   cannot be occupied directly or swept — must be taken via siege attack.
//   ① Attack wins (overwhelming force) → 2026-08-09 (user decision — "nothing transfers instantly after a
//      battle win"): capture no longer lands immediately — the tile enters an OCCUPY_HOLD_SEC occupation
//      hold (contestedBy=attacker, type stays 'stronghold', no ownerId/territoryCount yet), while the
//      one-time rich resource reward + material loot STILL land immediately + sieges attacker_win/tile_update
//      push fire right away; only after the hold elapses (processDueOccupations) does the tile settle into
//      plain territory + ownerId + territoryCount +1;
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
  OCCUPY_HOLD_SEC,
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
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
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

  it('attack wins (overwhelming force): rich reward lands immediately, but capture itself enters an occupation hold — territory/ownerId only land once the hold elapses', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 15_000); // well-developed army (drillYard+5), far exceeds the stronghold garrison (11,500) → guaranteed win
    const before = (await svc.getMe(W, 'a')).resources!;

    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 15_000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    // Stronghold PvE: defender is an NPC, no under_attack push.
    expect(pushes.find((p) => p.msg.kind === 'under_attack')).toBeUndefined();

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09: victory itself does NOT capture instantly — tile enters an occupation hold. Still 'stronghold'
    // (not yet 'territory'), no ownerId, territoryCount unchanged (still just the 3×3 base).
    const held = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(held.mine).toBeUndefined();
    expect(held.contestedByMe).toBe(true);
    expect(held.contestedUntil).toBe(mv.arriveAt + OCCUPY_HOLD_SEC * 1000);
    const rawHeld = await m.collections.tiles.findOne({ _id: tileId(W, sh.x, sh.y) });
    expect(rawHeld?.type).toBe('stronghold');
    expect(rawHeld?.ownerId).toBeUndefined();
    const meMidHold = await svc.getMe(W, 'a');
    expect(meMidHold.territoryCount).toBe(9); // ADR-025: 3×3 capital only — stronghold not landed yet

    // One-time rich reward + material loot are STILL immediate (unaffected by the hold — only the tile hand-off
    // itself is delayed): based on tile level × resource kind.
    const proc = proceduralTile(W, sh.x, sh.y);
    const rt = proc.resType ?? 'ink';
    expect((meMidHold.resources?.[rt] ?? 0) - (before[rt] ?? 0)).toBeGreaterThanOrEqual(
      STRONGHOLD_LOOT_PER_LEVEL * sh.level,
    );
    const expected = strongholdMaterialLoot(sh.level);
    const grant = matGrants.find((g) => g.accountId === 'a');
    expect(grant).toMatchObject({ material: expected.material, qty: expected.qty });
    expect(grant!.orderId).toBe(`stronghold_loot:${W}:${tileId(W, sh.x, sh.y)}:${mv.arriveAt}`);

    // sieges attacker_win (NPC defender → no defenderId) + siege_result pushed to attacker + tile_update — all
    // fire at the moment of victory, not delayed by the hold.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, sh.x, sh.y) });
    expect(siege?.defenderId).toBeUndefined();
    expect(pushes.some((p) => p.msg.kind === 'siege_result' && p.accountId === 'a')).toBe(true);
    expect(pushes.some((p) => p.msg.kind === 'tile_update' && p.accountId === 'a')).toBe(true);

    // Hold elapses → settleOccupation finalizes: stronghold becomes plain territory, ownerId lands, territoryCount +1.
    const occDoc = await m.collections.occupations.findOne({ _id: tileId(W, sh.x, sh.y) });
    expect(occDoc).toMatchObject({ ownerId: 'a', dueAt: held.contestedUntil });
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(10); // ADR-025: 3×3 capital (9 tiles) + captured stronghold (1)
  });

  it('regression: capture reward survives a concurrent resource-changing settlement instead of clobbering or losing it', async () => {
    // Root cause: the one-time capture-reward write used to be a blind $set with no rev filter at all —
    // computed from the `pw` snapshot read at function entry, written after several intervening awaits
    // (including, for a card army, an unconditional cardState rev-bump earlier in the same function). A
    // concurrent settlement for this account (touching a DIFFERENT resource field) landing in that window
    // would have its delta silently overwritten by this call's stale-computed `$set`. The fix re-reads
    // fresh and retries under a rev guard, so both deltas must survive. Simulate the race deterministically
    // via a wrapped `tiles.updateOne` (which runs right before the reward's retry loop starts) instead of
    // relying on true concurrency.
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 15_000);
    const before = (await svc.getMe(W, 'a')).resources!;
    const proc = proceduralTile(W, sh.x, sh.y);
    const rt = proc.resType ?? 'ink';
    const concurrentField = rt === 'graphite' ? 'metal' : 'graphite';

    const realTiles = m.collections.tiles;
    let injected = 0;
    const wrappedTiles = {
      findOne: realTiles.findOne.bind(realTiles),
      find: realTiles.find.bind(realTiles),
      countDocuments: realTiles.countDocuments.bind(realTiles),
      updateOne: async (filter: Parameters<typeof realTiles.updateOne>[0], update: Parameters<typeof realTiles.updateOne>[1], opts?: Parameters<typeof realTiles.updateOne>[2]) => {
        const res = await realTiles.updateOne(filter, update, opts);
        // Simulate a concurrent settlement (e.g. another of this account's own return-march refunds)
        // crediting a DIFFERENT resource field right as the reward's retry loop is about to start — a
        // blind $set of the stale-computed `resources` object would silently erase this delta.
        injected++;
        await m.collections.playerWorld.updateOne(
          { _id: playerWorldId(W, 'a') },
          { $inc: { rev: 1, [`resources.${concurrentField}`]: 500 } },
        );
        return res;
      },
    } as typeof realTiles;
    const svcRaced = new WorldService({
      cols: { ...m.collections, tiles: wrappedTiles },
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });

    const mv = await svcRaced.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 15_000);
    nowMs = mv.arriveAt;
    expect(await svcRaced.processDueArrivals()).toBe(1);

    // Both deltas must have landed: the concurrent settlement's credit to `concurrentField` (not clobbered
    // by the reward write) and the stronghold reward itself (not lost to a rev conflict).
    const me = await svcRaced.getMe(W, 'a');
    expect((me.resources?.[rt] ?? 0) - (before[rt] ?? 0)).toBeGreaterThanOrEqual(STRONGHOLD_LOOT_PER_LEVEL * sh.level);
    expect((me.resources?.[concurrentField] ?? 0) - (before[concurrentField] ?? 0)).toBeGreaterThanOrEqual(500);
    expect(injected).toBe(1); // confirms the race was actually exercised, not skipped
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

  it('overwhelming synthesized army (12,000 troops, beyond synthesizeArmy board capacity of 9,600) still resolves attacker_win via the cheap fallback — not the flaky congested-engine path', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    // 12,000 is past the 10×10 lane×row ×60hp = 9,600 troop board capacity that used to make the real engine
    // congest and time out (defender wins regardless of true strength) — well below the actual max satchel/
    // troopCap a maxed drillYard+satchel allows (20,000, D-CITY-9), but plenty to exercise the overflow guard.
    // Without the SIEGE_CHEAP_RATIO/overflow guard this was non-monotonic (9,000 loses, 9,600 wins, 10,000 loses
    // again); with it, any troop count this large must deterministically win (also now above the 11,500 garrison).
    await setTroops('a', 12_000);
    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 12_000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09: win → occupation hold, not instant capture; settle it before asserting final ownership.
    let tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile.contestedByMe).toBe(true);
    nowMs = tile.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    // 2026-08-01 traceability decision: the cheap linear path still persists replay inputs (so a lopsided/
    // skipped battle stays inspectable afterward) — only a genuine engine crash drops them. Deterministic
    // attacker_win regardless of run-to-run engine congestion is still the actual bug-guard here.
    expect(siege?.seed).toEqual(expect.any(Number));
    expect(siege?.attackerArmy?.length).toBeGreaterThan(0);
  });
});
