// Regression coverage for the 2026-08-01 traceability decision (SLG_DESIGN_LOG.md §45): a genuine engine
// crash inside runSiegeBattle used to null out the SiegeDoc's replay inputs ("cheap fallback result is
// inconsistent with engine replay → do not store"); per user feedback ("崩溃也全部存，这样才便于查找和复现问题")
// every siege-settlement call site now keeps the seed/attackerArmy/defenderConfig/tileLevel it had already
// built BEFORE the crash, so the exact inputs that crashed the engine can be pulled and replayed/reproduced
// offline later.
//
// `runSiegeBattle` (siegeEngine.ts) is mocked to always reject in this file — every test here exercises the
// crash-fallback `catch` branch specifically, never the real engine. Other test files (siege.e2e.test.ts,
// stronghold.e2e.test.ts, etc.) cover the real-engine and cheap-shortcut paths and are unaffected: `vi.mock`
// is file-scoped.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  npcGarrison,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

vi.mock('../src/siegeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/siegeEngine')>();
  return {
    ...actual,
    runSiegeBattle: vi.fn(async () => {
      throw new Error('forced engine crash for test');
    }),
  };
});

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_siege_crash_replay_test';
const W = 's1-siege-crash-replay';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.siege-crash-replay.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Pathfinding sees the procedural layer, not tiles.type overridden in DB (setupDefender below) — a march to a
 *  defender-owned tile must still land on a procedurally non-blocking cell. */
const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center';

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

async function connect(
  svc: WorldService,
  accountId: string,
  target: { x: number; y: number },
): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

describe.skipIf(!mongo)('worldsvc siege engine-crash → replay still persisted (2026-08-01)', () => {
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
  broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); },
  };

  /** Directly inserts a defender (playerWorld + one owned tile) so 'a' has a real PvP target to attack — mirrors siege.e2e.test.ts. */
  async function setupDefender(
    accountId: string,
    x: number,
    y: number,
    opts: { type: TileDoc['type']; garrison: number },
  ): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: opts.type,
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison: opts.garrison,
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId),
      worldId: W,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
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
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('territory attack: engine throws → settles via the cheap fallback but still persists + serves the replay', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 30, 30);
    // Overwhelming attacker vs. a modest garrison — a clean, deterministic win regardless of which formula settles it.
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 500 });
    await connect(svc, 'a', tgt);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 5000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // The battle still resolved (via resolveSiege, since runSiegeBattle always throws in this file) — a siege
    // must never stall a march just because the engine crashed.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('attacker_win');

    // Replay inputs are kept despite the crash — this is the actual behavior under test.
    expect(typeof siege!.seed).toBe('number');
    expect(siege!.attackerArmy?.length).toBeGreaterThan(0);
    expect(siege!.defenderConfig).toBeTruthy();
    expect(typeof siege!.tileLevel).toBe('number');

    // hasReplay surfaces true through the actual client-facing list endpoint, not just raw DB fields.
    const rows = await svc.listSieges(W, 'a');
    const row = rows.find((r) => r.siegeId === siege!._id);
    expect(row?.hasReplay).toBe(true);

    // The stored inputs are actually fetchable (getSiegeReplay's buildSiegeBattle reconstruction succeeds on
    // this valid — if crash-triggering to the real engine — data; it does not itself throw).
    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(replay.seed).toBe(siege!.seed);
    expect(Array.isArray((replay.level as { attackerArmy?: unknown }).attackerArmy)).toBe(true);
  });

  it('occupy march: engine throws mid-battle → PvE resolution still lands and the report stays replayable', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
    const proc = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(proc.level);
    const troops = npc + 600;
    await connect(svc, 'a', target);

    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // PvE win still starts an occupation hold (occupation.ts has no shouldUseCheapSiege shortcut — the ONLY
    // way this reaches resolveSiege is the forced engine crash this file mocks).
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('attacker_win');
    expect(typeof siege!.seed).toBe('number');
    expect(siege!.attackerArmy?.length).toBeGreaterThan(0);

    const rows = await svc.listSieges(W, 'a');
    expect(rows.find((r) => r.siegeId === siege!._id)?.hasReplay).toBe(true);
  });

  it('territory attack loss: engine throws → defender still holds, and the losing report is replayable too', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 60, 60);
    // A modest attacking force against a much larger garrison guarantees a loss regardless of which formula settles it.
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 5000 });
    await connect(svc, 'a', tgt);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 500);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('defender_win');
    // Losing reports are just as traceable as winning ones.
    expect(typeof siege!.seed).toBe('number');
    expect(siege!.attackerArmy?.length).toBeGreaterThan(0);
  });
});
