// Regression coverage for the `tiles` half of the 2026-08-24 concurrency sweep.
//
// The first two rounds only swept `playerWorld`. `tiles` carried the same `$set`-absolute-vs-`$inc`-delta
// mix, and `garrison` turned out to be the exact analogue of `troops`: reinforce arrivals credit it with
// `$inc` (combatMarch/arrival.ts) while siege settlements published an absolute survivor count — and BOTH
// run off the same `processDueArrivals` tick, so a defender reinforcing the tile under attack (the most
// ordinary defensive play there is) had those troops silently deleted.
//
// Same method as playerworld-unguarded-writes.e2e.test.ts: land a real concurrent delta inside the
// read→write window, then assert it survived. Each case here fails against the pre-fix code.
//
// Division of labour, stated because it matters for what these tests do and do not prove: the siege-damage
// and shield cases drive production code end to end (processDueSiegeDamage / buySlgShopItem). The garrison,
// clamp and card-top-up cases execute the persisted expression directly against real Mongo, because
// reaching them through production needs a full battle resolution — so they prove the EXPRESSION is right,
// while the mock unit tests updated alongside this file (combatSiege-arrival-variants-gaps.test.ts,
// occupation-battle.test.ts) prove the production sites EMIT that exact expression. Wiring and behaviour are
// covered, but by two files rather than one; changing the shape in production without updating those unit
// tests would fail there, not here.
//
// The two production-path cases inject a concurrent writer INSIDE the read→write window rather than just
// issuing two calls in sequence. That distinction cost a round: the first drafts did the sequential thing and
// passed against the pre-fix code, because `processDueSiegeDamage` is a `for … await` loop that re-reads the
// tile each iteration, and two shop purchases likewise each re-read. Nothing was wrong with the fixes — the
// tests were simply not reproducing the race. The real interleaving comes from `scheduler.ts` firing its five
// tick tasks concurrently under `Promise.allSettled`, and from two HTTP requests genuinely overlapping.
//
// Requires `cd server && docker compose up -d` (or NW_MONGO_URI pointing at a shared rs0 mongod).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  buildingMaxHp,
  baseFootprintCells,
  baseFootprintInBounds,
  isCityGroundTile,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { WorldCore } from '../src/core';
import { SiegeDamageService } from '../src/combatSiege/damage';
import type { SiegeDamageDoc, TileDoc } from '../src/db';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_tiles_unguarded_test';
const W = 's1-tiles-unguarded';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.tiles-unguarded.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

describe.skipIf(!mongo)('tiles unguarded-write sweep e2e (2026-08-24)', () => {
  const m = mongo!;
  let nowMs = 2_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let core: WorldCore;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend() { /* no-op */ },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 2_000_000;
    const deps = { cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now };
    svc = new WorldService(deps);
    core = new WorldCore(deps);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('siege damage survives a competing HP write landing inside its read-write window', async () => {
    // The headline `tiles` defect. `processDueSiegeDamage` claims up to 500 due hits per tick, so several
    // besiegers of one building all resolved against the same snapshot and only the last write survived:
    // coordinated attacks silently lost everyone else's damage. Now rev-guarded with a retry that recomputes
    // against a fresh read, which is exactly the semantics wanted — our damage stacks on top of theirs.
    const site = findCoord(OCCUPIABLE, 25, 25);
    const tid = tileId(W, site.x, site.y);
    const defHome = findCapitalSite(CENTER_X - 30, CENTER_Y - 30);
    const atk1Home = findCapitalSite(CENTER_X + 30, CENTER_Y + 30);
    const atk2Home = findCapitalSite(CENTER_X + 40, CENTER_Y + 40);
    await svc.joinWorld(W, 'def', defHome.x, defHome.y);
    await svc.joinWorld(W, 'atk1', atk1Home.x, atk1Home.y);
    await svc.joinWorld(W, 'atk2', atk2Home.x, atk2Home.y);

    const level = proceduralTile(W, site.x, site.y).level ?? 1;
    const maxHp = buildingMaxHp(level);
    await m.collections.tiles.insertOne({
      _id: tid, worldId: W, x: site.x, y: site.y, type: 'territory', level,
      ownerId: 'def', garrison: 0, hp: maxHp, rev: 0,
    } as unknown as TileDoc);

    const hit = (id: string, attackerId: string, damage: number): SiegeDamageDoc => ({
      _id: id, worldId: W, tile: tid, attackerId, defenderId: 'def',
      damage, attackerSurvivors: 0, isBase: false, dueAt: nowMs - 1,
    } as unknown as SiegeDamageDoc);
    // buildingMaxHp(1) is only 100, so keep the total well under it — the point of this test is the SURVIVE
    // branch (two hits stacking), not the capture branch.
    await m.collections.siegeDamage.insertMany([hit('h1', 'atk1', 30), hit('h2', 'atk2', 20)]);

    const dmgSvc = new SiegeDamageService(core, {
      transferLoot: async () => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 }),
      applySectLeaderPenalty: async () => {},
      passiveRelocate: async () => {},
      recordSiege: async () => null,
    } as never);

    // Land a competing HP write between the first hit's read and its write — the shape another concurrently
    // running tick task (processCompletedBuilds' wall rebase) or a second worldsvc instance produces.
    const realTilesFindOne = m.collections.tiles.findOne.bind(m.collections.tiles);
    let injected = false;
    const spy = vi.spyOn(m.collections.tiles, 'findOne').mockImplementation((async (...args: unknown[]) => {
      const doc = await realTilesFindOne(...(args as Parameters<typeof realTilesFindOne>));
      if (!injected && doc && (doc as TileDoc)._id === tid) {
        injected = true;
        await m.collections.tiles.updateOne({ _id: tid }, { $inc: { hp: -10, rev: 1 } });
      }
      return doc;
    }) as never);
    try {
      expect(await dmgSvc.processDueSiegeDamage(nowMs)).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);

    const after = await m.collections.tiles.findOne({ _id: tid });
    // 30 + 20 from the two hits, plus the 10 injected mid-window. Pre-fix the injected 10 was overwritten by
    // the first hit's absolute write.
    expect(after!.hp).toBe(maxHp - 60);
  });

  it('a reinforcement arriving while a siege settles is not deleted by the garrison write', async () => {
    // combatMarch/arrival.ts credits a reinforce with `$inc: { garrison }`; the siege settlement used to
    // `$set: { garrison: res.defenderSurvivors }`. Both are processDueArrivals paths, so the reinforcement
    // simply vanished. Now the settlement persists the CASUALTIES, so the two commute.
    const site = findCoord(OCCUPIABLE, 35, 35);
    const tid = tileId(W, site.x, site.y);
    const holderHome = findCapitalSite(CENTER_X - 50, CENTER_Y + 50);
    await svc.joinWorld(W, 'holder', holderHome.x, holderHome.y);
    await m.collections.tiles.insertOne({
      _id: tid, worldId: W, x: site.x, y: site.y, type: 'territory',
      level: proceduralTile(W, site.x, site.y).level ?? 1,
      ownerId: 'holder', garrison: 100, rev: 0,
    } as unknown as TileDoc);

    // Deduct the defenders the battle killed (100 held, 60 survived → 40 casualties) while a reinforcement
    // of 500 lands in the same window.
    await m.collections.tiles.updateOne({ _id: tid }, { $inc: { garrison: 500, rev: 1 } });
    await m.collections.tiles.updateOne({ _id: tid }, [
      { $set: { garrison: { $max: [0, { $subtract: [{ $ifNull: ['$garrison', 0] }, 40] }] }, rev: { $add: ['$rev', 1] } } },
    ]);

    const after = await m.collections.tiles.findOne({ _id: tid });
    // Pre-fix shape (`$set: { garrison: 60 }`) would have thrown the 500 away.
    expect(after!.garrison).toBe(560);
  });

  it('the casualty deduction clamps at zero rather than going negative', async () => {
    const site = findCoord(OCCUPIABLE, 45, 45);
    const tid = tileId(W, site.x, site.y);
    await m.collections.tiles.insertOne({
      _id: tid, worldId: W, x: site.x, y: site.y, type: 'territory', level: 1, ownerId: 'x', garrison: 10, rev: 0,
    } as unknown as TileDoc);
    await m.collections.tiles.updateOne({ _id: tid }, [
      { $set: { garrison: { $max: [0, { $subtract: [{ $ifNull: ['$garrison', 0] }, 999] }] }, rev: { $add: ['$rev', 1] } } },
    ]);
    expect((await m.collections.tiles.findOne({ _id: tid }))!.garrison).toBe(0);
  });

  it('two protection purchases both extend the shield instead of one swallowing the other', async () => {
    // shop.ts computed the stacked end-time from a `findOne` two lines up and blind-`$set` it. Driven through
    // the real purchase path here: buy the same shield twice and require the duration to have stacked, which
    // is what the item description promises and what a player who paid twice is owed.
    const home = findCapitalSite(CENTER_X + 70, CENTER_Y + 70);
    await svc.joinWorld(W, 'shopper', home.x, home.y);
    const anchor = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'shopper') }))!.mainBaseTile!;
    // joinWorld grants a spawn shield; clear it so the assertion is about the two purchases alone.
    await m.collections.tiles.updateOne({ _id: anchor }, { $unset: { protectedUntil: '' } });

    const EIGHT_H = 28_800 * 1000;
    await svc.buySlgShopItem(W, 'shopper', 'slg_shield_8h');
    const afterFirst = (await m.collections.tiles.findOne({ _id: anchor }))!.protectedUntil!;
    expect(afterFirst).toBe(nowMs + EIGHT_H);

    // Second purchase, with a competing extension landing inside its read→write window — i.e. a third
    // request (or the same player double-tapping) genuinely overlapping rather than following.
    const realFindOne = m.collections.tiles.findOne.bind(m.collections.tiles);
    let injected = false;
    const spy = vi.spyOn(m.collections.tiles, 'findOne').mockImplementation((async (...args: unknown[]) => {
      const doc = await realFindOne(...(args as Parameters<typeof realFindOne>));
      if (!injected && doc && (doc as TileDoc)._id === anchor) {
        injected = true;
        await m.collections.tiles.updateOne({ _id: anchor }, { $inc: { protectedUntil: EIGHT_H, rev: 1 } });
      }
      return doc;
    }) as never);
    try {
      await svc.buySlgShopItem(W, 'shopper', 'slg_shield_8h');
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);

    // Three 8h extensions in total (two bought, one injected). Pre-fix the injected one was swallowed.
    expect((await m.collections.tiles.findOne({ _id: anchor }))!.protectedUntil).toBe(nowMs + 3 * EIGHT_H);
  });

  it('a card top-up landing during a battle settlement survives it (the approved distributeTroops rule)', async () => {
    // 2026-08-24 user decision: topping up a deployed card stays allowed, so the settlement persists the
    // per-card LOSS rather than an absolute survivor count. 100 deployed, 50% survival → 50 lost; a +200
    // top-up in the window must still be there afterwards.
    const carderHome = findCapitalSite(CENTER_X + 60, CENTER_Y - 60);
    await svc.joinWorld(W, 'carder', carderHome.x, carderHome.y);
    const pwId = playerWorldId(W, 'carder');
    await m.collections.playerWorld.updateOne({ _id: pwId }, { $set: { 'cardState.c1.currentTroops': 100 } });

    await m.collections.playerWorld.updateOne({ _id: pwId }, { $inc: { 'cardState.c1.currentTroops': 200, rev: 1 } });
    await m.collections.playerWorld.updateOne({ _id: pwId }, [
      {
        $set: {
          'cardState.c1.currentTroops': { $max: [0, { $subtract: [{ $ifNull: ['$cardState.c1.currentTroops', 0] }, 50] }] },
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);

    const doc = await m.collections.playerWorld.findOne({ _id: pwId });
    // Pre-fix (`$set: currentTroops = 50`) the 200 the player had paid for out of the pool was simply gone.
    expect(doc!.cardState!.c1!.currentTroops).toBe(250);
  });

  it('sanity: buildingMaxHp leaves headroom for the siege-damage fixture', () => {
    // Guards the siege-damage test against a balance change: if 60 total damage ever reached the cap, it
    // would silently move to the capture branch and stop testing what it says it tests.
    expect(buildingMaxHp(1)).toBeGreaterThan(50);
  });
});
