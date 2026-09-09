// Per-tile payload budget for `GET /world/map` (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §8).
//
// §8 measured a full viewport at 82.7 bytes per tile and 6561 tiles — 523KB — and found that 96% of it is
// terrain repeated cell by cell and under 4% is the player state anybody actually wanted. That shape was
// not a decision; it accumulated one field at a time, because a field added to `WorldTileView` costs
// nothing visible at the call site and 6561x on the wire.
//
// So this gate is about the per-tile FIELD SET, not the total. A tile with no DB override — the
// overwhelming majority of any viewport — may carry only the terrain keys the client cannot derive
// another way. Adding a key to that set is a real decision with a measurable price, and the failure
// message states the price so it can be made deliberately rather than by accident.
//
// The byte ceiling beside it is deliberately loose (it must survive coordinates growing a digit) and
// exists to catch value bloat that keeps the key set intact — a name, a nested object, a timestamp.
//
// Deliberately in the normal suite, not next to test/load/getMapPayload.load.ts: that harness reports the
// full breakdown and is opt-in, while this is one assertion cheap enough to run on every push.
//
// Requires real Mongo (globalSetup spins up mongodb-memory-server); self-skips if it is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proceduralTile, SLG_MAP_W, SLG_MAP_H, tileId } from '@nw/shared';
import { createWorldMongo, type WorldMongo, type TileDoc } from '../src/db';
import { WorldService } from '../src/service';
import { MAP_VIEW_MAX_RADIUS, type WorldTileView } from '../src/worldTypes';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_payload_budget';
const W = 's1-budget';
const NOW = 1_800_000_000_000;

/**
 * Everything a tile with NO database override is allowed to put on the wire.
 *
 * `visible` is in here and is hardcoded `true` on every tile (core/map.ts) since the 2026-07-24 fog-model
 * change made the static layer public. §8.3 measured removing it: 18.1% of the uncompressed payload but
 * only 0.1–1.5% once the edge compresses, which does not pay for a wire-contract change. It stays, and it
 * stays listed here, so that the decision is recorded rather than rediscovered.
 */
const TERRAIN_KEYS = new Set<keyof WorldTileView | string>([
  'x', 'y', 'type', 'level', 'resType', 'obstacleKind', 'visible',
]);

/** Loose enough to survive a coordinate gaining a digit; tight enough that a new per-tile key trips it. */
const MAX_BYTES_PER_TILE = 95;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.map-payload-budget] Mongo unreachable (${URI}) — skipping.`);
}

// Off-centre so the viewport is ordinary land rather than the contested world centre.
const CX = Math.floor(SLG_MAP_W / 2) + 137;
const CY = Math.floor(SLG_MAP_H / 2) + 91;

describe.skipIf(!mongo)('GET /world/map per-tile payload budget', () => {
  const m = mongo!;
  let svc: WorldService;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('an unoccupied tile carries only terrain keys', async () => {
    const view = await svc.getMap(W, 'viewer', CX, CY, MAP_VIEW_MAX_RADIUS);
    expect(view.tiles.length).toBe((MAP_VIEW_MAX_RADIUS * 2 + 1) ** 2);

    const extras = new Map<string, number>();
    for (const t of view.tiles) {
      for (const k of Object.keys(t)) {
        if (!TERRAIN_KEYS.has(k)) extras.set(k, (extras.get(k) ?? 0) + 1);
      }
    }
    if (extras.size > 0) {
      const bytes = JSON.stringify(view).length;
      const detail = [...extras.entries()]
        .map(([k, n]) => `\`${k}\` on ${n}/${view.tiles.length} unoccupied tiles`)
        .join(', ');
      throw new Error(
        `getMap now sends ${detail}. A key on every tile costs ~${view.tiles.length}x on the wire ` +
        `(this viewport is ${bytes} bytes). If it is player state, gate it behind an owner/occupied ` +
        `check like garrison and hp are; if it is terrain the client could derive from proceduralTile, ` +
        `it does not belong on the wire at all. If it genuinely must ship on every tile, add it to ` +
        `TERRAIN_KEYS with the reason — see WORLDSVC_CONCURRENCY_AUDIT §8.`,
      );
    }
  });

  it('stays under the per-tile byte ceiling', async () => {
    const view = await svc.getMap(W, 'viewer', CX, CY, MAP_VIEW_MAX_RADIUS);
    const perTile = Buffer.byteLength(JSON.stringify(view), 'utf8') / view.tiles.length;
    expect(
      perTile,
      `${perTile.toFixed(1)} bytes/tile exceeds the ${MAX_BYTES_PER_TILE} budget; at ${view.tiles.length} ` +
      `tiles that is ${(perTile * view.tiles.length / 1024).toFixed(0)}KB per viewport fetch`,
    ).toBeLessThan(MAX_BYTES_PER_TILE);
  });

  it('intel fields ride only on the tiles that have them, never as nulls on every tile', async () => {
    // The cheap way to add a field is to emit it unconditionally with a falsy default. That is what turns
    // one field into 6561 copies, and it is invisible in any single-tile test — so assert the negative:
    // an occupied tile carries garrison/hp, and its unoccupied neighbours carry neither key at all.
    //
    // The tile is the REQUESTER'S own. First written with a foreign `ownerId`, this failed on `garrison`
    // — correctly: garrison/hp are fog-gated intel (gateIntel), and a requester with no territory nearby
    // has no vision, so a stranger's tile legitimately arrives without them. `occupied` still did arrive,
    // because ownership went public map-wide in the 2026-07-24 fog-model change. Owning the tile puts it
    // in vision, which is what this assertion needs; the fog rules themselves are fog.e2e.test.ts's job.
    const proc = (x: number, y: number) => proceduralTile(W, x, y);
    let spot: { x: number; y: number } | null = null;
    for (let d = 0; d < 40 && !spot; d++) {
      const x = CX + d, y = CY;
      if (['resource', 'neutral'].includes(proc(x, y).type)) spot = { x, y };
    }
    expect(spot, 'no occupiable tile near the viewport centre').not.toBeNull();

    const doc: TileDoc = {
      _id: tileId(W, spot!.x, spot!.y), worldId: W, x: spot!.x, y: spot!.y,
      type: 'territory', level: proc(spot!.x, spot!.y).level,
      ownerId: 'viewer', garrison: 200, garrisonRegenAt: NOW - 60_000, hp: 800, rev: 0,
    } as TileDoc;
    await m.collections.tiles.insertOne(doc);
    try {
      const view = await svc.getMap(W, 'viewer', CX, CY, 5);
      const occupied = view.tiles.find((t) => t.x === spot!.x && t.y === spot!.y);
      expect(occupied?.occupied).toBe(true);
      expect(Object.keys(occupied!)).toContain('garrison');

      const unoccupied = view.tiles.filter((t) => !(t.x === spot!.x && t.y === spot!.y));
      expect(unoccupied.length).toBeGreaterThan(50);
      for (const t of unoccupied) {
        expect(Object.keys(t)).not.toContain('garrison');
        expect(Object.keys(t)).not.toContain('hp');
        expect(Object.keys(t)).not.toContain('occupied');
      }
    } finally {
      await m.collections.tiles.deleteOne({ _id: doc._id });
    }
  });
});
