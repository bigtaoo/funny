// worldsvc aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27) end-to-end: real Mongo + fake clock.
//   svc.enterWorld composes getMe+joinWorld (base-tile-first) + season/nations/map(or mapSparse)/
//   marches/occupations/stationed — the facade method backing POST /world/enter, which replaces the
//   9-request waterfall WorldMapNet.loadData() used to fire on every world-map entry. This suite pins:
//     ① fresh entry joins the world, reports justJoined:true, and centers the zoom-1 map on the new base;
//     ② a second entry (already joined) reports justJoined:false;
//     ③ zoom 2/3 populates mapSparse (not map);
//     ④ season is null when this worldId has no provisioned world doc (contract's nullable case).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { allCityNodes, tileId } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_enter_test';
const W = 's1-enter';
const MAP_W = 100;
const MAP_H = 100;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.enter-world.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

describe.skipIf(!mongo)('worldsvc enterWorld e2e (P1-5, comm-audit-2026-07-27)', () => {
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
    available: false,
    async deductMaterial() {},
    async grantMaterial() {},
    async getProfile() { return null; },
    async getSaveFields() { return null; },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
      mapW: MAP_W,
      mapH: MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('fresh entry joins the world, reports justJoined:true, and centers the zoom-1 map on the new base', async () => {
    const entry = await svc.enterWorld(W, 'a', 10, 1);
    expect(entry.me.joined).toBe(true);
    expect(entry.me.justJoined).toBe(true);
    expect(entry.me.mainBaseTile).toBeTruthy();
    expect(entry.map).toBeDefined();
    expect(entry.mapSparse).toBeUndefined();

    // The map window is centered on the resolved base tile, not (0,0) — the base anchor tile itself
    // must appear inside the returned viewport.
    const anchorId = entry.me.mainBaseTile!;
    expect(entry.map!.tiles.some((t) => tileId(W, t.x, t.y) === anchorId)).toBe(true);

    expect(entry.marches).toEqual([]);
    expect(entry.occupations).toEqual([]);
    expect(entry.stationed).toEqual([]);
    expect(entry.nations).toEqual([]);
  });

  it('a second entry (already joined) reports justJoined:false', async () => {
    const first = await svc.enterWorld(W, 'a', 10, 1);
    const second = await svc.enterWorld(W, 'a', 10, 1);
    expect(second.me.justJoined).toBe(false);
    expect(second.me.mainBaseTile).toBe(first.me.mainBaseTile);
  });

  it('zoom 2/3 populates mapSparse, not map', async () => {
    const entry = await svc.enterWorld(W, 'a', 10, 2);
    expect(entry.mapSparse).toBeDefined();
    expect(entry.mapSparse!.lod).toBe('mid');
    expect(entry.map).toBeUndefined();

    const thin = await svc.enterWorld(W, 'a', 10, 3);
    expect(thin.mapSparse!.lod).toBe('thin');
  });

  it('season is null when this worldId has no provisioned world doc (contract nullable case)', async () => {
    const entry = await svc.enterWorld(W, 'a', 10, 1);
    expect(entry.season).toBeNull();
  });

  // ── cities (2026-08-19) ─────────────────────────────────────────────────────────────────────
  // The city sprite layer's whole point is that the client stops recomputing allCityNodes() locally,
  // so the field actually reaching this payload IS the feature. Everything else can be right and the
  // map still renders published cities in the wrong place if `cities` gets dropped here.
  it('the entry payload carries the world city nodes', async () => {
    const entry = await svc.enterWorld(W, 'a', 10, 1);
    expect(Array.isArray(entry.cities)).toBe(true);
    expect(entry.cities.length).toBeGreaterThan(0);
    // Shape the client's sprite layer depends on (id keys the sprite, footprint sizes it).
    for (const n of entry.cities) {
      expect(typeof n.id).toBe('string');
      expect(['capital', 'worldCenter', 'garrison']).toContain(n.kind);
      expect(Number.isInteger(n.footprint)).toBe(true);
    }
  });

  it('falls back to the seed-derived list for a world with no stored node list', async () => {
    // This suite's world has no WorldDoc at all (see the season-is-null case above), which is also the
    // pre-2026-08-19 / no-active-template case: the terrain really is proceduralTile(worldId, …), so
    // allCityNodes(worldId) is the correct answer rather than a guess.
    const entry = await svc.enterWorld(W, 'a', 10, 1);
    expect(entry.cities).toEqual(allCityNodes(W));
  });

  it('serves the world stored list instead, once one exists (a published/edited template)', async () => {
    const moved = allCityNodes(W).map((n) => (n.kind === 'garrison' ? { ...n, x: n.x - 7, y: n.y - 3 } : n));
    await m.collections.worlds.updateOne(
      { _id: W },
      {
        $set: { cities: moved, season: 1, shard: 0, status: 'open', mapW: MAP_W, mapH: MAP_H, openAt: now(), capacity: 10, population: 0, rev: 1 },
      },
      { upsert: true },
    );
    const entry = await svc.enterWorld(W, 'a', 10, 1);
    expect(entry.cities).toEqual(moved);
    expect(entry.cities).not.toEqual(allCityNodes(W));
  });
});
