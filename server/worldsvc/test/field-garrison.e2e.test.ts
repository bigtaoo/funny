// worldsvc garrison coverage-index e2e (ADR-051 P3a): a team dispatched with the 'garrison' intent parks as a
// 驻扎 garrison and registers its 3×3 footprint in the coverage reverse index (`world:{w}:cover`, field=covered
// tileId → JSON map of sourceTile→CoverEntry); recall/abandon clears it. An 'idle' (default) move registers NO
// coverage (it only defends its own cell via the occ scenario-1 check). This mirrors field-occupancy.e2e (P2a):
// P3a only registers the index; the P3b interception check reads it. Uses the same in-memory FakeRedis.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  baseFootprintCells,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState } from '../src/db';
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
const DB = 'nw_world_garrison_test';
const W = 's1-gar';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.garrison.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  async zadd(): Promise<unknown> { return 0; }
  async zrangebyscore(): Promise<string[]> { return []; }
  async zrem(): Promise<unknown> { return 0; }
  async publish(): Promise<unknown> { return 0; }
  async get(): Promise<string | null> { return null; }
  async set(): Promise<unknown> { return 'OK'; }
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
  occSize(worldId: string): number { return this.hashes.get(`world:${worldId}:occ`)?.size ?? 0; }
  coverSize(worldId: string): number { return this.hashes.get(`world:${worldId}:cover`)?.size ?? 0; }
  coverAt(worldId: string, tid: string): Record<string, { kind: string; sourceTile: string; ownerId: string }> | null {
    const raw = this.hashes.get(`world:${worldId}:cover`)?.get(tid);
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

describe.skipIf(!mongo)('worldsvc garrison coverage e2e (ADR-051 P3a)', () => {
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

  async function setupTeam(teamId: string, cardId: string): Promise<void> {
    await svc.setTeams(W, 'a', [{ id: teamId, name: teamId, army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { [`cardState.${cardId}`]: { currentTroops: 500, teamId } as CardSLGState } },
    );
  }

  it("a garrison move registers 3×3 coverage; recall clears it, occ, and the stationed doc", async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupTeam('t1', 'card-1');
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 12, 12);
    const tid = tileId(W, target.x, target.y);
    const footprint = baseFootprintCells(target.x, target.y).filter((c) => c.x >= 0 && c.y >= 0 && c.x < SLG_MAP_W && c.y < SLG_MAP_H);
    expect(footprint.length).toBe(9); // interior tile → full 3×3

    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'move', 1, 't1', 'garrison');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Stationed as garrison, occ registered on its own cell, and coverage over the whole 3×3 footprint.
    const st = await m.collections.stationed.findOne({ _id: tid });
    expect(st!.mode).toBe('garrison');
    expect(redis.occSize(W)).toBe(1);
    expect(redis.coverSize(W)).toBe(footprint.length);
    for (const c of footprint) {
      const cov = redis.coverAt(W, tileId(W, c.x, c.y));
      expect(cov).not.toBeNull();
      expect(cov![tid]).toBeTruthy();
      expect(cov![tid]!.kind).toBe('garrison');
      expect(cov![tid]!.ownerId).toBe('a');
    }

    // getStationed surfaces the mode.
    const list = await svc.getStationed(W, 'a');
    expect(list[0]!.mode).toBe('garrison');

    // Recall drops everything: coverage, occupancy, and the stationed doc.
    await svc.recallStationed(W, 'a', 't1');
    expect(redis.coverSize(W)).toBe(0);
    expect(redis.occSize(W)).toBe(0);
    expect(await m.collections.stationed.findOne({ _id: tid })).toBeNull();
  });

  it('an idle (default) move registers occupancy but NO coverage', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupTeam('t1', 'card-1');
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 12, 12);
    const tid = tileId(W, target.x, target.y);

    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'move', 1, 't1'); // no stationMode → idle
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const st = await m.collections.stationed.findOne({ _id: tid });
    expect(st!.mode).toBe('idle');
    expect(redis.occSize(W)).toBe(1);   // occ registered (scenario-1 own-cell defence)
    expect(redis.coverSize(W)).toBe(0); // idle covers nothing
  });
});
