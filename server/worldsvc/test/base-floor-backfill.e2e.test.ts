// ADR-093 startup repair e2e: backfillBaseFloorYield re-derives the stored yieldRate of players who joined before
// the home-city paper/graphite/metal floor existed. Real Mongo; skipped if unreachable.
//   • a legacy player gets the floor, banked at the OLD rate first (no retroactive grant);
//   • the floor is multiplied like the rest of the capital's yield (battle pass here);
//   • a player whose stored rate is already right is not written; closed worlds are not touched;
//   • the world is stamped, so the second run scans nothing.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerWorldId,
  tileYield,
  SLG_MAP_W,
  SLG_MAP_H,
  RESOURCE_YIELD_BASE,
  BASE_FLOOR_YIELD,
  BP_YIELD_MULT,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type WorldDoc } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_basefloor_test';
const W = 's3-floor';
const CLOSED = 's2-floor';
const HOUR = 3_600_000;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.base-floor-backfill.e2e] Mongo unreachable (${URI}) — skipping.`);

/** The stored rate every player had before ADR-093: the capital paid ink only. */
const LEGACY_RATE = { ink: RESOURCE_YIELD_BASE, paper: 0, graphite: 0, metal: 0, sticker: 0 };

describe.skipIf(!mongo)('worldsvc backfillBaseFloorYield e2e (ADR-093)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  let svc: WorldService;

  const world = (id: string, status: WorldDoc['status']): WorldDoc => ({
    _id: id, season: 3, shard: 0, status, mapW: SLG_MAP_W, mapH: SLG_MAP_H, openAt: 1, capacity: 100, population: 0, rev: 0,
  });
  const pw = (worldId: string, acct: string) => m.collections.playerWorld.findOne({ _id: playerWorldId(worldId, acct) });
  /** Rewind a freshly joined player to the pre-ADR-093 stored rate, as every live player still has it. */
  const makeLegacy = (worldId: string, acct: string) =>
    m.collections.playerWorld.updateOne({ _id: playerWorldId(worldId, acct) }, { $set: { yieldRate: { ...LEGACY_RATE } } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => nowMs });
    await m.collections.worlds.insertMany([world(W, 'active'), world(CLOSED, 'closed')]);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('a fresh join already carries the floor (the repair is only for players who predate it)', async () => {
    const me = await svc.joinWorld(W, 'fresh', 20, 20);
    expect(me.yieldRate).toMatchObject({ ink: RESOURCE_YIELD_BASE, paper: BASE_FLOOR_YIELD, graphite: BASE_FLOOR_YIELD, metal: BASE_FLOOR_YIELD });
    expect(me.yieldRate?.sticker ?? 0).toBe(0);
  });

  it('repairs legacy players once, without paying the floor retroactively, and skips what is already right', async () => {
    await svc.joinWorld(W, 'legacy', 20, 20);
    await svc.joinWorld(W, 'bp', 40, 40);
    await svc.joinWorld(W, 'ok', 60, 60);
    // Join while the world was still running, then close it (joinWorld refuses a closed world).
    await m.collections.worlds.updateOne({ _id: CLOSED }, { $set: { status: 'active' } });
    await svc.joinWorld(CLOSED, 'gone', 20, 20);
    await m.collections.worlds.updateOne({ _id: CLOSED }, { $set: { status: 'closed' } });
    await makeLegacy(W, 'legacy');
    await makeLegacy(W, 'bp');
    await makeLegacy(CLOSED, 'gone');
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'bp') }, { $set: { hasBattlePass: true } });
    const okRev = (await pw(W, 'ok'))!.rev;

    nowMs += 2 * HOUR; // two hours at the legacy rate before the repair runs
    expect(await svc.backfillBaseFloorYield()).toEqual([{ worldId: W, updated: 2 }]);

    const legacy = (await pw(W, 'legacy'))!;
    expect(legacy.yieldRate).toMatchObject(tileYield('base', 1));
    // Banked at the OLD rate: two hours of ink, and no paper/graphite/metal for the time before the repair.
    expect(legacy.resources).toMatchObject({ ink: 2 * RESOURCE_YIELD_BASE, paper: 0, graphite: 0, metal: 0 });
    expect(legacy.lastTickAt).toBe(nowMs);

    // The floor is part of the capital's yield, so it takes the same multipliers (here the battle pass).
    const bp = (await pw(W, 'bp'))!;
    expect(bp.yieldRate.metal).toBe(Math.floor(BASE_FLOOR_YIELD * BP_YIELD_MULT));
    expect(bp.yieldRate.ink).toBe(Math.floor(RESOURCE_YIELD_BASE * BP_YIELD_MULT));

    expect((await pw(W, 'ok'))!.rev).toBe(okRev); // already correct → not written
    expect((await pw(CLOSED, 'gone'))!.yieldRate).toEqual(LEGACY_RATE); // closed world → left alone
    expect((await m.collections.worlds.findOne({ _id: W }))!.baseFloorYieldAt).toBe(nowMs);

    // From here on the floor accrues like any other yield.
    nowMs += HOUR;
    expect((await svc.getMe(W, 'legacy')).resources).toMatchObject({ paper: BASE_FLOOR_YIELD, graphite: BASE_FLOOR_YIELD, metal: BASE_FLOOR_YIELD });

    // Stamped: a restart does not rescan the world, even if a stale rate somehow reappeared.
    await makeLegacy(W, 'legacy');
    expect(await svc.backfillBaseFloorYield()).toEqual([]);
    expect((await pw(W, 'legacy'))!.yieldRate).toEqual(LEGACY_RATE);
  });

  it('an unstamped world whose players are all current is stamped with nothing written (crash-resume / newer world)', async () => {
    await svc.joinWorld(W, 'ok', 20, 20);
    const rev = (await pw(W, 'ok'))!.rev;
    expect(await svc.backfillBaseFloorYield()).toEqual([{ worldId: W, updated: 0 }]);
    expect((await pw(W, 'ok'))!.rev).toBe(rev);
  });
});
