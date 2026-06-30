// worldsvc nation-bonus end-to-end (S8-6.5 / G1, §2.4): real Mongo + fake clock.
//   Ownership determination v1: a tile falls within the Voronoi region of a capital occupied by the tile's owner → bonus applies.
//   ① Production bonus: tiles in own capital region yield ×(1+NATION_BONUS_PRODUCTION); no national affiliation → raw yield (control case).
//   ② Defense bonus: garrison in own capital region → effective garrison ×(1+NATION_BONUS_DEFENSE), raising the conquest threshold (defender wins with equal attack);
//      no national affiliation → same attack breaks through (control case, confirming the bonus comes from nationality).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  capitalPositions,
  nearestCapitalIdx,
  tileYield,
  RESOURCE_YIELD_BASE,
  NATION_BONUS_PRODUCTION,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, NationDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_nation_test';
const W = 's1-nation';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.nation.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const CAPS = capitalPositions(SLG_MAP_W, SLG_MAP_H);

function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
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

const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center';

describe.skipIf(!mongo)('worldsvc nation-bonus e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  /** Makes an account own a capital (writes NationDoc directly, bypassing the siege nation-founding flow). */
  async function ownNation(capitalIdx: number, accountId: string): Promise<void> {
    const [cx, cy] = CAPS[capitalIdx]!;
    const doc: NationDoc = {
      _id: `nation:${W}:${capitalIdx}`,
      worldId: W,
      capitalIdx,
      x: cx,
      y: cy,
      ownerId: accountId,
      rev: 0,
    };
    await m.collections.nations.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
  }

  /** Sets up a defender directly (playerWorld + one territory tile) with full garrison control (aligned with siege.e2e). */
  async function setupDefender(accountId: string, x: number, y: number, garrison: number): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: 'territory',
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison,
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId),
      worldId: W,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { food: 0, iron: 0, wood: 0 },
      yieldRate: { food: 0, iron: 0, wood: 0 },
      lastTickAt: nowMs,
      mainBaseTile: tileId(W, x, y),
      rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: pw._id }, { $set: pw }, { upsert: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── Production bonus ──

  it('production bonus: occupy tile in own capital Voronoi region → yield ×(1+NATION_BONUS_PRODUCTION)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource', 6, 6);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    // a occupies the (5,5) main base and the capital region containing (r).
    const baseCap = nearestCapitalIdx(5, 5, CAPS);
    const rCap = nearestCapitalIdx(r.x, r.y, CAPS);
    await ownNation(baseCap, 'a');
    if (rCap !== baseCap) await ownNation(rCap, 'a');
    await svc.occupyTile(W, 'a', r.x, r.y);

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    // Resource tile yield gets the bonus: floor(base*level * 1.1).
    const rawResource = RESOURCE_YIELD_BASE * Math.max(1, proc.level);
    const expectedResource = Math.floor(rawResource * (1 + NATION_BONUS_PRODUCTION));
    // This resource type's yield comes only from this tile (main base produces food and does not pollute non-food resources). When rt==='food' the main base contribution stacks.
    if (rt !== 'food') {
      expect(rate[rt]).toBe(expectedResource);
      expect(rate[rt]).toBeGreaterThan(rawResource); // bonus is definitely applied
    } else {
      expect(rate.food).toBeGreaterThan(rawResource); // at least amplified
    }
  });

  it('control — no national affiliation: occupying the same tile yields the raw value (no bonus)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource' && t.resType !== 'food', 6, 6);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    await svc.occupyTile(W, 'a', r.x, r.y); // no capital occupied

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    expect(rate[rt]).toBe(tileYield('resource', proc.level, rt)[rt]); // raw value, no amplification
  });

  // ── Defense bonus ──

  it('defense bonus: garrison in own capital region → conquest threshold raised, defender wins with equal attack', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500);
    await ownNation(nearestCapitalIdx(tgt.x, tgt.y, CAPS), 'b');

    // Authoritative engine (G3-2b, §16): 820 troops can defeat 500 defenders (see control case below),
    // but cannot defeat the nation-bonus-boosted floor(500*1.15)=575 effective defenders → defender wins
    // (same march seed; the only variable is the +75 effective garrison from nationality).
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 820);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect((await svc.getTile(W, 'b', tgt.x, tgt.y)).mine).toBe(true); // tile did not change hands
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('control — defender has no national affiliation: same attack conquers the tile (confirms bonus comes from nationality)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500); // b is given no capital

    // Same 820 troops, same march seed, but defender has no nationality bonus (500) → tile conquered, disproving hypothesis that the prior defender win was unrelated to nationality.
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 820);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect((await svc.getTile(W, 'a', tgt.x, tgt.y)).mine).toBe(true); // tile changed hands to attacker
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
  });
});
