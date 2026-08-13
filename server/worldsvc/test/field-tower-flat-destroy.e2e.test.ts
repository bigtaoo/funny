// worldsvc arrow-tower e2e — flat (non-card) army destruction path (ADR-051 P5a, combatSiege/encounter.ts
// applyTowerDamage's `marcherDestroyed: survivors <= 0` branch for the `!aHasCard` / flat-troops-count army).
//
// This is a DEDICATED file (not added to field-tower.e2e.test.ts) because the destruction branch is
// mathematically unreachable under the real production constants: ARROW_TOWER_DMG_RATIO=0.1 always leaves a
// flat army with `troops - round(troops·0.1)` survivors, which is strictly > 0 for every troops ≥ 1 (and
// rounds to a dmg of exactly 0 — a no-op, per the `if (dmg <= 0) return noOp` guard — once troops drops to
// single digits), so repeated chips asymptotically decay toward a small positive floor and never hit exactly
// zero. Reaching the branch at all therefore requires forcing a one-shot full-ratio hit, the same "force the
// otherwise-impractical-to-engineer outcome via a narrow mock" technique field-encounter-card-zero.e2e.test.ts
// uses for its own hard-to-reach branch — scoped to its own file so the mocked ratio can't affect the
// unrelated "chip, not wipe" assertions in field-tower.e2e.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return {
    ...actual,
    // ratio=1 → dmg = min(round(troops·1), CAP) = troops (as long as troops ≤ CAP), so a single chip reduces
    // survivors to exactly 0 — the one code path (marcherDestroyed) that real gameplay constants can't reach.
    ARROW_TOWER_DMG_RATIO: 1,
  };
});

import {
  proceduralTile,
  tileId,
  playerWorldId,
  baseFootprintCells,
  MARCH_SPEED_SEC_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
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
const DB = 'nw_world_tower_flat_destroy_test';
const W = 's1-tower-flat-destroy';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.tower-flat-destroy.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Same minimal in-memory Redis surface (cover hash) as field-tower.e2e.test.ts's FakeRedis. */
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

describe.skipIf(!mongo)('worldsvc arrow-tower e2e — flat-army destruction (ARROW_TOWER_DMG_RATIO forced to 1)', () => {
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

  it('an arrow tower reduces a flat (non-card) march to exactly 0 troops → the march is destroyed mid-route (marcherDestroyed)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Flat (non-card) march: 'sweep', no teamId — plain troops-count army (the `!aHasCard` path). Kept ≤
    // ARROW_TOWER_DMG_CAP (300) so the forced ratio=1 dmg is `troops` exactly, not capped at 300.
    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'sweep', 200);
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    const path = doc!.path!;
    expect(path.length).toBeGreaterThan(3);

    // Enemy ('b') tower centered adjacent to path[2] so path[2] falls inside its 9-cell coverage but the tower's
    // own centre is off A's path (pure cover chip, not an occ hit) — same placement as field-tower.e2e.test.ts.
    const C = path[2]!;
    const G = [{ x: C.x, y: C.y + 1 }, { x: C.x, y: C.y - 1 }, { x: C.x + 1, y: C.y }, { x: C.x - 1, y: C.y }]
      .find((g) => g.x >= 0 && g.y >= 0 && g.x < SLG_MAP_W && g.y < SLG_MAP_H
        && !path.some((p) => p.x === g.x && p.y === g.y))!;
    redis.setCoverTower(W, G.x, G.y, 'b');

    nowMs = mv.departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    // advanceMarch's tower-kill branch returns true ("fully handled — do not reschedule"), the same as a real
    // arrival — processDueArrivals' count doesn't distinguish "settled at destination" from "destroyed
    // mid-route"; it only distinguishes "fully removed" (true) from "still marching, cursor persisted" (false).
    expect(await svc.processDueArrivals()).toBe(1);

    // The march is gone (wiped by tower fire before ever reaching melee) and was pushed as 'recalled'.
    expect(await m.collections.marches.findOne({ _id: mv.marchId })).toBeNull();
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'march_update' && p.msg.status === 'recalled')).toBe(true);
    // A tower kill fires no battle report (matches the pass-through "no stop, no battle report" contract).
    expect(await m.collections.sieges.findOne({ marchId: mv.marchId })).toBeNull();
    // Troops were never refunded to the pool — a tower kill is a permanent loss, same as a lost field encounter.
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw!.troops).toBeLessThan(10_000); // starting pool minus the 200 committed troops, never refunded
  });
});
