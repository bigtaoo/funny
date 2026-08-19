// worldsvc blocker + structure-cleanup e2e (ADR-051 P5b): a player-built `blocker` structure is a hard path
// obstacle — an ENEMY march must route around it (findMarchPath treats it like an enemy base footprint), while
// the builder & their family pass through freely. Structures are razed when their tile is abandoned/captured
// (an arrow tower's 3×3 coverage index is swept clean too). Blockers register NO coverage (they act at pathing
// time, not on tile-entry). Uses the same in-memory FakeRedis cover hash as the other field-battle e2e specs.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState, TileDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, gear: {}, locked: false }),
});
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
};

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_blocker_test';
const W = 's1-blk';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.blocker.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    h.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> { return this.hashes.get(key)?.get(field) ?? null; }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async quit(): Promise<unknown> { return 'OK'; }
  coverSize(worldId: string): number { return this.hashes.get(`world:${worldId}:cover`)?.size ?? 0; }
}

function findCoord(pred: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number): { x: number; y: number } {
  const cx = Math.floor(SLG_MAP_W / 2), cy = Math.floor(SLG_MAP_H / 2);
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === cx && y === cy) continue;
        if (pred(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('worldsvc blocker + structure cleanup e2e (ADR-051 P5b)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); } , broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); } };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    redis = new FakeRedis();
    svc = new WorldService({ cols: m.collections, redis, gateway: fakeGateway, meta: fakeMeta, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Set N card teams at once (setTeams replaces the whole array, so one call), each with a deployed troop count. */
  async function setupCardTeams(accountId: string, teams: { teamId: string; cardId: string; troops: number }[]): Promise<void> {
    await svc.setTeams(W, accountId, teams.map((tm) => ({ id: tm.teamId, name: tm.teamId, army: [{ cardInstanceId: tm.cardId, col: 0, row: 1 }] })) as TeamTemplate[]);
    const cardSet: Record<string, CardSLGState> = {};
    for (const tm of teams) cardSet[`cardState.${tm.cardId}`] = { currentTroops: tm.troops, teamId: tm.teamId } as CardSLGState;
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, accountId) }, { $set: cardSet });
  }

  /** Insert a blocker structure owned by `ownerId` (+ optional familyId) at (x,y). */
  async function putBlocker(ownerId: string, x: number, y: number, familyId?: string): Promise<void> {
    await m.collections.tiles.insertOne({
      _id: tileId(W, x, y), worldId: W, x, y, type: 'territory', level: 1, ownerId,
      structure: { kind: 'blocker', level: 1, hp: 3000, hpMax: 3000, ownerId, ...(familyId ? { familyId } : {}), builtAt: now() },
      rev: 0,
    } as TileDoc);
  }

  async function pathTo(accountId: string, teamId: string, dest: { x: number; y: number }): Promise<{ x: number; y: number }[]> {
    const mv = await svc.startMarch(W, accountId, 5, 5, dest.x, dest.y, 'move', 1, teamId);
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    return doc!.path!;
  }

  it('an ENEMY blocker reroutes a march around it; a FRIENDLY (own) blocker does not', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupCardTeams('a', [
      { teamId: 'at1', cardId: 'a1', troops: 500 },
      { teamId: 'at2', cardId: 'a2', troops: 500 },
      { teamId: 'at3', cardId: 'a3', troops: 500 },
    ]);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const p0 = await pathTo('a', 'at1', dest);
    expect(p0.length).toBeGreaterThan(5);
    const B = p0[3]!; // an intermediate cell on the unobstructed path

    // Enemy blocker on that cell → the re-path must route around it (never steps on B).
    await putBlocker('b', B.x, B.y);
    const p1 = await pathTo('a', 'at2', dest);
    expect(p1.some((c) => c.x === B.x && c.y === B.y)).toBe(false);
    expect(redis.coverSize(W)).toBe(0); // blockers register NO coverage

    // Replace it with A's OWN blocker → passable, so the path may cross it again.
    await m.collections.tiles.deleteOne({ _id: tileId(W, B.x, B.y) });
    await putBlocker('a', B.x, B.y);
    const p2 = await pathTo('a', 'at3', dest);
    expect(p2.some((c) => c.x === B.x && c.y === B.y)).toBe(true);
  });

  it('abandoning a tile razes its arrow tower and clears the 3×3 coverage index', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Own an interior tile + stockpile, build a tower (registers 9-cell coverage), then abandon it.
    await m.collections.tiles.insertOne({
      _id: tileId(W, 20, 20), worldId: W, x: 20, y: 20, type: 'resource', level: 3, resType: 'paper', ownerId: 'a', garrison: 50, rev: 0,
    } as TileDoc);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { resources: { ink: 99999, paper: 99999, graphite: 99999, metal: 99999, sticker: 99999 }, lastTickAt: now() } },
    );
    await svc.buildStructure(W, 'a', 20, 20, 'arrowTower');
    expect(redis.coverSize(W)).toBe(9);

    await svc.abandonTile(W, 'a', 20, 20);
    expect(await m.collections.tiles.findOne({ _id: tileId(W, 20, 20) })).toBeNull();
    expect(redis.coverSize(W)).toBe(0);
  });
});
