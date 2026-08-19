// Regression coverage for the 2026-08-01 root-cause fix (SLG_DESIGN_LOG.md §47): a card army's real strength
// lives in cardState.currentTroops, but advanceMarch used to only check whether the JUST-FOUGHT field encounter
// itself was a win, never re-deriving the army's actual current strength afterward. A narrow ("Pyrrhic") win —
// attacker_win but attackerSurvivors near/at 0 — spreads what little survives across every card via
// computeCardStateUpdates' CARD_BASE_SURVIVAL floor (0.2), which can round every card down to exactly 0 troops
// even though the encounter itself reported "the marcher continues". Before the fix, the march would carry this
// empty shell all the way to its destination and lose a real siege it had no way to win.
//
// `runSiegeBattle` is mocked to force a deterministic Pyrrhic outcome (attacker_win, attackerSurvivors: 0) — real
// engine RNG makes "wins by exactly zero" impractical to engineer reliably via troop-count tuning alone. Every
// other siegeEngine export is passed through unmocked (importOriginal), so shouldUseCheapSiege/synthesizeArmy/
// computeCardStateUpdates etc. all run for real — only the engine's own win/loss numbers are forced.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/siegeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/siegeEngine')>();
  return {
    ...actual,
    runSiegeBattle: vi.fn(async () => ({ outcome: 'attacker_win' as const, attackerSurvivors: 0, defenderSurvivors: 0 })),
  };
});

import {
  proceduralTile,
  tileId,
  playerWorldId,
  MARCH_SPEED_SEC_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState, StationedDoc } from '../src/db';
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
const DB = 'nw_world_encounter_card_zero_test';
const W = 's1-enc-zero';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.field-encounter-card-zero.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Minimal in-memory Redis surface (occ hash only) — same shape as field-encounter.e2e.test.ts's FakeRedis. */
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
  setOcc(worldId: string, tid: string, entry: unknown): void {
    void this.hset(`world:${worldId}:occ`, tid, JSON.stringify(entry));
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

describe.skipIf(!mongo)('worldsvc field-encounter e2e — card-army zero-strength detection (SLG_DESIGN_LOG.md §47)', () => {
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

  /** A card team with `n` cards, each carrying `troopsPerCard` (small enough that CARD_BASE_SURVIVAL=0.2 rounds to 0). */
  async function setupCardTeam(accountId: string, teamId: string, n: number, troopsPerCard: number): Promise<string[]> {
    const cardIds = Array.from({ length: n }, (_, i) => `${accountId}-card${i}`);
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    await svc.setTeams(W, accountId, [{
      id: teamId, name: teamId,
      army: cardIds.map((id, i) => ({ cardInstanceId: id, col: lanes[i % lanes.length]!, row: 1 + Math.floor(i / lanes.length) })),
    }] as TeamTemplate[]);
    const set: Record<string, CardSLGState> = {};
    for (const id of cardIds) set[id] = { currentTroops: troopsPerCard, teamId };
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: Object.fromEntries(Object.entries(set).map(([id, s]) => [`cardState.${id}`, s])) },
    );
    return cardIds;
  }

  async function startAMove(dest: { x: number; y: number }): Promise<{ marchId: string; departAt: number; path: { x: number; y: number }[] }> {
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'move', 1, 'at1');
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    return { marchId: mv.marchId, departAt: mv.departAt, path: doc!.path! };
  }

  async function stationEnemyAt(T: { x: number; y: number }, cardId: string, troops: number): Promise<string> {
    const tid = tileId(W, T.x, T.y);
    await svc.setTeams(W, 'b', [{ id: 'bt1', name: 'bt1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'b') },
      { $set: { [`cardState.${cardId}`]: { currentTroops: troops, teamId: 'bt1' } as CardSLGState } },
    );
    const st: StationedDoc = {
      _id: tid, worldId: W, ownerId: 'b', tile: tid, x: T.x, y: T.y,
      teamId: 'bt1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }], troops: 1, sinceAt: now(),
    };
    await m.collections.stationed.insertOne(st);
    redis.setOcc(W, tid, { kind: 'stationed', id: tid, ownerId: 'b', teamId: 'bt1', tile: tid, leaveAt: Number.MAX_SAFE_INTEGER });
    return tid;
  }

  it('a "won" encounter that leaves every card at 0 real troops (Pyrrhic win, CARD_BASE_SURVIVAL floor rounds to 0) is treated as a full wipe: march deleted, no siege at its destination', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    // 2 troops/card * CARD_BASE_SURVIVAL(0.2) = 0.4 -> rounds to 0 for every card on a Pyrrhic (attackerSurvivors:0) win.
    await setupCardTeam('a', 'at1', 5, 2);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);
    const T = path[2]!;
    const tidT = await stationEnemyAt(T, 'b-card', 5);

    // Advance A exactly to T — the mocked engine forces attacker_win/attackerSurvivors:0 at this single encounter.
    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    const settled = await svc.processDueArrivals();

    // The fix's whole point: a "won" encounter with every card now at 0 real troops must NOT let the march
    // continue to its destination — it's removed right here, exactly like the pre-existing full-wipe path.
    expect(await m.collections.marches.findOne({ _id: marchId })).toBeNull();
    // No siege was ever recorded at the original destination (the march never got there to fight one).
    expect(await m.collections.sieges.findOne({ tile: tileId(W, dest.x, dest.y) })).toBeNull();
    // Nor was a travel-time return leg spawned — a full wipe has nothing to send home (0 survivors either way).
    expect(await m.collections.marches.findOne({ worldId: W, ownerId: 'a', kind: 'return' })).toBeNull();
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'march_update' && p.msg.status === 'recalled')).toBe(true);
    void settled;
  });

  it('sanity check: a Pyrrhic win where cards still have SOME real troops left does NOT trip the full-wipe path — the march keeps marching', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    // 10 troops/card * CARD_BASE_SURVIVAL(0.2) = 2 -> rounds to 2, still alive — the fix must not over-fire here.
    await setupCardTeam('a', 'at1', 5, 10);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);
    const T = path[2]!;
    await stationEnemyAt(T, 'b-card', 5);

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // still mid-route, not at destination yet

    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc).not.toBeNull();
    expect(aDoc!.status).toBe('marching');
    expect(aDoc!.stepIndex).toBe(2);
  });
});
