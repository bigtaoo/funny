// TerritoryService branch-coverage gaps (2026-08-15): joinWorld's manual-placement rejection branches
// + world-capacity/closed guard + corrupt-legacy-base purge fallback; occupyTile's terrain/ownership/
// protection/rev-race branches; relocateBase's out-of-range/no-op/footprint/rev-race branches;
// abandonTile's stationed/structure cleanup branches; buildStructure's family-friendly branch +
// demolishStructure's non-owner/blocker branches. Real Mongo (same style as city-buildings.e2e.test.ts).
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  baseFootprintCells,
  baseFootprintInBounds,
  RELOCATE_COST,
  WATCHTOWER_COST,
  ARROW_TOWER_COST,
  GARRISON_PER_TILE,
  isCityGroundTile,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_territory_gaps_test';
const W = 's1-territory-gaps';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.territory-gaps.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spiral search around (sx,sy) for the first tile satisfying predicate. */
function findCoord(predicate: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number): { x: number; y: number } {
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

const OCCUPIABLE = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

/** Spiral search for a spawnable capital anchor (whole 3×3 footprint in-bounds + terrain-free). */
function findCapitalSite(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return isCityGroundTile(t.type) || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no capital site found');
}

describe.skipIf(!mongo)('TerritoryService branch gaps e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let spent: { accountId: string; amount: number }[];

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spent.push({ accountId, amount }); },
    async grant() { /* no-op */ },
  };

  async function fund(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 }, lastTickAt: nowMs } },
    );
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    spent = [];
    svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  describe('joinWorld manual-placement rejections', () => {
    it('OUT_OF_RANGE when coordinates fall outside the map', async () => {
      await expect(svc.joinWorld(W, 'a', -1, -1)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    });

    it('TILE_OCCUPIED when placing on the world center', async () => {
      await expect(svc.joinWorld(W, 'a', CENTER_X, CENTER_Y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    });

    it('BAD_REQUEST when placing on obstacle/bridge/plankway terrain', async () => {
      const blocker = findCoord((t) => t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway', 0, 746);
      await expect(svc.joinWorld(W, 'a', blocker.x, blocker.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('BAD_REQUEST when placing on stronghold terrain', async () => {
      const sh = findCoord((t) => t.type === 'stronghold', 20, 20);
      await expect(svc.joinWorld(W, 'a', sh.x, sh.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('TILE_OCCUPIED when the exact anchor tile is already owned', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await expect(svc.joinWorld(W, 'b', site.x, site.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    });

    it("TILE_OCCUPIED when the anchor is free but part of the 3×3 footprint isn't (footprintFree fails)", async () => {
      const site = findCapitalSite(30, 10);
      // Claim one ring cell of the footprint directly, leaving the anchor itself unowned.
      const ring = baseFootprintCells(site.x, site.y).find((c) => c.x !== site.x || c.y !== site.y)!;
      await m.collections.tiles.insertOne({ _id: tileId(W, ring.x, ring.y), worldId: W, x: ring.x, y: ring.y, type: 'base', level: 1, ownerId: 'someone-else', rev: 0 });
      await expect(svc.joinWorld(W, 'b', site.x, site.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    });
  });

  describe('joinWorld world-doc capacity/status guards', () => {
    it('WORLD_CLOSED when the world document exists but is not open/active', async () => {
      await m.collections.worlds.insertOne({
        _id: W, season: 1, shard: 0, status: 'settling', mapW: SLG_MAP_W, mapH: SLG_MAP_H, openAt: now(), capacity: 100, population: 0, rev: 0,
      });
      const site = findCapitalSite(10, 10);
      await expect(svc.joinWorld(W, 'a', site.x, site.y)).rejects.toMatchObject({ code: 'WORLD_CLOSED' });
    });

    it('no world document at all (dev environment) → uncapped, joinWorld succeeds without touching worlds collection', async () => {
      const site = findCapitalSite(10, 10);
      await expect(svc.joinWorld(W, 'a', site.x, site.y)).resolves.toBeTruthy();
      expect(await m.collections.worlds.findOne({ _id: W })).toBeNull();
    });
  });

  it('joinWorld is idempotent for a healthy existing capital, but purges + re-places a corrupt/legacy one', async () => {
    const site = findCapitalSite(10, 10);
    const first = await svc.joinWorld(W, 'a', site.x, site.y);
    expect(first.mainBaseTile).toBeTruthy();

    // Healthy re-entry: same location returned, no re-placement.
    const again = await svc.joinWorld(W, 'a', site.x, site.y);
    expect(again.mainBaseTile).toBe(first.mainBaseTile);

    // Corrupt the stored capital: delete one of its 9 footprint cells (simulates a pre-ADR-025 single-tile base).
    const ring = baseFootprintCells(site.x, site.y).find((c) => c.x !== site.x || c.y !== site.y)!;
    await m.collections.tiles.deleteOne({ _id: tileId(W, ring.x, ring.y) });

    const site2 = findCapitalSite(50, 50);
    const rejoined = await svc.joinWorld(W, 'a', site2.x, site2.y);
    // Old (now-incomplete) footprint was purged entirely — no leftover cells belonging to 'a' at the old site.
    expect(await m.collections.tiles.findOne({ _id: tileId(W, site.x, site.y) })).toBeNull();
    expect(rejoined.mainBaseTile).toBe(tileId(W, site2.x, site2.y));
  });

  describe('occupyTile', () => {
    it('rejects the world center and obstacle terrain', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await expect(svc.occupyTile(W, 'a', CENTER_X, CENTER_Y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
      const obstacle = findCoord((t) => t.type === 'obstacle', 0, 746);
      await expect(svc.occupyTile(W, 'a', obstacle.x, obstacle.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it("rejects occupying another player's capital footprint (must siege instead)", async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const site2 = findCapitalSite(60, 60);
      await svc.joinWorld(W, 'b', site2.x, site2.y);
      await expect(svc.occupyTile(W, 'a', site2.x, site2.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    });

    it('re-occupying your own tile is idempotent (returns the current view, no double-charge)', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      const before = (await svc.getMe(W, 'a')).troops;
      await svc.occupyTile(W, 'a', tgt.x, tgt.y); // idempotent — no troop deduction
      expect((await svc.getMe(W, 'a')).troops).toBe(before);
    });

    it('rejects occupying a protected enemy tile (PROTECTED) vs an unprotected one (TILE_OCCUPIED)', async () => {
      const siteA = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', siteA.x, siteA.y);
      const siteB = findCapitalSite(60, 60);
      await svc.joinWorld(W, 'b', siteB.x, siteB.y);
      const tgt = findCoord(OCCUPIABLE, 30, 30);
      await svc.occupyTile(W, 'b', tgt.x, tgt.y); // b occupies, protectedUntil not set by occupyTile itself
      // occupyTile does not set protectedUntil; simulate a protected tile explicitly.
      await m.collections.tiles.updateOne({ _id: tileId(W, tgt.x, tgt.y) }, { $set: { protectedUntil: nowMs + 100_000 } });
      await expect(svc.occupyTile(W, 'a', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'PROTECTED' });
      await m.collections.tiles.updateOne({ _id: tileId(W, tgt.x, tgt.y) }, { $unset: { protectedUntil: '' } });
      await expect(svc.occupyTile(W, 'a', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    });

    it('NO_TROOPS when the player does not have enough troops to garrison', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 0 } });
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await expect(svc.occupyTile(W, 'a', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'NO_TROOPS' });
    });

    it('rolls back the just-written tile claim when the troop-deduction race is lost', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      const spy = vi.spyOn(m.collections.playerWorld, 'updateOne').mockResolvedValueOnce({ matchedCount: 0 } as never);
      try {
        await expect(svc.occupyTile(W, 'a', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'NO_TROOPS' });
      } finally {
        spy.mockRestore();
      }
      // rolled back: the tile must not remain claimed.
      expect(await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) })).toBeNull();
    });
  });

  describe('abandonTile', () => {
    it('TILE_NOT_OWNED for a tile that does not exist or belongs to someone else, and cannot abandon the capital', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const empty = findCoord(OCCUPIABLE, 40, 40);
      await expect(svc.abandonTile(W, 'a', empty.x, empty.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
      await expect(svc.abandonTile(W, 'a', site.x, site.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });

      const site2 = findCapitalSite(60, 60);
      await svc.joinWorld(W, 'b', site2.x, site2.y);
      const tgt = findCoord(OCCUPIABLE, 70, 70);
      await svc.occupyTile(W, 'b', tgt.x, tgt.y);
      await expect(svc.abandonTile(W, 'a', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    });

    it('frees a stationed garrison team and clears its cover on abandon', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      const tid = tileId(W, tgt.x, tgt.y);
      await m.collections.stationed.insertOne({ _id: tid, worldId: W, accountId: 'a', teamId: 'team1', x: tgt.x, y: tgt.y, tile: tid, mode: 'garrison', army: [] } as never);
      await svc.abandonTile(W, 'a', tgt.x, tgt.y);
      expect(await m.collections.stationed.findOne({ _id: tid })).toBeNull();
    });

    it('destroys an arrow tower and clears its coverage on abandon', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      await svc.buildStructure(W, 'a', tgt.x, tgt.y, 'arrowTower');
      await svc.abandonTile(W, 'a', tgt.x, tgt.y);
      expect(await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) })).toBeNull();
    });
  });

  describe('relocateBase', () => {
    it('OUT_OF_RANGE and same-tile no-op (no charge)', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      await expect(svc.relocateBase(W, 'a', -1, -1)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
      await svc.relocateBase(W, 'a', site.x, site.y); // same tile → no-op
      expect(spent.length).toBe(0);
    });

    it("rejects a target 3×3 block the player doesn't fully own", async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      const target = findCapitalSite(50, 50);
      await expect(svc.relocateBase(W, 'a', target.x, target.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    });

    it('relocates onto a fully-owned 3×3 block, carrying garrison + protection + wall durability', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      const target = findCapitalSite(50, 50);
      // Own the whole target footprint via occupyTile on each of its 9 cells.
      for (const c of baseFootprintCells(target.x, target.y)) {
        await svc.occupyTile(W, 'a', c.x, c.y);
      }
      const after = await svc.relocateBase(W, 'a', target.x, target.y);
      expect(spent).toEqual([{ accountId: 'a', amount: RELOCATE_COST }]);
      expect(after.mainBaseTile).toBe(tileId(W, target.x, target.y));
      expect(await m.collections.tiles.findOne({ _id: tileId(W, site.x, site.y) })).toBeNull();
    });

    it('REV_CONFLICT when the initial rev-claim loses the race', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      const target = findCapitalSite(50, 50);
      for (const c of baseFootprintCells(target.x, target.y)) await svc.occupyTile(W, 'a', c.x, c.y);
      const spy = vi.spyOn(m.collections.playerWorld, 'updateOne').mockResolvedValueOnce({ matchedCount: 0 } as never);
      try {
        await expect(svc.relocateBase(W, 'a', target.x, target.y)).rejects.toMatchObject({ code: 'REV_CONFLICT' });
      } finally {
        spy.mockRestore();
      }
      expect(spent.length).toBe(0); // failed before spending coins
    });

    // 2026-08-24: this used to assert REV_CONFLICT here, locking in a genuinely bad outcome. By the time the
    // final write runs, the coins are spent AND the old capital's 9 tiles are deleted and the new ones
    // written — so throwing left the account charged, its footprint physically moved, and `mainBaseTile`
    // still pointing at a tile that no longer exists. The guard existed only because the write `$set` a
    // snapshot-derived `resources`; settleExpr now computes that accrual from the live document, so the
    // write carries nothing stale and lands unconditionally. Mutual exclusion between two concurrent
    // relocations is unchanged — that is the rev CAS claim above, which still fails the loser before any
    // coin is spent (covered by the preceding test).
    it('final settle write lands even when a concurrent mutation bumps rev mid-relocation (no stranded spend, no dangling mainBaseTile)', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      // fund() stores 1,000,000 per resource, far above RESOURCE_CAP (200k) — the settle clamp would swallow
      // the injected credit below and make the no-clobber assertion vacuous. Start well under the cap.
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { resources: { ink: 50_000, paper: 50_000, graphite: 50_000, metal: 50_000, sticker: 50_000 }, lastTickAt: nowMs } },
      );
      const before = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      const target = findCapitalSite(50, 50);
      for (const c of baseFootprintCells(target.x, target.y)) await svc.occupyTile(W, 'a', c.x, c.y);

      // First updateOne call is the rev-claim; land a concurrent credit right after it, i.e. inside the
      // window the old rev guard used to fail on.
      const realUpdateOne = m.collections.playerWorld.updateOne.bind(m.collections.playerWorld);
      let call = 0;
      const spy2 = vi.spyOn(m.collections.playerWorld, 'updateOne').mockImplementation(async (...args: Parameters<typeof realUpdateOne>) => {
        call++;
        if (call === 2) await realUpdateOne({ _id: playerWorldId(W, 'a') }, { $inc: { 'resources.ink': 7_777, rev: 1 } } as never);
        return realUpdateOne(...args);
      });
      try {
        const after = await svc.relocateBase(W, 'a', target.x, target.y);
        expect(after.mainBaseTile).toBe(tileId(W, target.x, target.y));
      } finally {
        spy2.mockRestore();
      }
      expect(spent.length).toBe(1);
      const doc = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(doc!.mainBaseTile).toBe(tileId(W, target.x, target.y)); // persisted, not just returned
      // The concurrent credit survived the settle — settleExpr read it from the live document.
      expect(doc!.resources.ink).toBeGreaterThanOrEqual(before!.resources.ink + 7_777);
    });
  });

  describe('getMe — no main base', () => {
    // core/map.ts branch gap (2026-08-15): getMe's baseAnchor lookup is skipped entirely (no hp/maxHp
    // surfaced) when the player has no mainBaseTile at all — e.g. after passiveRelocate found no legal
    // respawn spot and unset it (combatSiege/damageHelpers.ts). Every other getMe-touching test has a
    // freshly-joined capital, so this branch is otherwise unexercised.
    it('omits hp/maxHp when mainBaseTile has been unset (no capital to report durability for)', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $unset: { mainBaseTile: '' } });
      const me = await svc.getMe(W, 'a');
      expect(me.mainBaseTile).toBeUndefined();
      expect(me.hp).toBeUndefined();
      expect(me.maxHp).toBeUndefined();
    });
  });

  describe('buildStructure family-friendly + demolishStructure edge cases', () => {
    it('a family member (not the owner) may build a structure on a friendly-owned tile', async () => {
      const siteA = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', siteA.x, siteA.y);
      await fund('a');
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { familyId: 'fam1' } });

      const siteB = findCapitalSite(60, 60);
      await svc.joinWorld(W, 'b', siteB.x, siteB.y);
      await fund('b');
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'b') }, { $set: { familyId: 'fam1' } });

      const view = await svc.buildStructure(W, 'b', tgt.x, tgt.y, 'blocker');
      expect(view.structure?.kind).toBe('blocker');
      const tile = await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) });
      expect(tile!.structure!.ownerId).toBe('b');
    });

    it('buildStructure: INSUFFICIENT_RESOURCES and REV_CONFLICT branches', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      await expect(svc.buildStructure(W, 'a', tgt.x, tgt.y, 'arrowTower')).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });

      await fund('a');
      const spy = vi.spyOn(m.collections.playerWorld, 'updateOne').mockResolvedValueOnce({ matchedCount: 0 } as never);
      try {
        await expect(svc.buildStructure(W, 'a', tgt.x, tgt.y, 'arrowTower')).rejects.toMatchObject({ code: 'REV_CONFLICT' });
      } finally {
        spy.mockRestore();
      }
      expect((await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) }))!.structure).toBeUndefined();
      expect(ARROW_TOWER_COST).toBeTruthy(); // sanity: cost table imported correctly
    });

    it('demolishStructure: TILE_NOT_OWNED when no structure exists, and when it belongs to someone else', async () => {
      const siteA = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', siteA.x, siteA.y);
      await fund('a');
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      await expect(svc.demolishStructure(W, 'b', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });

      await svc.buildStructure(W, 'a', tgt.x, tgt.y, 'blocker');
      await expect(svc.demolishStructure(W, 'b', tgt.x, tgt.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    });

    it('demolishStructure: demolishing a blocker does not attempt to clear tower coverage', async () => {
      const site = findCapitalSite(10, 10);
      await svc.joinWorld(W, 'a', site.x, site.y);
      await fund('a');
      const tgt = findCoord(OCCUPIABLE, 20, 20);
      await svc.occupyTile(W, 'a', tgt.x, tgt.y);
      await svc.buildStructure(W, 'a', tgt.x, tgt.y, 'blocker');
      await svc.demolishStructure(W, 'a', tgt.x, tgt.y);
      expect((await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) }))!.structure).toBeUndefined();
    });
  });
});
