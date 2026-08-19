// worldsvc field-unit occupancy index e2e (ADR-051 P1): verify that a stepping march writes the Redis
// occupancy index (`world:{w}:occ`, field=tileId → occupant JSON) as it advances tile-by-tile, and clears it
// on arrival and on recall. Uses an in-memory fake Redis (the default e2e harness runs redis:null, which
// no-ops the occ writes) so the set/clear lifecycle is actually exercised. Arrival correctness itself is
// covered by march.e2e / occupy-march.e2e; here we only assert the occupancy side effects.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  findMarchPath,
  MARCH_SPEED_SEC_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
  npcGarrison,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

// Reuse the card-slg fake-meta pattern: any cardInstanceId resolves to an owned infantry card so setTeams/move
// can build a real card team without a live hero roster.
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
const DB = 'nw_world_occ_test';
const W = 's1-occ';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.occ.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Minimal in-memory Redis implementing exactly the WorldRedis surface worldsvc touches (ZSET no-op-ish + hash). */
class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    h.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async quit(): Promise<unknown> { return 'OK'; }
  /** Test helper: number of occupied tiles in a world's occ hash. */
  occSize(worldId: string): number { return this.hashes.get(`world:${worldId}:occ`)?.size ?? 0; }
  /** Test helper: parsed occupant on a given tile, or null. */
  occAt(worldId: string, tid: string): { kind: string; id: string; ownerId: string; tile: string; leaveAt: number } | null {
    const raw = this.hashes.get(`world:${worldId}:occ`)?.get(tid);
    return raw ? JSON.parse(raw) : null;
  }
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

/** Border `target` with an owned tile via the instant/test-only occupyTile so a far march clears ADR-039. */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

describe.skipIf(!mongo)('worldsvc field-occupancy index e2e (ADR-051 P1)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); }, broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); } };

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

  it('a stepping march writes the occupancy index at its current cell and clears it on arrival', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // A target a few cells away so the path has several intermediate steps to observe.
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 12, 12);
    const path = findMarchPath(W, SLG_MAP_W, SLG_MAP_H, 5, 5, target.x, target.y, new Set())!;
    expect(path.length).toBeGreaterThan(2); // need intermediate cells for the assertion to be meaningful
    await connect(svc, 'a', target);

    const troops = npcGarrison(proceduralTile(W, target.x, target.y).level) + 600;
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', troops);
    // No step has fired yet → occ empty (startMarch does not write occ, only stepping does).
    expect(redis.occSize(W)).toBe(0);

    // Advance to the time the march reaches the 2nd path cell (index 1). It should occupy exactly that tile.
    const step1 = path[1]!;
    nowMs = mv.departAt + 1 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // mid-route: nothing settled
    expect(redis.occSize(W)).toBe(1);
    const occ1 = redis.occAt(W, tileId(W, step1.x, step1.y));
    expect(occ1).not.toBeNull();
    expect(occ1!.kind).toBe('march');
    expect(occ1!.id).toBe(mv.marchId);
    expect(occ1!.ownerId).toBe('a');

    // Advance to an intermediate cell further along; occ moves with the march (still exactly one occupied tile).
    const midIdx = Math.min(path.length - 2, 2);
    const midCell = path[midIdx]!;
    nowMs = mv.departAt + midIdx * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0);
    expect(redis.occSize(W)).toBe(1);
    expect(redis.occAt(W, tileId(W, midCell.x, midCell.y))!.id).toBe(mv.marchId);

    // Arrival: the march settles and its occupancy entry is cleared.
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    expect(redis.occSize(W)).toBe(0);
    expect(await m.collections.marches.findOne({ _id: mv.marchId })).toBeNull();
  });

  it('recall clears the occupancy entry the outbound leg left behind', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 14, 14);
    const path = findMarchPath(W, SLG_MAP_W, SLG_MAP_H, 5, 5, target.x, target.y, new Set())!;
    expect(path.length).toBeGreaterThan(2);
    await connect(svc, 'a', target);
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    // Step the march one cell in so it holds an occupancy entry.
    nowMs = mv.departAt + 1 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0);
    expect(redis.occSize(W)).toBe(1);

    // Recall: the return leg reverts to the legacy single-arrival model and the outbound occ entry is cleared.
    const back = await svc.recallMarch(W, 'a', mv.marchId);
    expect(back.kind).toBe('return');
    expect(redis.occSize(W)).toBe(0);

    // Return leg carries no stepping cursor → it does not write occ as it travels home.
    nowMs = back.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    expect(redis.occSize(W)).toBe(0);
  });

  it('a stationed (parked) team is registered in the occupancy index with leaveAt=∞ and cleared on recall', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // A card team with some troops so the move carries a real army (occ registration is independent of troops).
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Scout', army: [{ cardInstanceId: 'card-1', col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { 'cardState.card-1': { currentTroops: 100, teamId: 't1' } as CardSLGState } },
    );
    // Move (no combat) to a nearby empty neutral/resource tile; the team parks (stations) there on arrival.
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 10, 10);
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'move', 1, 't1');
    const tid = tileId(W, target.x, target.y);

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    // Parked team is in occ at the target, tagged stationed with an effectively-infinite leaveAt.
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tid) as { kind?: string; id?: string; leaveAt?: number } | null;
    expect(occ).not.toBeNull();
    expect(occ!.kind).toBe('stationed');
    expect(occ!.id).toBe(tid);
    expect(occ!.leaveAt).toBe(Number.MAX_SAFE_INTEGER);
    // The StationedDoc itself exists.
    expect(await m.collections.stationed.findOne({ _id: tid })).not.toBeNull();

    // Recall frees the field → occupancy entry is dropped immediately.
    await svc.recallStationed(W, 'a', 't1');
    expect(redis.occSize(W)).toBe(0);
    expect(await m.collections.stationed.findOne({ _id: tid })).toBeNull();
  });
});
