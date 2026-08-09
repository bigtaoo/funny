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
  CARD_RECOVER_COIN_COST,
  strongholdGarrison,
  OCCUPY_HOLD_SEC,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldMetaClient } from '../src/metaClient';

// Every card id this suite uses (e.g. 'card-1', 'card-x') is treated as an owned 'lichuang' (infantry) card —
// setTeams resolves cardInstanceId → unitType via cardInv (CC-3; sanitizeCardArmy drops anything that doesn't
// resolve), so a Proxy stands in for a real hero-roster lookup rather than enumerating every id used below.
const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false }),
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

// Minimal card-based army entry. CC-3: setTeams resolves cardInstanceId → unitType via cardInv (CARD_INV_ANY
// above always resolves to 'lichuang'/infantry); col must be a valid attack lane, row within the combat zone.
function cardEntry(cardInstanceId: string, col = 0, row = 1): TeamTemplate['army'][number] {
  return { cardInstanceId, col, row };
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y);
        if (t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center') return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

/** Scan the map for the first stronghold tile (procedural, deterministic) — needed to exercise the
 *  defender-overflow branch of shouldUseCheapSiege (stronghold garrisons always exceed SIEGE_SYNTH_ARMY_MAX_TROOPS). */
function findStronghold(): { x: number; y: number; level: number } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      const t = proceduralTile(W, x, y);
      if (t.type === 'stronghold') return { x, y, level: t.level };
    }
  }
  throw new Error('no stronghold tile in world');
}

/** Nearest placeable capital anchor near (sx,sy) whose whole 3×3 footprint is clear (mirrors joinWorld's footprintFree). */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 1; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no base tile near stronghold');
}

const sh = findStronghold();
const strongholdBase = findNearbyBase(sh.x, sh.y);

describe.skipIf(!mongo)('CC-3 card-based SLG e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  let spentCoins: number;
  let spentOrderIds: string[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(_accountId, amount, orderId) { spentCoins += amount; spentOrderIds.push(orderId); },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    spentCoins = 0;
    spentOrderIds = [];
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      commercial: fakeCommercial,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
      meta: fakeMeta,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('joinWorld seeds the unified troop pool to the base cap and has no legacy baseTroopStock', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    // Fresh capital: desk:1, drillYard:0 → troopCapFor = TROOP_CAP_BASE; troops starts full at the cap.
    expect(pw?.troops).toBe(TROOP_CAP_BASE);
    expect(pw?.troopCap).toBe(TROOP_CAP_BASE);
    expect((pw as { baseTroopStock?: number } | null)?.baseTroopStock).toBeUndefined();
  });

  it('runMigrations folds legacy baseTroopStock into troops, refreshes troopCap, and drops the field', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    // Simulate a pre-unification doc: old base cap (2000) frozen in troopCap, plus a separate 10000 stock.
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { troops: 2000, troopCap: 2000, baseTroopStock: 10000 } as never },
    );
    await m.runMigrations();
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    // desk:1, drillYard:0 → refreshed cap = TROOP_CAP_BASE (10000); folded min(10000, 2000+10000) = 10000.
    expect(pw?.troopCap).toBe(TROOP_CAP_BASE);
    expect(pw?.troops).toBe(TROOP_CAP_BASE);
    expect((pw as { baseTroopStock?: number } | null)?.baseTroopStock).toBeUndefined();
  });

  it('setTeams with cardInstanceId — validates uniqueness across teams', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Alpha', army: [cardEntry('card-1')] },
      { id: 't2', name: 'Beta', army: [cardEntry('card-2')] },
    ];
    await svc.setTeams(W, 'a', teams);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.teams).toHaveLength(2);

    // Same card in two teams → rejected.
    await expect(svc.setTeams(W, 'a', [
      { id: 't1', name: 'A', army: [cardEntry('card-1')] },
      { id: 't2', name: 'B', army: [cardEntry('card-1', 1)] },
    ])).rejects.toThrow('multiple teams');
  });

  it('setTeams rejects team exceeding CARD_TEAM_MAX_SIZE', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 13 > CARD_TEAM_MAX_SIZE (12). Entries use valid unitType/lanes so the size cap is what rejects it.
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    const bigArmy = Array.from({ length: 13 }, (_, i) => ({
      cardInstanceId: `card-${i}`,
      unitType: 'infantry',
      col: lanes[i % lanes.length]!,
      row: 1 + Math.floor(i / lanes.length),
    }));
    await expect(svc.setTeams(W, 'a', [{ id: 't1', name: 'BigTeam', army: bigArmy }])).rejects.toThrow('max size');
  });

  it('setTeams updates cardState.teamId for assigned cards', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.setTeams(W, 'a', [
      { id: 't1', name: 'Alpha', army: [cardEntry('card-x')] },
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
      { id: 't2', name: 'New', army: [cardEntry('card-z')] },
    ]);
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.cardState?.['card-y']?.currentTroops).toBe(0);
    expect(pw?.cardState?.['card-y']?.teamId).toBeNull();
    // Resources refunded: 100 * PAPER_COST * 0.8 paper, etc.
    expect(pw?.resources?.paper).toBeGreaterThan(0);
  });

  it('distributeTroops deducts from the troop pool and adds to cardState.currentTroops', async () => {
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
    // Fresh pool = TROOP_CAP_BASE; distributing 500 to the card draws it from the same pool.
    expect(pw?.troops).toBe(TROOP_CAP_BASE - 500);
  });

  it('distributeTroops rejects if card not in a team', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.distributeTroops(W, 'a', { 'unassigned-card': 100 })).rejects.toThrow();
  });

  it('distributeTroops rejects when the troop pool is insufficient', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { troops: 10, 'cardState.card-e': { currentTroops: 0, teamId: 't1' } as CardSLGState } },
    );
    await expect(svc.distributeTroops(W, 'a', { 'card-e': 100 })).rejects.toThrow('troop stock');
  });

  it('distributeTroops: concurrent calls cannot drive the troop pool negative', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { troops: 500, 'cardState.card-race': { currentTroops: 0, teamId: 't1' } as CardSLGState } },
    );
    // 500 troops, 300 each: only one of three concurrent allocations can fit — a stale read-then-check race
    // would let all three pass and drive troops negative (500 - 900 = -400).
    const calls = Array.from({ length: 3 }, () => svc.distributeTroops(W, 'a', { 'card-race': 300 }));
    const res = await Promise.allSettled(calls);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(res.filter((r) => r.status === 'rejected').length).toBe(2);
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.troops).toBe(200);
    expect(pw?.cardState?.['card-race']?.currentTroops).toBe(300);
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
      { id: 't1', name: 'Injured', army: [cardEntry('card-inj')] },
    ])).rejects.toThrow('injured');
  });

  it('setTeams does not re-block a card already (unchanged) on an injured team while editing an unrelated team', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    // card-hurt is already on t1 and injured (e.g. it just fought) — legitimate existing state.
    const injuredUntil = nowMs + CARD_INJURY_DURATION_MS;
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Front', army: [cardEntry('card-hurt')] }]);
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-hurt': { currentTroops: 50, teamId: 't1', injuredUntil } as CardSLGState } },
    );
    // Saving an unrelated new team (t2) resends the full teams array, including t1 unchanged —
    // this must succeed even though t1 still carries the injured card.
    await expect(svc.setTeams(W, 'a', [
      { id: 't1', name: 'Front', army: [cardEntry('card-hurt')] },
      { id: 't2', name: 'Fresh', army: [cardEntry('card-other', 2, 1)] },
    ])).resolves.not.toThrow();
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

  it('recoverCard uses a distinct orderId per call, so a second recovery of the same card is not free', async () => {
    // Regression test: recoverCard used to build its commercial.spend orderId as a bare `recover:${cardInstanceId}`
    // with no per-call uniqueness (unlike every other coin-spend site in this file, which all append a
    // timestamp) — commercial's real spend() treats a repeated orderId as an idempotent no-op success without
    // re-debiting, so every recovery after the first would have been free forever for that card instance.
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    const injuredUntil1 = nowMs + CARD_INJURY_DURATION_MS;
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-r2': { currentTroops: 50, injuredUntil: injuredUntil1 } as CardSLGState } },
    );
    await svc.recoverCard(W, 'a', 'card-r2');
    // Injure the same card again (at a later point in time, as a real re-injury/recovery cycle would be),
    // then recover it a second time.
    nowMs += 5000;
    const injuredUntil2 = nowMs + CARD_INJURY_DURATION_MS + 1000;
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-r2.injuredUntil': injuredUntil2 } },
    );
    await svc.recoverCard(W, 'a', 'card-r2');
    expect(spentOrderIds).toHaveLength(2);
    expect(spentOrderIds[0]).not.toBe(spentOrderIds[1]);
    expect(spentCoins).toBe(CARD_RECOVER_COIN_COST * 2); // both recoveries actually charged
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

  // ── Troop-pool boundary fix (2026-07-15, SLG_DESIGN §4.2 / CHARACTER_CARDS_DESIGN §6.1 compliance) ──
  // A card-army march must NEVER touch playerWorld.troops: not on departure, not on any arrival outcome.
  // Its committed strength lives entirely in cardState.currentTroops.
  describe('card-army marches never touch playerWorld.troops (§6.1 boundary)', () => {
    async function connectAndDefend(accountId: string, defenderId: string, garrison: number): Promise<{ x: number; y: number }> {
      const tgt = findCoord(10, 5);
      const proc = proceduralTile(W, tgt.x, tgt.y);
      const tile: TileDoc = {
        _id: tileId(W, tgt.x, tgt.y), worldId: W, x: tgt.x, y: tgt.y,
        type: 'territory', level: proc.level, ownerId: defenderId, garrison, rev: 0,
      };
      await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
      const defPw: PlayerWorldDoc = {
        _id: playerWorldId(W, defenderId), worldId: W, accountId: defenderId,
        troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE,
        resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
        yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
        lastTickAt: nowMs, mainBaseTile: tileId(W, tgt.x, tgt.y), rev: 0,
      };
      await m.collections.playerWorld.updateOne({ _id: defPw._id }, { $set: defPw }, { upsert: true });
      // ADR-039: border the target with the instant/test-only occupyTile before attacking.
      const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of deltas) {
        const nx = tgt.x + dx, ny = tgt.y + dy;
        const t = proceduralTile(W, nx, ny);
        if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
        await svc.occupyTile(W, accountId, nx, ny);
        break;
      }
      return tgt;
    }

    it('overwhelming card team wins: playerWorld.troops unchanged; survivors land in cardState.currentTroops', async () => {
      await svc.joinWorld(W, 'a', 5, 5);
      // troopsBefore is captured AFTER connectAndDefend, since bordering the target via the test-only occupyTile
      // helper legitimately deducts GARRISON_PER_TILE from the pool (unrelated to the card-army fix under test).
      const tgt = await connectAndDefend('a', 'b', 100); // weak defender — the card team should stomp it near-losslessly
      const troopsBefore = (await svc.getMe(W, 'a')).troops;

      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { 'cardState.card-atk-1': { currentTroops: 500, teamId: 't1' } as CardSLGState } },
      );
      await svc.setTeams(W, 'a', [{ id: 't1', name: 'Assault', army: [cardEntry('card-atk-1')] }]);

      const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1');
      // A card march never deducts from the pool on departure.
      expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);

      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);

      // Pool is still untouched after arrival/settlement — the win never refunds survivors into it.
      expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
      // The card's own ledger reflects the battle outcome instead.
      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(pw?.cardState?.['card-atk-1']?.currentTroops).toBeGreaterThan(0);
    });

    it('overpowered card team loses: playerWorld.troops still unchanged (no phantom refund of the placeholder march.troops)', async () => {
      await svc.joinWorld(W, 'a', 5, 5);
      const tgt = await connectAndDefend('a', 'b', 50_000); // defender is unbeatable — attacker should be wiped
      const troopsBefore = (await svc.getMe(W, 'a')).troops;

      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { 'cardState.card-atk-2': { currentTroops: 10, teamId: 't1' } as CardSLGState } },
      );
      await svc.setTeams(W, 'a', [{ id: 't1', name: 'Doomed', army: [cardEntry('card-atk-2')] }]);
      const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1');

      nowMs = mv.arriveAt;
      expect(await svc.processDueArrivals()).toBe(1);

      // Losing a card-army siege must not add anything to the pool either.
      expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
    });
  });

  it('regression: a card team with real troops safely beating a stronghold garrison captures it via the forced cheap-siege path', async () => {
    // Stronghold/crossing garrisons always exceed SIEGE_SYNTH_ARMY_MAX_TROOPS, so shouldUseCheapSiege's
    // defender-overflow branch forces resolveSiege(attackerTroops, garrison) regardless of attacker strength
    // (see applyStrongholdSiege). Before the fix, attackerTroops for a card march was m.troops — which
    // degenerates to roughly the card-slot count (CC-3: real strength lives in cardState.currentTroops) — so
    // a card team's real strength never mattered here: it would always lose this forced-cheap fight and the
    // stronghold would stay uncaptured, no matter how many real troops were deployed.
    await svc.joinWorld(W, 'a', strongholdBase.x, strongholdBase.y);
    const garrison = strongholdGarrison(sh.level);
    // resolveSiege's cheap formula is a flat HP-difference (survivors = attackerTroops - garrison, not a
    // ratio), so the survivor FRACTION only clears the CARD_BASE_SURVIVAL(0.2) floor once attackerTroops
    // exceeds garrison by at least 25% (a modest 15-20% margin still floors) — deploy 1.7× the garrison to
    // land a clearly-above-floor result.
    const troops = Math.round(garrison * 1.7);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      {
        $set: {
          'cardState.card-sh-1': { currentTroops: troops, teamId: 't1' } as CardSLGState,
          // Maxed satchel (D-CITY-9) so the per-march carry cap (base 10,000 + 1,000/level) comfortably
          // covers a stronghold-level troop count — this test is about siege resolution, not the satchel gate.
          'buildings.satchel': 15,
        },
      },
    );
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Siegebreaker', army: [cardEntry('card-sh-1')] }]);

    const mv = await svc.startMarch(W, 'a', strongholdBase.x, strongholdBase.y, sh.x, sh.y, 'attack', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09 (ADR-062 §5.4.5): a stronghold win no longer lands instantly — it enters an OCCUPY_HOLD_SEC
    // occupation hold (still 'stronghold', no ownerId yet); settle it before asserting final ownership. The
    // regression this test guards (card team's real cardState.currentTroops strength being used for the
    // forced-cheap-siege comparison, not the card-slot-count m.troops) is unaffected by the hold delay.
    const held = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(held.contestedByMe).toBe(true);
    nowMs = held.contestedUntil ?? (mv.arriveAt + OCCUPY_HOLD_SEC * 1000);
    expect(await svc.processDueOccupations()).toBe(1);

    const tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    // A comfortable (not narrow) win should leave meaningfully more than the CARD_BASE_SURVIVAL(0.2) floor —
    // the old bug guaranteed exactly a floored, catastrophic loss here regardless of this margin.
    expect(pw?.cardState?.['card-sh-1']?.currentTroops ?? 0).toBeGreaterThan(troops * 0.3);
  });
});
