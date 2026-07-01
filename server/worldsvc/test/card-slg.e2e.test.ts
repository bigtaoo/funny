// CC-3 worldsvc card-based SLG integration tests: card army setTeams, troop distribution, post-battle cardState, injury lock, recover.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  CARD_INJURY_DURATION_MS,
  BASE_TROOP_STOCK_INITIAL,
  CARD_RECOVER_COIN_COST,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_card_slg_test';
const W = 's1-card';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.card-slg.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

// Minimal card-based army (defId must match a real CARD_DEFS key; 'scholar' maps to Infantry in cards.ts).
function cardArmy(cardInstanceId: string): TeamTemplate['army'] {
  return [{ cardInstanceId, col: 0, row: 1 }];
}

describe.skipIf(!mongo)('CC-3 card-based SLG e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  let spentCoins: number;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(_accountId, amount) { spentCoins += amount; },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    spentCoins = 0;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      commercial: fakeCommercial,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('joinWorld sets baseTroopStock to BASE_TROOP_STOCK_INITIAL', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.baseTroopStock).toBe(BASE_TROOP_STOCK_INITIAL);
  });

  it('setTeams with cardInstanceId — validates uniqueness across teams', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'card-1', col: 0, row: 1 }] },
      { id: 't2', name: 'Beta', army: [{ cardInstanceId: 'card-2', col: 0, row: 1 }] },
    ];
    await svc.setTeams(W, 'a', teams);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.teams).toHaveLength(2);

    // Same card in two teams → rejected.
    await expect(svc.setTeams(W, 'a', [
      { id: 't1', name: 'A', army: [{ cardInstanceId: 'card-1', col: 0, row: 1 }] },
      { id: 't2', name: 'B', army: [{ cardInstanceId: 'card-1', col: 1, row: 1 }] },
    ])).rejects.toThrow('multiple teams');
  });

  it('setTeams rejects team exceeding CARD_TEAM_MAX_SIZE', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const bigArmy = Array.from({ length: 13 }, (_, i) => ({
      cardInstanceId: `card-${i}`,
      col: i % 12,
      row: 1,
    }));
    await expect(svc.setTeams(W, 'a', [{ id: 't1', name: 'BigTeam', army: bigArmy }])).rejects.toThrow('max size');
  });

  it('setTeams updates cardState.teamId for assigned cards', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.setTeams(W, 'a', [
      { id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'card-x', col: 0, row: 1 }] },
    ]);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.cardState?.['card-x']?.teamId).toBe('t1');
  });

  it('setTeams clears currentTroops and refunds resources when card removed from all teams', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    // Pre-seed card with troops.
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-y': { currentTroops: 100, teamId: 't1' } as CardSLGState } },
    );
    // Remove card by saving new teams that don't include it.
    await svc.setTeams(W, 'a', [
      { id: 't2', name: 'New', army: [{ cardInstanceId: 'card-z', col: 0, row: 1 }] },
    ]);
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.cardState?.['card-y']?.currentTroops).toBe(0);
    expect(pw?.cardState?.['card-y']?.teamId).toBeNull();
    // Resources refunded: 100 * PAPER_COST * 0.8 paper, etc.
    expect(pw?.resources?.paper).toBeGreaterThan(0);
  });

  it('distributeTroops deducts from baseTroopStock and adds to cardState.currentTroops', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    // Assign card to team first.
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-d': { currentTroops: 0, teamId: 't1' } as CardSLGState } },
    );
    await svc.distributeTroops(W, 'a', { 'card-d': 500 });
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.cardState?.['card-d']?.currentTroops).toBe(500);
    expect(pw?.baseTroopStock).toBe(BASE_TROOP_STOCK_INITIAL - 500);
  });

  it('distributeTroops rejects if card not in a team', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.distributeTroops(W, 'a', { 'unassigned-card': 100 })).rejects.toThrow();
  });

  it('distributeTroops rejects when insufficient baseTroopStock', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { baseTroopStock: 10, 'cardState.card-e': { currentTroops: 0, teamId: 't1' } as CardSLGState } },
    );
    await expect(svc.distributeTroops(W, 'a', { 'card-e': 100 })).rejects.toThrow('troop stock');
  });

  it('setTeams rejects injured card', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    // Pre-seed injured card.
    const injuredUntil = nowMs + CARD_INJURY_DURATION_MS;
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-inj': { currentTroops: 50, injuredUntil } as CardSLGState } },
    );
    await expect(svc.setTeams(W, 'a', [
      { id: 't1', name: 'Injured', army: [{ cardInstanceId: 'card-inj', col: 0, row: 1 }] },
    ])).rejects.toThrow('injured');
  });

  it('recoverCard spends coins and clears injuredUntil', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    const injuredUntil = nowMs + CARD_INJURY_DURATION_MS;
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-r': { currentTroops: 50, injuredUntil } as CardSLGState } },
    );
    await svc.recoverCard(W, 'a', 'card-r');
    expect(spentCoins).toBe(CARD_RECOVER_COIN_COST);
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.cardState?.['card-r']?.injuredUntil).toBeNull();
  });

  it('recoverCard rejects if card is not injured', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-ok': { currentTroops: 100, teamId: 't1' } as CardSLGState } },
    );
    await expect(svc.recoverCard(W, 'a', 'card-ok')).rejects.toThrow('not injured');
  });
});
