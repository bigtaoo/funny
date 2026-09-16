// `territoryCount` across the COMBAT ownership transitions (2026-09-15, audit doc §10.1).
//
// getme-territory-mirror.e2e.test.ts covers the mirror on the paths a player drives themselves — join,
// occupy, abandon, relocate, all in `territory.ts`. It does not touch the other half: the four sites in
// `combatSiege/` where a tile changes hands because someone attacked. Those are the ones spread across five
// files, and they are where a missed field would actually hide — a player watching their own territory
// count is looking at a number that only moves when they are attacked.
//
// Two shapes here, chosen because they are the ones where the count moves in a direction nothing else
// checks:
//   ① a capture writes BOTH accounts in one settlement — attacker +1 and defender −1, from two separate
//      scans, in `combatSiege/damage.ts`;
//   ② `passiveRelocate` wipes the defender's entire territory. Its "no spot found" branch leaves them with
//      literally nothing, so the mirror must reach 0 — the one value a stale mirror can never be.
//
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { proceduralTile, tileId, playerWorldId, baseFootprintCells, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { WorldCore } from '../src/core';
import { SiegeDamageService } from '../src/combatSiege/damage';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_territory_mirror_combat_test';
const W = 's1-territory-mirror-combat';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.territory-mirror-combat.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const OCCUPIABLE = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

function search(sx: number, sy: number, ok: (x: number, y: number) => boolean): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (ok(x, y)) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

const findCoord = (sx: number, sy: number) => search(sx, sy, (x, y) => OCCUPIABLE(proceduralTile(W, x, y)));

/**
 * A capital anchor whose whole 3x3 is plain occupiable ground. `joinWorld` rejects obstacle/crossing terrain
 * under any footprint cell, and which coordinates qualify is a function of the worldId — so a literal that
 * worked in another test file's world is not portable here.
 */
const findBase = (sx: number, sy: number) => search(sx, sy, (x, y) =>
  baseFootprintCells(x, y).every((c) =>
    c.x >= 0 && c.y >= 0 && c.x < SLG_MAP_W && c.y < SLG_MAP_H && OCCUPIABLE(proceduralTile(W, c.x, c.y))));

describe.skipIf(!mongo)('territoryCount across combat ownership transitions (2026-09-15)', () => {
  const m = mongo!;
  const ATK = 'mirror-attacker';
  const DEF = 'mirror-defender';
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let core: WorldCore;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend() { /* no-op */ },
    async grant() { /* no-op */ },
  };

  const liveCount = (accountId: string) => m.collections.tiles.countDocuments({ worldId: W, ownerId: accountId });
  const storedCount = async (accountId: string) =>
    (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, accountId) }))?.territoryCount;

  /** The assertion this whole file exists for: the mirror still equals what a live count would say. */
  async function expectMirrorHonest(accountId: string, expected: number): Promise<void> {
    expect(await storedCount(accountId)).toBe(expected);
    expect(await storedCount(accountId)).toBe(await liveCount(accountId));
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    const deps = {
      cols: m.collections,
      redis: null,
      commercial: fakeCommercial,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    };
    svc = new WorldService(deps);
    core = new WorldCore(deps);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('a capture moves the count on BOTH sides in one settlement (+1 attacker, -1 defender)', async () => {
    const atkBase = findBase(CENTER_X - 40, CENTER_Y - 40);
    const defBase = findBase(CENTER_X + 40, CENTER_Y + 40);
    await svc.joinWorld(W, ATK, atkBase.x, atkBase.y);
    await svc.joinWorld(W, DEF, defBase.x, defBase.y);
    const site = findCoord(CENTER_X + 60, CENTER_Y + 60);
    await svc.occupyTile(W, DEF, site.x, site.y);

    await expectMirrorHonest(ATK, 9);
    await expectMirrorHonest(DEF, 10);

    // A hit big enough to deplete the tile's HP in one settlement → hand-over (damage.ts's capture branch).
    await m.collections.siegeDamage.insertOne({
      _id: 'mirror-siege-1', worldId: W, attackerId: ATK, defenderId: DEF, tile: tileId(W, site.x, site.y),
      isBase: false, damage: 1_000_000, attackerSurvivors: 5, dueAt: nowMs,
    } as never);
    await new SiegeDamageService(core, new SiegeHelpersService(core)).processDueSiegeDamage(nowMs);

    expect(await m.collections.tiles.findOne({ _id: tileId(W, site.x, site.y) })).toMatchObject({ ownerId: ATK });
    await expectMirrorHonest(ATK, 10);
    await expectMirrorHonest(DEF, 9);
  });

  it('passiveRelocate to a fresh capital: territory is surrendered, the mirror lands back on the new 3x3', async () => {
    const defBase = findBase(CENTER_X + 40, CENTER_Y + 40);
    await svc.joinWorld(W, DEF, defBase.x, defBase.y);
    const a = findCoord(CENTER_X + 60, CENTER_Y + 60);
    await svc.occupyTile(W, DEF, a.x, a.y);
    await expectMirrorHonest(DEF, 10);

    await new SiegeHelpersService(core).passiveRelocate(W, DEF, nowMs);

    // Old capital + the captured tile are gone; a brand-new 3x3 replaces them.
    await expectMirrorHonest(DEF, 9);
  });

  it('passiveRelocate with nowhere to put the capital: the mirror reaches 0, the one value a stale one cannot', async () => {
    const defBase = findBase(CENTER_X + 40, CENTER_Y + 40);
    await svc.joinWorld(W, DEF, defBase.x, defBase.y);
    const a = findCoord(CENTER_X + 60, CENTER_Y + 60);
    await svc.occupyTile(W, DEF, a.x, a.y);
    await expectMirrorHonest(DEF, 10);

    // The branch taken when the map has no legal empty tile left. Forced rather than constructed: filling a
    // 1500x1500 map to provoke it honestly would cost more than the branch is worth.
    vi.spyOn(core, 'pickRandomEmptyTile').mockResolvedValue(null);
    try {
      await new SiegeHelpersService(core).passiveRelocate(W, DEF, nowMs);
    } finally {
      vi.restoreAllMocks();
    }

    expect((await m.collections.playerWorld.findOne({ _id: playerWorldId(W, DEF) }))?.mainBaseTile).toBeUndefined();
    await expectMirrorHonest(DEF, 0);
  });
});
