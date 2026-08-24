// Regression coverage for the 2026-08-24 "unguarded playerWorld write" sweep (the follow-up to that day's
// earlier REV_CONFLICT fix — see claudedocs/server.md "SLG worldsvc 要点").
//
// Auditing all 40 `cols.playerWorld` write sites left five that were genuinely harmful: they published an
// ABSOLUTE, snapshot-derived value with no guard (or, for the training catch-up, a whole array), across a
// window containing other awaits. Every one of them silently discarded whatever concurrent write landed in
// that window. Each test here reproduces exactly that shape — land a real concurrent delta inside the
// window, then assert it survived — which is the property the fixes are for, and which every one of these
// tests fails against the pre-fix code.
//
// The window is injected deterministically by wrapping the collection method the production code awaits
// *between* its snapshot read and its write, rather than by racing two real calls: the whole point of the
// bug is that the window is wide, so a deterministic injection is both reproducible and honest about where
// the window actually is.
//
// The last test is not a race at all: it re-establishes, against a real Mongo, the sect-leader-penalty
// arithmetic that combatSiege-damage-helpers-gaps.test.ts used to assert on a mock. Moving that settle into
// an aggregation pipeline moved the arithmetic out of this process, so a mock can no longer observe it —
// this replaces (and strengthens) that assertion by checking the number Mongo actually stores.
//
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  GARRISON_PER_TILE,
  SECT_LEADER_PENALTY_RATE,
  RESOURCE_TYPES,
  TROOP_TRAIN_TIME_SEC,
  buildCost,
  buildTimeSec,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { WorldCore } from '../src/core';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_unguarded_writes_test';
const W = 's1-unguarded-writes';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.unguarded-writes.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

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

describe.skipIf(!mongo)('playerWorld unguarded-write sweep e2e (2026-08-24)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend() { /* no-op */ },
    async grant() { /* no-op */ },
  };

  const INK_START = 50_000; // well under RESOURCE_CAP (200k) so the settle clamp never masks an injected delta

  /** Put the account's resources somewhere the storage clamp cannot swallow a small injected credit. */
  async function setResources(accountId: string, ink = INK_START): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink, paper: ink, graphite: ink, metal: ink, sticker: ink }, lastTickAt: nowMs } },
    );
  }

  async function raw(accountId: string) {
    return m.collections.playerWorld.findOne({ _id: playerWorldId(W, accountId) });
  }

  /**
   * Land a real concurrent credit the first time the production code awaits `col[method]`, then delegate.
   * That await is what sits between the snapshot read and the write in every case below.
   */
  function injectOnce<T extends object>(
    col: T,
    method: keyof T & string,
    credit: () => Promise<unknown>,
  ): { restore: () => void; fired: () => boolean } {
    const real = (col[method] as unknown as (...a: unknown[]) => unknown).bind(col);
    let done = false;
    const spy = vi.spyOn(col as never, method as never).mockImplementation((async (...args: unknown[]) => {
      if (!done) { done = true; await credit(); }
      return real(...args);
    }) as never);
    return { restore: () => spy.mockRestore(), fired: () => done };
  }

  /**
   * Same idea for a `find`, which is synchronous and hands back a cursor — wrapping it in an async function
   * would return a promise where the caller expects the cursor. Patch the cursor's `toArray` instead, which
   * is the await recomputeYield (and the training due-scan) actually blocks on.
   */
  function injectOnCursor<T extends object>(col: T, credit: () => Promise<unknown>): { restore: () => void; fired: () => boolean } {
    const real = (col as { find: (...a: unknown[]) => { toArray: () => Promise<unknown[]> } }).find.bind(col);
    let done = false;
    const spy = vi.spyOn(col as never, 'find' as never).mockImplementation(((...args: unknown[]) => {
      const cursor = real(...args);
      const realToArray = cursor.toArray.bind(cursor);
      cursor.toArray = (async () => {
        const out = await realToArray();
        if (!done) { done = true; await credit(); }
        return out;
      }) as never;
      return cursor;
    }) as never);
    return { restore: () => spy.mockRestore(), fired: () => done };
  }

  /** The concurrent write the old code discarded: an atomic $inc credit, the shape city/teams.ts refunds use. */
  const CREDIT = 7_777;
  function creditInk(accountId: string) {
    return () => m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $inc: { 'resources.ink': CREDIT, rev: 1 } },
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

  it('occupyTile: a concurrent resource credit survives the garrison debit (was: absolute $set behind a troops-only filter)', async () => {
    const site = findCoord(OCCUPIABLE, 20, 20);
    await svc.joinWorld(W, 'a', CENTER_X - 40, CENTER_Y - 40);
    await setResources('a');
    const before = await raw('a');

    // recomputeYield (a tiles scan) is the await between occupyTile's `pw` read and its write.
    const inj = injectOnCursor(m.collections.tiles, creditInk('a'));
    try {
      await svc.occupyTile(W, 'a', site.x, site.y);
    } finally {
      inj.restore();
    }
    expect(inj.fired()).toBe(true);

    const after = await raw('a');
    expect(after!.resources.ink).toBe(before!.resources.ink + CREDIT); // pre-fix: the credit was overwritten
    expect(after!.troops).toBe(before!.troops - GARRISON_PER_TILE);   // the debit still applied, atomically
    expect(await m.collections.tiles.findOne({ _id: tileId(W, site.x, site.y) })).not.toBeNull();
  });

  it('abandonTile: a concurrent resource credit survives the garrison refund (was: fully unguarded absolute $set)', async () => {
    const site = findCoord(OCCUPIABLE, 30, 30);
    await svc.joinWorld(W, 'b', CENTER_X + 40, CENTER_Y + 40);
    await setResources('b');
    await svc.occupyTile(W, 'b', site.x, site.y);
    await setResources('b'); // reset the baseline after the occupy's own settle
    const before = await raw('b');

    const inj = injectOnCursor(m.collections.tiles, creditInk('b'));
    try {
      await svc.abandonTile(W, 'b', site.x, site.y);
    } finally {
      inj.restore();
    }
    expect(inj.fired()).toBe(true);

    const after = await raw('b');
    expect(after!.resources.ink).toBe(before!.resources.ink + CREDIT);
    expect(after!.troops).toBe(before!.troops + GARRISON_PER_TILE); // refund still applied
  });

  it('applyDueBuilds: a concurrent resource credit survives the build completion (was: fully unguarded absolute $set)', async () => {
    await svc.joinWorld(W, 'c', CENTER_X - 60, CENTER_Y + 60);
    // Fund the upgrade itself generously, then settle the baseline low enough for the clamp not to interfere.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'c') },
      { $set: { resources: { ink: 190_000, paper: 190_000, graphite: 190_000, metal: 190_000, sticker: 190_000 }, lastTickAt: nowMs } },
    );
    await svc.upgradeBuilding(W, 'c', 'cabinet');
    // Zero the yield before advancing the clock: this is the one test that moves `now` (to make the build
    // due), so real accrual over that window would otherwise show up in the delta and make the no-clobber
    // assertion inexact. applyDueBuilds recomputes yieldRate itself, and settleExpr reads the PRE-update
    // $yieldRate, so zeroing it here isolates the clobber without changing what is under test.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'c') },
      { $set: { yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 } } },
    );
    await setResources('c');
    const before = await raw('c');
    expect(before!.buildQueue ?? []).toHaveLength(1);

    nowMs += buildTimeSec('cabinet', 1) * 1000 + 1000;
    // recomputeYield is the await between applyDueBuilds' `fresh` read and its write.
    const inj = injectOnCursor(m.collections.tiles, creditInk('c'));
    try {
      expect(await svc.processCompletedBuilds()).toBe(1);
    } finally {
      inj.restore();
    }
    expect(inj.fired()).toBe(true);

    const after = await raw('c');
    expect(after!.resources.ink).toBe(before!.resources.ink + CREDIT);
    expect(after!.buildings?.cabinet).toBe(1);       // the upgrade still landed
    expect(after!.buildQueue ?? []).toHaveLength(0); // and the queue still drained
  });

  it('training speedup catch-up: a batch enqueued in its window is no longer written out of existence', async () => {
    await svc.joinWorld(W, 'd', CENTER_X + 60, CENTER_Y - 60);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'd') },
      {
        $set: {
          resources: { ink: 190_000, paper: 190_000, graphite: 190_000, metal: 190_000, sticker: 190_000 },
          lastTickAt: nowMs,
          troops: 0,
          speedupUntil: nowMs + 86_400_000, // buff active, so the catch-up loop has work to do
        },
      },
    );
    // 100 troops = TROOP_TRAIN_TIME_SEC × 100 = 500s, comfortably longer than the 5s of buff compression
    // below, so the batch stays in the future and the due-scan later in the same tick leaves it alone.
    await svc.trainTroops(W, 'd', 100);
    // The stale watermark has to be planted AFTER trainTroops: trainTroops writes `speedupSettledAt: t`
    // itself, so setting it before would be overwritten and applyTrainingSpeedupCatchup would see
    // `toT <= fromT`, return the same array reference, and `continue` — the loop would never write and the
    // test would pass against the broken code too (which is exactly what the first draft of it did).
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'd') },
      { $set: { speedupSettledAt: nowMs - 5_000 } },
    );
    const firstQueue = (await raw('d'))!.trainingQueue ?? [];
    expect(firstQueue).toHaveLength(1);

    // A second trainTroops lands inside the catch-up's read→write window. Pre-fix, the blind $set wrote the
    // one-entry snapshot array back and the new batch vanished — resources already spent on it.
    // TROOP_TRAIN_QUEUE_MAX is 2 with no drillYard, so this second batch is the last slot — it fits.
    const inj = injectOnCursor(m.collections.playerWorld, () => svc.trainTroops(W, 'd', 100));
    try {
      await svc.processCompletedTraining();
    } finally {
      inj.restore();
    }
    expect(inj.fired()).toBe(true);

    const after = await raw('d');
    // Pre-fix: 1. The blind `$set` wrote the one-entry snapshot array back over the live two-entry one and
    // the concurrently-queued batch ceased to exist, resources already spent on it. Post-fix the watermark
    // guard sees that trainTroops moved `speedupSettledAt` and skips this tick entirely; the next tick
    // (2s later) recomputes the same overlap against the fresh array, so no buff progress is lost either.
    expect(after!.trainingQueue ?? []).toHaveLength(2);
    expect(after!.nextTrainingCompleteAt).toBe((after!.trainingQueue ?? [])[0]!.completeAt);
  });

  it('applySectLeaderPenalty: docks exactly SECT_LEADER_PENALTY_RATE of the settled balance, computed by Mongo', async () => {
    // Replaces the mock-observed arithmetic assertion in combatSiege-damage-helpers-gaps.test.ts: the settle
    // now happens inside the update, so only a real Mongo can verify the number.
    await svc.joinWorld(W, 'leader', CENTER_X - 20, CENTER_Y + 20);
    await svc.joinWorld(W, 'member', CENTER_X + 20, CENTER_Y - 20);
    await m.collections.playerWorld.updateMany(
      { worldId: W },
      { $set: { familyId: 'fam-1', sectId: 'sect-1', yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 } } },
    );
    await setResources('leader');
    await setResources('member');
    await m.collections.sects.insertOne({ _id: 'sect-1', worldId: W, leaderId: 'leader' } as never);

    const core = new WorldCore({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
      socialsvc: {
        available: true,
        getFamiliesBySect: async () => [{ familyId: 'fam-1' }],
      } as never,
    });
    await new SiegeHelpersService(core).applySectLeaderPenalty(W, 'leader', nowMs);

    const keep = 1 - SECT_LEADER_PENALTY_RATE;
    for (const who of ['leader', 'member']) {
      const doc = await raw(who);
      for (const rt of RESOURCE_TYPES) {
        expect(doc!.resources[rt]).toBe(Math.floor(INK_START * keep));
      }
      expect(doc!.lastTickAt).toBe(nowMs);
    }
  });

  it('applySectLeaderPenalty: a concurrent credit to a later member is not rolled back by the loop', async () => {
    await svc.joinWorld(W, 'leader2', CENTER_X - 25, CENTER_Y + 25);
    await svc.joinWorld(W, 'member2', CENTER_X + 25, CENTER_Y - 25);
    await m.collections.playerWorld.updateMany(
      { worldId: W },
      { $set: { familyId: 'fam-2', sectId: 'sect-2', yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 } } },
    );
    await setResources('leader2');
    await setResources('member2');
    await m.collections.sects.insertOne({ _id: 'sect-2', worldId: W, leaderId: 'leader2' } as never);

    const core = new WorldCore({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
      socialsvc: {
        available: true,
        getFamiliesBySect: async () => [{ familyId: 'fam-2' }],
      } as never,
    });
    // Credit member2 after the members list is read but before its own write in the loop.
    const inj = injectOnce(m.collections.playerWorld, 'updateOne', creditInk('member2'));
    try {
      await new SiegeHelpersService(core).applySectLeaderPenalty(W, 'leader2', nowMs);
    } finally {
      inj.restore();
    }
    expect(inj.fired()).toBe(true);

    // The credit was already in the document when the penalty write ran, so it is scaled along with the rest
    // rather than discarded. Pre-fix the JS-side absolute $set overwrote it with a figure that never saw it.
    const doc = await raw('member2');
    const keep = 1 - SECT_LEADER_PENALTY_RATE;
    expect(doc!.resources.ink).toBe(Math.floor((INK_START + CREDIT) * keep));
  });

  it('sanity: TROOP_TRAIN_TIME_SEC and buildingUpgradeCost are the knobs these tests lean on', () => {
    // Guards the fixtures above against a silent balance change making them vacuous (e.g. a zero-length
    // build turning `processCompletedBuilds` into a no-op before the injection ever fires).
    expect(TROOP_TRAIN_TIME_SEC).toBeGreaterThan(0);
    expect(buildTimeSec('cabinet', 1)).toBeGreaterThan(0);
    expect(Object.keys(buildCost('cabinet', 1)).length).toBeGreaterThan(0);
  });
});
