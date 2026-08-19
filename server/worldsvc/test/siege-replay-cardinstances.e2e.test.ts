// Regression coverage for the 2026-08-12 siege-replay-fidelity fix (see worldTypes.ts's
// SiegeReplayInputs doc comment for the full incident writeup): `combatSiege/occupationBattle.ts`
// (occupy/expulsion) and `combatSiege/arrival.ts` (attack) used to persist SiegeDoc's replay inputs
// as only `{seed, attackerArmy, defenderConfig, tileLevel}` — omitting `cardInstances`/`equipmentInv`,
// the exact inputs the REAL settlement fed into `buildSiegeBlueprints` whenever the attacker fielded a
// real card team. A from-scratch client replay reconstructed from the incomplete record therefore fell
// back to plain baseline blueprints, silently diverging from (and, in the real production case that
// surfaced this, outright reversing) the recorded `outcome`.
//
// These tests dispatch a real card-team march (setTeams + cardEntry, same pattern as
// card-slg.e2e.test.ts) through BOTH affected call sites — 'occupy' (occupationBattle.ts, the exact
// path from the zihao1 production incident) and 'attack' (arrival.ts) — then assert the persisted
// SiegeDoc AND the getSiegeReplay() response both carry cardInstances/equipmentInv, not just the
// pre-existing seed/attackerArmy/defenderConfig/tileLevel fields.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

// Same fixture shape as card-slg.e2e.test.ts: every card id resolves to an owned 'lichuang'
// (infantry) card via a Proxy, since setTeams only needs cardInstanceId → unitType resolution.
const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, gear: {}, locked: false }),
});
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() {
    return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY };
  },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_siege_replay_cardinstances_test';
const W = 's1-siege-replay-cardinstances';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.siege-replay-cardinstances.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

function cardEntry(cardInstanceId: string, col = 0, row = 1): TeamTemplate['army'][number] {
  return { cardInstanceId, col, row };
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(predicate: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number): { x: number; y: number } {
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

async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
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

describe.skipIf(!mongo)('siege replay cardInstances/equipmentInv fidelity (2026-08-12)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
  };

  async function setupDefender(accountId: string, x: number, y: number, garrison: number): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y), worldId: W, x, y, type: 'territory', level: proc.level, ownerId: accountId, garrison, rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId), worldId: W, accountId,
      troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE,
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: nowMs, mainBaseTile: tileId(W, x, y), rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: pw._id }, { $set: pw }, { upsert: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now, meta: fakeMeta });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('occupy march (the exact zihao1-incident path): card team win persists cardInstances, and getSiegeReplay returns them', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    // Pinned to level===1 (not <=2): a single card entry's real combat HP is capped at the unit
    // blueprint's base hp regardless of `currentTroops` (Unit ctor: hp=min(initialHp, bp.hp)) — only
    // the CHEAP-SIEGE RATIO CHECK sees the uncapped troop count, so this only reliably stays on the
    // guaranteed-win cheap path (troops >= garrison*10) at npcGarrison(1)=120, not npcGarrison(2)=240
    // (a level-2 target flips to the real engine, where a single ~60hp-capped unit is not a safe win).
    const target = findCoord((t) => t.type === 'resource' && t.level === 1, 30, 30);
    await connect(svc, 'a', target);

    // 9000: comfortably clears the npcGarrison(1)=120 * SIEGE_CHEAP_RATIO(10) = 1200 threshold, and
    // stays under the default per-march satchel carry cap (10000).
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { 'cardState.card-occ-1': { currentTroops: 9000, teamId: 't1' } as CardSLGState } },
    );
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'OccupyForce', army: [cardEntry('card-occ-1')] }]);

    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Sanity: the win actually landed (occupation hold started) — same assertion shape as
    // siege-crash-replay.e2e.test.ts's occupy case, confirming this test exercises a real win, not a miss.
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a', marchKind: 'occupy' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('attacker_win');

    // The actual fix under test: cardInstances must be persisted, not just seed/attackerArmy/defenderConfig.
    expect(Array.isArray(siege!.cardInstances)).toBe(true);
    expect(siege!.cardInstances!.length).toBeGreaterThan(0);
    expect(siege!.cardInstances![0]!.unitType).toBe('infantry');
    expect(siege!.equipmentInv).toBeTruthy();

    // getSiegeReplay (the client-facing read path) must surface the same fields — this is what
    // ReplayScene actually consumes; storing them on the doc alone would not have fixed the bug if the
    // read path dropped them again.
    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(Array.isArray(replay.cardInstances)).toBe(true);
    expect(replay.cardInstances).toEqual(siege!.cardInstances);
    expect(replay.equipmentInv).toEqual(siege!.equipmentInv);
  });

  it('attack march (arrival.ts territory path): card team win persists cardInstances, and getSiegeReplay returns them', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord((t) => t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center', 40, 40);
    await setupDefender('b', tgt.x, tgt.y, 100); // weak defender — the card team should win cleanly
    await connect(svc, 'a', tgt);

    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { 'cardState.card-atk-fid': { currentTroops: 2000, teamId: 't1' } as CardSLGState } },
    );
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'AttackForce', army: [cardEntry('card-atk-fid')] }]);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a', marchKind: 'attack' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('attacker_win');

    expect(Array.isArray(siege!.cardInstances)).toBe(true);
    expect(siege!.cardInstances!.length).toBeGreaterThan(0);
    expect(siege!.cardInstances![0]!.unitType).toBe('infantry');

    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(replay.cardInstances).toEqual(siege!.cardInstances);
  });

  it('flat/synthesized-army march (no card team): cardInstances stays absent — the fix must not fabricate data', async () => {
    await svc.joinWorld(W, 'a', 60, 60);
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 80, 80);
    await connect(svc, 'a', target);

    const mv = await svc.startMarch(W, 'a', 60, 60, target.x, target.y, 'occupy', 2000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a', marchKind: 'occupy' });
    expect(siege).toBeTruthy();
    expect(siege!.outcome).toBe('attacker_win');
    expect(siege!.cardInstances).toBeUndefined();

    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(replay.cardInstances).toBeUndefined();
  });
});
