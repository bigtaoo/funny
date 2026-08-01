// Regression coverage for the 2026-08-01 "return home takes travel time" unification (SLG_DESIGN_LOG.md §47):
//   ① a march that discovers its target invalidated on arrival (miss/blocked) parks in place as a StationedDoc
//      (parkMarchInPlace) instead of teleporting home instantly — only when it was team-dispatched; a teamless
//      march has no team-slot identity to park under and keeps the old instant refund;
//   ② a march that fights and loses a real battle now retreats home over a fresh travel-time 'return' MarchDoc
//      (startReturnMarch) instead of an instant pool credit — troops only land once that leg actually arrives;
//   ③ instantReturnMarch: paying coins completes an in-transit 'return' leg immediately, at a server-computed
//      cost (MARCH_RETURN_SPEEDUP_SECS_PER_COIN=60), with no client-supplied amount.
//
// `runSiegeBattle` is mocked to force a deterministic defender_win with real (non-zero) attacker survivors —
// resolveSiege's cheap linear formula always reports exactly 0 survivors on a loss (atk<def by construction), and
// tuning the real engine to lose narrowly-but-not-wiped via troop counts alone is impractical to guarantee, so a
// forced result is the reliable way to exercise "loss with something to send home". Every other siegeEngine
// export passes through unmocked (importOriginal) — synthesizeArmy/resolveCardArmy/computeCardStateUpdates etc.
// all run for real. The parkMarchInPlace tests below never reach battle resolution at all (rejected earlier by
// the "blocked" check), so the mock has no bearing on them either way.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/siegeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/siegeEngine')>();
  return {
    ...actual,
    runSiegeBattle: vi.fn(async () => ({ outcome: 'defender_win' as const, attackerSurvivors: 80, defenderSurvivors: 40 })),
  };
});

import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  MARCH_RETURN_SPEEDUP_SECS_PER_COIN,
} from '@nw/shared';
import type { TeamTemplate, CardSLGState } from '../src/db';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_march_return_test';
const W = 's1-march-return';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.march-return-travel-time.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

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

/** ADR-039: give `accountId` a tile bordering `target` via the instant/test-only occupyTile, ahead of a real march. */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }, avoid: Set<string> = new Set()): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    const key = `${nx}:${ny}`;
    if (avoid.has(key)) continue;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    avoid.add(key);
    return;
  }
  throw new Error('no connector neighbor found');
}

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

describe.skipIf(!mongo)('worldsvc march-return-travel-time e2e (SLG_DESIGN_LOG.md §47)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  let spent: { accountId: string; amount: number }[];
  let spendShouldFail: boolean;

  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); } };
  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) {
      if (spendShouldFail) throw new Error('INSUFFICIENT_FUNDS');
      spent.push({ accountId, amount });
    },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    spent = [];
    spendShouldFail = false;
    svc = new WorldService({
      cols: m.collections, redis: null, gateway: fakeGateway, meta: fakeMeta, commercial: fakeCommercial,
      mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  async function setupCardTeam(accountId: string, teamId: string, n: number, troopsPerCard: number): Promise<void> {
    const cardIds = Array.from({ length: n }, (_, i) => `${accountId}-card${i}`);
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    await svc.setTeams(W, accountId, [{
      id: teamId, name: teamId,
      army: cardIds.map((id, i) => ({ cardInstanceId: id, col: lanes[i % lanes.length]!, row: 1 + Math.floor(i / lanes.length) })),
    }] as TeamTemplate[]);
    const set: Record<string, unknown> = {};
    for (const id of cardIds) set[`cardState.${id}`] = { currentTroops: troopsPerCard, teamId } as CardSLGState;
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, accountId) }, { $set: set });
  }

  describe('parkMarchInPlace (miss/blocked on arrival)', () => {
    it('target captured by another player before arrival (blocked) → team-dispatched march parks in place as a StationedDoc, no instant refund', async () => {
      await svc.joinWorld(W, 'a', 5, 5);
      await svc.joinWorld(W, 'c', 60, 60);
      const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
      const avoid = new Set<string>();
      await connect(svc, 'a', target, avoid); // 'a' borders the target so the march is dispatchable
      await setupCardTeam('a', 't1', 3, 50);

      const before = await svc.getMe(W, 'a');
      const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', 1, 't1');
      // Race: 'c' grabs the still-neutral target instantly before 'a' arrives.
      await svc.occupyTile(W, 'c', target.x, target.y);

      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);

      // Parked, not refunded: a StationedDoc now sits on the target tile under the same team.
      const st = await m.collections.stationed.findOne({ _id: tileId(W, target.x, target.y) });
      expect(st).not.toBeNull();
      expect(st).toMatchObject({ ownerId: 'a', teamId: 't1' });
      // No return march, no march left at all (the outbound leg was consumed by parking, not by refunding).
      expect(await m.collections.marches.findOne({ worldId: W, ownerId: 'a' })).toBeNull();
      // Pool troops are a card team's — untouched throughout (CC-3: never deducted from the pool to begin with).
      const after = await svc.getMe(W, 'a');
      expect(after.troops).toBe(before.troops);
      expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'march_update' && p.msg.status === 'arrived')).toBe(true);
    });

    it('the same race with NO team attached falls back to the pre-existing instant refund (no StationedDoc)', async () => {
      await svc.joinWorld(W, 'a', 5, 5);
      await svc.joinWorld(W, 'c', 60, 60);
      const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
      const avoid = new Set<string>();
      await connect(svc, 'a', target, avoid);

      const before = await svc.getMe(W, 'a');
      const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', 500);
      await svc.occupyTile(W, 'c', target.x, target.y);

      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);

      expect(await m.collections.stationed.findOne({ _id: tileId(W, target.x, target.y) })).toBeNull();
      const after = await svc.getMe(W, 'a');
      expect(after.troops).toBe(before.troops); // committed troops refunded straight back to the pool
      expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'march_update' && p.msg.status === 'recalled')).toBe(true);
    });
  });

  describe('startReturnMarch (battle-loss survivors retreat home over travel time)', () => {
    it('losing an occupy PvE battle does not credit the pool instantly — a fresh kind:"return" march carries survivors home, credited only on its own arrival', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      const target = findCoord((t) => t.type === 'resource', 30, 30);
      await connect(svc, 'a', target);
      const troopsBefore = (await svc.getMe(W, 'a')).troops!;

      const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 500);
      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);

      // Not credited yet: the pool sits at (before minus committed), same as right after departure.
      const midway = await svc.getMe(W, 'a');
      expect(midway.troops).toBe(troopsBefore - 500);

      const backLeg = await m.collections.marches.findOne({ worldId: W, ownerId: 'a', kind: 'return' });
      expect(backLeg).not.toBeNull();
      expect(backLeg!.troops).toBe(80); // the mocked engine's attackerSurvivors
      expect(backLeg!.toTile).toBe((await svc.getMe(W, 'a')).mainBaseTile); // heads home, not the battle tile
      expect(backLeg!.status).toBe('marching');

      // Advancing to the return leg's own arrival is what actually credits the survivors.
      nowMs = backLeg!.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);
      const finalMe = await svc.getMe(W, 'a');
      expect(finalMe.troops).toBe(midway.troops! + 80);
    });
  });

  describe('instantReturnMarch (pay coins to skip the travel-time return leg)', () => {
    async function dispatchLosingOccupy(): Promise<void> {
      await svc.joinWorld(W, 'a', 10, 10);
      const target = findCoord((t) => t.type === 'resource', 30, 30);
      await connect(svc, 'a', target);
      const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 500);
      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);
    }

    it('pays the server-computed coin cost (ceil(remaining seconds / 60)) and completes the return leg immediately', async () => {
      await dispatchLosingOccupy();
      const backLeg = await m.collections.marches.findOne({ worldId: W, ownerId: 'a', kind: 'return' });
      expect(backLeg).not.toBeNull();
      const remainingSec = (backLeg!.arriveAt - nowMs) / 1000;
      const expectedCoins = Math.max(1, Math.ceil(remainingSec / MARCH_RETURN_SPEEDUP_SECS_PER_COIN));

      const before = await svc.getMe(W, 'a');
      await svc.instantReturnMarch(W, 'a', backLeg!._id);

      expect(spent).toEqual([{ accountId: 'a', amount: expectedCoins }]);
      // The return leg is gone and its troops landed immediately, without needing another processDueArrivals tick.
      expect(await m.collections.marches.findOne({ _id: backLeg!._id })).toBeNull();
      const after = await svc.getMe(W, 'a');
      expect(after.troops).toBe(before.troops! + backLeg!.troops);
    });

    it('a rejected spend (insufficient funds) leaves the return leg untouched, no troops credited', async () => {
      await dispatchLosingOccupy();
      const backLeg = await m.collections.marches.findOne({ worldId: W, ownerId: 'a', kind: 'return' });
      spendShouldFail = true;

      await expect(svc.instantReturnMarch(W, 'a', backLeg!._id)).rejects.toThrow(/INSUFFICIENT_FUNDS/);

      expect(spent).toEqual([]);
      expect(await m.collections.marches.findOne({ _id: backLeg!._id })).not.toBeNull();
    });

    it('an unknown marchId is rejected (no in-transit return march found)', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      await expect(svc.instantReturnMarch(W, 'a', 'does-not-exist')).rejects.toThrow(/no in-transit return march found/i);
      expect(spent).toEqual([]);
    });

    it('an in-transit outbound (non-return) march cannot be instant-completed', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
      await connect(svc, 'a', target);
      const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 500);
      // Still en route — never advance nowMs/settle it — so this is a genuine kind:'occupy' march, not 'return'.

      await expect(svc.instantReturnMarch(W, 'a', mv.marchId)).rejects.toThrow(/no in-transit return march found/i);
      expect(spent).toEqual([]);
    });
  });
});
