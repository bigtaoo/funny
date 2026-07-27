// worldsvc arrow-tower e2e (ADR-051 P5a): a player-built arrowTower structure registers its 3×3 footprint in the
// coverage reverse index and chips ENEMY marches that step through it — pass-through damage (min(troops·ratio,
// cap)), no stop, once per covered cell — while its own hp is untouched (only an attack march reduces it). Build
// is gated to own/family territory (never the base), demolish clears the coverage. Uses the same in-memory
// FakeRedis cover hash as field-garrison/field-encounter so the index is actually exercised.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  baseFootprintCells,
  MARCH_SPEED_SEC_PER_TILE,
  ARROW_TOWER_HP,
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
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false }),
});
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_tower_test';
const W = 's1-tower';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.tower.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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
  coverSize(worldId: string): number { return this.hashes.get(`world:${worldId}:cover`)?.size ?? 0; }
  coverAt(worldId: string, tid: string): Record<string, { kind: string; sourceTile: string; ownerId: string }> | null {
    const raw = this.hashes.get(`world:${worldId}:cover`)?.get(tid);
    return raw ? JSON.parse(raw) : null;
  }
  setCoverTower(worldId: string, cx: number, cy: number, ownerId: string): void {
    const tidG = tileId(worldId, cx, cy);
    for (const c of baseFootprintCells(cx, cy)) {
      if (c.x < 0 || c.y < 0 || c.x >= SLG_MAP_W || c.y >= SLG_MAP_H) continue;
      void this.hset(`world:${worldId}:cover`, tileId(worldId, c.x, c.y),
        JSON.stringify({ [tidG]: { kind: 'tower', sourceTile: tidG, ownerId } }));
    }
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

describe.skipIf(!mongo)('worldsvc arrow-tower e2e (ADR-051 P5a)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); } };

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

  async function setupCardArmy(accountId: string, teamId: string, cardId: string, troops: number): Promise<void> {
    await svc.setTeams(W, accountId, [{ id: teamId, name: teamId, army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { [`cardState.${cardId}`]: { currentTroops: troops, teamId } as CardSLGState } },
    );
  }

  /** Give a player a resource stockpile large enough to build anything (settle at now → no elapsed change). */
  async function stockResources(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink: 99999, paper: 99999, graphite: 99999, metal: 99999, sticker: 99999 }, lastTickAt: now() } },
    );
  }

  /** Insert an owned (non-base) territory tile for `accountId` at (x,y). */
  async function ownTile(accountId: string, x: number, y: number): Promise<string> {
    const tid = tileId(W, x, y);
    await m.collections.tiles.insertOne({
      _id: tid, worldId: W, x, y, type: 'resource', level: 3, resType: 'paper', ownerId: accountId, garrison: 100, rev: 0,
    } as TileDoc);
    return tid;
  }

  it('buildStructure(arrowTower) writes the structure + registers its 3×3 coverage; demolish clears both', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await stockResources('a');
    const tid = await ownTile('a', 20, 20); // interior tile → full 3×3 footprint

    const view = await svc.buildStructure(W, 'a', 20, 20, 'arrowTower');
    expect(view.structure?.kind).toBe('arrowTower');
    expect(view.structure?.hp).toBe(ARROW_TOWER_HP);
    expect(view.structure?.mine).toBe(true);

    const tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.structure!.kind).toBe('arrowTower');
    expect(tile!.structure!.ownerId).toBe('a');
    expect(redis.coverSize(W)).toBe(9);
    const cov = redis.coverAt(W, tileId(W, 21, 20)); // a footprint neighbour
    expect(cov![tid]!.kind).toBe('tower');
    expect(cov![tid]!.ownerId).toBe('a');

    await svc.demolishStructure(W, 'a', 20, 20);
    expect((await m.collections.tiles.findOne({ _id: tid }))!.structure).toBeUndefined();
    expect(redis.coverSize(W)).toBe(0);
  });

  it('build validation: rejects the base anchor, an already-built tile, and non-owned territory', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await stockResources('a');

    // Base anchor (5,5) → BAD_REQUEST.
    await expect(svc.buildStructure(W, 'a', 5, 5, 'arrowTower')).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Neutral (un-owned) tile → TILE_NOT_OWNED.
    await expect(svc.buildStructure(W, 'a', 30, 30, 'arrowTower')).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });

    // Own tile: first build ok, second → TILE_OCCUPIED (one structure per tile).
    await ownTile('a', 22, 22);
    await svc.buildStructure(W, 'a', 22, 22, 'blocker');
    await expect(svc.buildStructure(W, 'a', 22, 22, 'arrowTower')).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('an arrow tower chips a passing ENEMY march (troops drop, no stop, no battle report)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupCardArmy('a', 'at1', 'a-card', 5_000);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'move', 1, 'at1');
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    const path = doc!.path!;
    expect(path.length).toBeGreaterThan(3);

    // Enemy ('b') tower centered adjacent to path[2] so path[2] falls inside its 9-cell coverage but the tower's
    // own centre is off A's path (pure cover chip, not an occ hit). No stationed doc — a tower is not a team.
    const C = path[2]!;
    const G = [{ x: C.x, y: C.y + 1 }, { x: C.x, y: C.y - 1 }, { x: C.x + 1, y: C.y }, { x: C.x - 1, y: C.y }]
      .find((g) => g.x >= 0 && g.y >= 0 && g.x < SLG_MAP_W && g.y < SLG_MAP_H
        && !path.some((p) => p.x === g.x && p.y === g.y))!;
    redis.setCoverTower(W, G.x, G.y, 'b');

    nowMs = mv.departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // mid-route: A keeps marching, not settled

    // A's card army was chipped (currentTroops fell below the departure 5000), but A is NOT destroyed nor injured.
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    const cur = pw!.cardState!['a-card']!.currentTroops;
    expect(cur).toBeLessThan(5_000);
    expect(cur).toBeGreaterThan(3_000); // a chip, not a wipe
    expect(pw!.cardState!['a-card']!.injuredUntil ?? null).toBeNull();

    // A's march survives and keeps stepping; a tower fires no battle report.
    const aDoc = await m.collections.marches.findOne({ _id: mv.marchId });
    expect(aDoc!.status).toBe('marching');
    expect(await m.collections.sieges.findOne({ marchId: mv.marchId })).toBeNull();
  });
});
