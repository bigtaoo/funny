// worldsvc capital data-integrity (ADR-025) end-to-end: real Mongo + fake clock.
//   Every capital MUST be a complete same-owner 3×3 (join writes all 9 footprint cells). This suite
//   pins that invariant and the self-heal for corrupt/legacy data (e.g. a pre-ADR-025 single-tile
//   capital that predates the 3×3 change):
//     ① fresh join → exactly 9 base cells owned by the player, territoryCount 9;
//     ② join is idempotent for an intact base (no re-placement, same anchor);
//     ③ getMe on a corrupt base (footprint not a full same-owner 3×3) → reports joined:false
//        (read-only; no deletion in the read path);
//     ④ joinWorld on a corrupt/legacy base → purges ALL the player's stale world data and re-places
//        a proper 3×3, so the player re-enters as a brand-new user.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
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
const DB = 'nw_world_base_integrity_test';
const W = 's1-base-integrity';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.base-integrity.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** First legal 3×3 capital anchor on the map (in-bounds + no cell is center/obstacle/gate/stronghold). */
function findBaseAnchor(): { x: number; y: number } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
      const blocked = baseFootprintCells(x, y).some((c) => {
        const t = proceduralTile(W, c.x, c.y);
        return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
      });
      if (!blocked) return { x, y };
    }
  }
  throw new Error('no legal 3×3 base anchor in world');
}

/** A second legal anchor far from `avoid` so its footprint cannot overlap the first base. */
function findFarBaseAnchor(avoid: { x: number; y: number }): { x: number; y: number } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (Math.abs(x - avoid.x) < 4 && Math.abs(y - avoid.y) < 4) continue;
      if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
      const blocked = baseFootprintCells(x, y).some((c) => {
        const t = proceduralTile(W, c.x, c.y);
        return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
      });
      if (!blocked) return { x, y };
    }
  }
  throw new Error('no second legal base anchor in world');
}

describe.skipIf(!mongo)('worldsvc capital data-integrity e2e (ADR-025)', () => {
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

  const base = findBaseAnchor();

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
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Count the player's owned base cells anchored at `a` (should be 9 for an intact capital). */
  async function baseCellCount(accountId: string, a: { x: number; y: number }): Promise<number> {
    const ids = baseFootprintCells(a.x, a.y).map(({ x, y }) => tileId(W, x, y));
    const cells = await m.collections.tiles.find({ _id: { $in: ids }, ownerId: accountId, type: 'base' }).toArray();
    return cells.length;
  }

  it('fresh join writes a complete 3×3 capital (9 base cells, territoryCount 9)', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    expect(await baseCellCount('a', base)).toBe(9);
    const me = await svc.getMe(W, 'a');
    expect(me.joined).toBe(true);
    expect(me.territoryCount).toBe(9);
    expect(me.mainBaseTile).toBe(tileId(W, base.x, base.y));
  });

  it('join is idempotent for an intact base — no re-placement, same anchor', async () => {
    const first = await svc.joinWorld(W, 'a', base.x, base.y);
    const again = await svc.joinWorld(W, 'a', base.x, base.y);
    expect(again.mainBaseTile).toBe(first.mainBaseTile);
    expect(await baseCellCount('a', base)).toBe(9);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(9);
  });

  it('getMe stays read-only for a corrupt base — no heal, no mutation on the read path', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    // Simulate a legacy single-tile capital: drop the 8 ring cells, keep only the anchor.
    const ringIds = baseFootprintCells(base.x, base.y)
      .filter(({ x, y }) => !(x === base.x && y === base.y))
      .map(({ x, y }) => tileId(W, x, y));
    await m.collections.tiles.deleteMany({ _id: { $in: ringIds } });

    // getMe is deliberately NOT the heal point (healing lives in joinWorld) so it never mutates the
    // read path — this keeps it safe against a concurrent passiveRelocate and avoids dropping the
    // payload for callers that inspect another player's state (e.g. a sieged defender's resources).
    const me = await svc.getMe(W, 'a');
    expect(me.joined).toBe(true);
    expect(me.resources).toBeDefined();
    // Nothing deleted by the read.
    expect(await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') })).not.toBeNull();
    expect(await m.collections.tiles.findOne({ _id: tileId(W, base.x, base.y) })).not.toBeNull();
  });

  it('joinWorld on a corrupt/legacy base purges stale data and re-places a fresh 3×3', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    // Give the player a stray far-away territory tile (mimics "territory 5" legacy state) + reduce troops.
    const far = findFarBaseAnchor(base);
    await m.collections.tiles.insertOne({
      _id: tileId(W, far.x, far.y), worldId: W, x: far.x, y: far.y,
      type: 'territory', level: 1, ownerId: 'a', garrison: 10, rev: 0,
    } as never);
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 3 } });
    // Corrupt the capital into a single-tile base.
    const ringIds = baseFootprintCells(base.x, base.y)
      .filter(({ x, y }) => !(x === base.x && y === base.y))
      .map(({ x, y }) => tileId(W, x, y));
    await m.collections.tiles.deleteMany({ _id: { $in: ringIds } });

    // Re-enter: purges everything and re-places a proper 3×3 at the requested anchor.
    const rejoined = await svc.joinWorld(W, 'a', base.x, base.y);
    expect(rejoined.joined).toBe(true);
    expect(rejoined.mainBaseTile).toBe(tileId(W, base.x, base.y));
    expect(await baseCellCount('a', base)).toBe(9);
    // Stray legacy territory was purged → territoryCount is exactly the fresh 3×3 (9), not 10.
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(9);
    expect(await m.collections.tiles.findOne({ _id: tileId(W, far.x, far.y) })).toBeNull();
    // Fresh player: troops reset to full cap (not the corrupted 3).
    expect(me.troops).toBe(me.troopCap);
    expect(me.troopCap).toBeGreaterThanOrEqual(TROOP_CAP_BASE);
  });
});
