// `PlayerWorldDoc.territoryCount` — the mirror that took the third Mongo round trip out of `getMe` (2026-09-15).
//
// `getMe` is the highest-frequency SLG round trip, and it used to end with
// `tiles.countDocuments({ worldId, ownerId })` — an aggregate recomputed on every single read. The whole
// backend shares one Atlas ops/sec bucket (design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md §九), so a
// per-read count that can be maintained on write is worth mirroring onto the player document.
//
// Two properties, and the first one is the point of the change — asserting only that the number is correct
// would pass just as well against the old code, which also returned the correct number:
//   ① `getMe` issues NO `countDocuments` once the mirror exists (the round trip is actually gone);
//   ② the mirror equals the live count after every ownership transition (join / occupy / abandon / relocate).
// Plus the migration path: a document written before this field existed still answers correctly, and pays
// for the live count exactly once.
//
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { proceduralTile, tileId, playerWorldId, baseFootprintCells, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_territory_mirror_test';
const W = 's1-territory-mirror';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.territory-mirror.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const OCCUPIABLE = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

/** A tile the account may claim, far enough from `(sx, sy)`'s own capital to never collide with its footprint. */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
  coordPredicate?: (x: number, y: number) => boolean,
): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (coordPredicate ? coordPredicate(x, y) : predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('getMe territoryCount mirror e2e (2026-09-15)', () => {
  const m = mongo!;
  const ACC = 'mirror-acct';
  const BASE_X = CENTER_X - 40;
  const BASE_Y = CENTER_Y - 40;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend() { /* relocate's coin cost is not what this file is about */ },
    async grant() { /* no-op */ },
  };

  /** What `getMe` used to compute per read, and what the mirror must keep agreeing with. */
  const liveCount = (accountId: string) => m.collections.tiles.countDocuments({ worldId: W, ownerId: accountId });
  const storedCount = async (accountId: string) =>
    (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, accountId) }))?.territoryCount;

  /** Count `countDocuments` calls on the tiles collection while `body` runs. */
  async function countingTiles<T>(body: () => Promise<T>): Promise<{ result: T; calls: number }> {
    const spy = vi.spyOn(m.collections.tiles, 'countDocuments');
    try {
      const result = await body();
      return { result, calls: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * A 3x3 block that is legal to relocate onto once owned. `OCCUPIABLE` on all nine cells is deliberately
   * stricter than worldsvc's own reserved-terrain rule (spawn.ts, not exported) — a strict subset of what it
   * allows, so this picks a valid block without restating that rule and drifting from it.
   */
  function findFreeFootprint(sx: number, sy: number): { x: number; y: number } {
    return findCoord(
      (_t) => false,
      sx,
      sy,
      (x, y) => baseFootprintCells(x, y).every((c) =>
        c.x >= 0 && c.y >= 0 && c.x < SLG_MAP_W && c.y < SLG_MAP_H && OCCUPIABLE(proceduralTile(W, c.x, c.y))),
    );
  }

  /** Hand the account a fully-owned 3x3 without going through occupyTile's garrison economy. */
  async function giveFootprint(accountId: string, cx: number, cy: number): Promise<void> {
    for (const c of baseFootprintCells(cx, cy)) {
      await m.collections.tiles.updateOne(
        { _id: tileId(W, c.x, c.y) },
        { $set: { worldId: W, x: c.x, y: c.y, type: 'territory' as const, level: proceduralTile(W, c.x, c.y).level, ownerId: accountId, garrison: 0, rev: 0 } },
        { upsert: true },
      );
    }
    // The mirror is maintained by the ownership paths, and this bypassed them on purpose — put it back in
    // the state a real nine-tile capture would have left, so the relocate assertion below measures relocate.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { territoryCount: await liveCount(accountId) } },
    );
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      commercial: fakeCommercial,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('getMe reads the mirror instead of counting tiles — the round trip this change exists to remove', async () => {
    await svc.joinWorld(W, ACC, BASE_X, BASE_Y);

    const { result: me, calls } = await countingTiles(() => svc.getMe(W, ACC));

    expect(calls).toBe(0);
    expect(me.territoryCount).toBe(await liveCount(ACC));
  });

  it('seeds the mirror at joinWorld from the 3x3 capital footprint, without a count query', async () => {
    const { calls } = await countingTiles(() => svc.joinWorld(W, ACC, BASE_X, BASE_Y));

    expect(calls).toBe(0);
    expect(await storedCount(ACC)).toBe(9);
    expect(await storedCount(ACC)).toBe(await liveCount(ACC));
  });

  it('tracks occupy → abandon → relocate, staying equal to the live count at every step', async () => {
    await svc.joinWorld(W, ACC, BASE_X, BASE_Y);
    const site = findCoord(OCCUPIABLE, BASE_X + 20, BASE_Y + 20);

    await svc.occupyTile(W, ACC, site.x, site.y);
    expect(await storedCount(ACC)).toBe(10);
    expect(await storedCount(ACC)).toBe(await liveCount(ACC));
    expect((await svc.getMe(W, ACC)).territoryCount).toBe(10);

    await svc.abandonTile(W, ACC, site.x, site.y);
    expect(await storedCount(ACC)).toBe(9);
    expect(await storedCount(ACC)).toBe(await liveCount(ACC));

    // Relocation may only target a 3x3 the account already owns outright (§3.4), so hand it one directly
    // rather than paying for nine occupyTile calls' worth of garrison — the mirror is what is under test,
    // not the occupy path, which the step above already covers.
    const dest = findFreeFootprint(BASE_X + 30, BASE_Y + 30);
    await giveFootprint(ACC, dest.x, dest.y);
    expect(await storedCount(ACC)).toBe(18); // 9 capital + the 9 just handed over

    // Relocating surrenders the old capital's 9 cells and turns the owned block into the new one: 18 -> 9.
    // A mirror maintained anywhere but the post-move scan would still read 18 here.
    await svc.relocateBase(W, ACC, dest.x, dest.y);
    expect(await storedCount(ACC)).toBe(9);
    expect(await storedCount(ACC)).toBe(await liveCount(ACC));
    expect(await m.collections.tiles.findOne({ _id: tileId(W, dest.x, dest.y) })).toMatchObject({ ownerId: ACC, type: 'base' });
  });

  it('a pre-2026-09-15 document (no mirror) still answers correctly, and pays for the live count exactly once', async () => {
    await svc.joinWorld(W, ACC, BASE_X, BASE_Y);
    // Exactly what such a document looks like: everything else present, this one field never written.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, ACC) }, { $unset: { territoryCount: '' } });

    const first = await countingTiles(() => svc.getMe(W, ACC));
    expect(first.result.territoryCount).toBe(9);
    expect(first.calls).toBe(1);

    // The backfill is fire-and-forget, so let it land before asserting it happened.
    await vi.waitFor(async () => expect(await storedCount(ACC)).toBe(9));

    const second = await countingTiles(() => svc.getMe(W, ACC));
    expect(second.result.territoryCount).toBe(9);
    expect(second.calls).toBe(0);
  });

  it('the backfill loses to a concurrent ownership change instead of overwriting it with its stale count', async () => {
    await svc.joinWorld(W, ACC, BASE_X, BASE_Y);
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, ACC) }, { $unset: { territoryCount: '' } });
    const site = findCoord(OCCUPIABLE, BASE_X + 20, BASE_Y + 20);

    // The window the backfill's `{ territoryCount: { $exists: false } }` filter exists for: land a real
    // capture between its count query and its write-back. Injected deterministically rather than raced —
    // the filter is the claim under test, and a real race would only sometimes exercise it.
    let fired = false;
    const real = m.collections.tiles.countDocuments.bind(m.collections.tiles);
    const spy = vi.spyOn(m.collections.tiles, 'countDocuments').mockImplementation((async (...args: unknown[]) => {
      const out = await (real as (...a: unknown[]) => Promise<number>)(...args);
      if (!fired) { fired = true; await svc.occupyTile(W, ACC, site.x, site.y); }
      return out;
    }) as never);
    try {
      // The value this read returns is the count as of the moment it looked — stale by the time it lands,
      // and harmless: the client re-reads, and nothing is written from it.
      expect((await svc.getMe(W, ACC)).territoryCount).toBe(9);
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);

    // What must NOT happen is the fire-and-forget write-back stamping 9 over the capture's 10.
    await vi.waitFor(async () => expect(await liveCount(ACC)).toBe(10));
    expect(await storedCount(ACC)).toBe(10);
    expect((await svc.getMe(W, ACC)).territoryCount).toBe(10);
  });
});
