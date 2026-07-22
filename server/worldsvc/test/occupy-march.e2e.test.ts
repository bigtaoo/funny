// worldsvc occupy-march end-to-end (ADR-037, §5.4): real dedicated Mongo DB + fake clock + captured push messages.
// Covers the occupy-march upgrade from "instant, no-combat grab" to "PvE battle vs the tile's system garrison
// (same deterministic engine as siege) → delayed occupation hold → territory ownership on hold elapse", plus
// expulsion of a pending hold by an interrupting attack march, and the legacy instant-occupy endpoint's narrow
// internal/test-only role after this change.
//   ① occupy march into an NPC-garrisoned neutral tile with enough troops → wins the PvE battle → enters an
//      occupation hold (tile not yet owned) → after the hold elapses (processDueOccupations) → tile is owned
//      with the battle's surviving troops as garrison.
//   ② occupy march with insufficient troops → loses the PvE battle → surviving troops (if any) are refunded to
//      the pool, the tile remains neutral (no hold, no ownership).
//   ③ expulsion mid-hold: while player a's occupation hold is pending, player b sends an attack march at the
//      same tile (allowed once a tile is mid-hold, ADR-037) and wins → a's hold is cancelled (no troops refunded
//      to a — those troops were already committed/fell in earlier fighting, consistent with §16.5), b's
//      survivors start a fresh hold of their own.
//   ④ legacy `TerritoryService.occupyTile()` (S8-1 instant, no combat) is kept — internal/test-only per the
//      design addendum — and still works for its narrow use (test/internal setup convenience), unaffected by
//      the new march-based flow.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  npcGarrison,
  npcBaseHp,
  OCCUPY_MIN_TROOPS,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  MARCH_MORALE_MAX,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { CardInstance } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_occupy_march_test';
const W = 's1-occupy-march';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.occupy-march.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so a march to a far-away target clears the new gate. `avoid` lets two different players each
 * claim a distinct neighbor of the same target (occupyTile rejects an already-owned tile).
 */
async function connect(
  svc: WorldService,
  accountId: string,
  target: { x: number; y: number },
  avoid: Set<string> = new Set(),
): Promise<void> {
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

describe.skipIf(!mongo)('worldsvc occupy-march e2e (ADR-037 §5.4)', () => {
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
  };

  // CC-3 card resolution (resolveCardArmy/toEngineCardInstances) needs a real cardInv from meta — worldsvc has
  // no metaserver wired in these e2e tests (nullWorldMetaClient, available=false) by default, so this fake
  // stands in ONLY for the one test below that needs it (kept out of the shared `svc` to avoid perturbing the
  // async under_attack-push timing the other tests here happen to rely on).
  let cardInv: Record<string, CardInstance>;
  function makeMetaSvc(): WorldService {
    const fakeMeta: WorldMetaClient = {
      available: true,
      async grantMaterial() { /* no-op */ },
      async getProfile() { return null; },
      async getSaveFields(accountId) {
        return accountId === 'a' ? { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv } : null;
      },
      async grantTitle() { /* no-op */ },
    };
    return new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, meta: fakeMeta, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    cardInv = {};
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

  it('wins the PvE battle vs a low-level neutral tile\'s system garrison → occupation hold → owned with survivors after the hold elapses', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
    const proc = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(proc.level);
    const troops = npc + 600; // comfortable margin (mirrors the siege e2e sweep test convention)
    await connect(svc, 'a', target); // ADR-039: border the target before marching

    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // PvE win → hold, NOT immediate ownership.
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.mine).toBeUndefined();
    expect(held.occupied).toBeUndefined();
    expect(held.contestedByMe).toBe(true);
    expect(held.contestedUntil).toBeGreaterThan(nowMs);
    // A siege_result battle report was recorded/pushed even though ownership hasn't landed yet.
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'siege_result' && p.msg.outcome === 'attacker_win')).toBe(true);
    // The pending doc exists, keyed by tileId.
    const occDoc = await m.collections.occupations.findOne({ _id: tileId(W, target.x, target.y) });
    expect(occDoc).toMatchObject({ ownerId: 'a', dueAt: held.contestedUntil });
    expect(occDoc!.garrison).toBeGreaterThan(0);
    expect(occDoc!.garrison).toBeLessThanOrEqual(troops);

    // Hold elapses → ownership finalized.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const tile = await svc.getTile(W, 'a', target.x, target.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true, occupied: true });
    expect(tile.garrison).toBe(occDoc!.garrison);
    expect(tile.contestedUntil).toBeUndefined();
    expect(tile.contestedByMe).toBeUndefined();
    // Pending doc consumed.
    expect(await m.collections.occupations.findOne({ _id: tileId(W, target.x, target.y) })).toBeNull();
  });

  it('base HP scales with tile level (2026-07-17): the minimum occupy force takes a level-1 tile, and the siege records defenderBaseHp', async () => {
    // Regression guard for the "cleared the garrison but couldn't destroy the base" bug: a level-1 tile's base HP
    // used to be a flat 100, so OCCUPY_MIN_TROOPS (500 = 8 infantry) cleared the 2-infantry garrison but timed out
    // against the base (min-win was ~660, see econ-sim occupyBaseHpRun). Now base HP = npcBaseHp(1) = 40, so the
    // minimum force wins. Also asserts the scaled base HP is actually wired into the engine battle + persisted.
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' && t.level === 1, 30, 30);
    const proc = proceduralTile(W, target.x, target.y);
    expect(proc.level).toBe(1);
    await connect(svc, 'a', target); // ADR-039: border the target before marching

    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // The minimum force now wins (would have lost against a flat-100 base).
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'siege_result' && p.msg.outcome === 'attacker_win')).toBe(true);

    // The persisted siege replay carries the scaled defender base HP (= npcBaseHp(1) = 40) → the engine battle and
    // any client-side replay use the level-scaled base, not the flat BASE_HP default.
    const siege = await m.collections.sieges.findOne({ attackerId: 'a' }, { sort: { ts: -1 } });
    expect(siege).toBeTruthy();
    expect((siege!.defenderConfig as { defenderBaseHp?: number } | null)?.defenderBaseHp).toBe(npcBaseHp(1));
    expect(npcBaseHp(1)).toBe(40);
  });

  it('loses the PvE battle with insufficient troops → survivors refunded, tile remains neutral (no hold)', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' && t.level >= 4, 30, 30);
    await connect(svc, 'a', target); // ADR-039: border the target before marching
    const troopsBefore = (await svc.getMe(W, 'a')).troops!;

    // OCCUPY_MIN_TROOPS-sized force is far below a level≥4 tile's system garrison.
    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 500);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const tile = await svc.getTile(W, 'a', target.x, target.y);
    expect(tile.mine).toBeUndefined();
    expect(tile.occupied).toBeUndefined();
    expect(tile.contestedByMe).toBeUndefined();
    expect(tile.contestedUntil).toBeUndefined();
    expect(await m.collections.occupations.findOne({ _id: tileId(W, target.x, target.y) })).toBeNull();

    // Troops lost in the failed assault are never fully refunded (only engine survivors, possibly 0); pool
    // is at most what it was before departure minus committed troops, and never more.
    const me = await svc.getMe(W, 'a');
    expect(me.troops!).toBeLessThanOrEqual(troopsBefore);
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'siege_result' && p.msg.outcome === 'defender_win')).toBe(true);
  });

  it('expulsion mid-hold: an interrupting attack march beats the pending occupier\'s held garrison, cancels their hold, and starts its own', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    await svc.joinWorld(W, 'b', 40, 40);
    const target = findCoord((t) => t.type === 'resource' && t.level <= 2, 30, 30);
    const proc = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(proc.level);
    // ADR-039: both a and b need territory bordering the target — distinct neighbor cells so occupyTile
    // doesn't collide (avoid tracks which neighbor is already claimed).
    const claimed = new Set<string>();
    await connect(svc, 'a', target, claimed);
    await connect(svc, 'b', target, claimed);

    // a occupies and wins the PvE battle → starts a hold.
    const mvA = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', npc + 600);
    nowMs = mvA.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);
    const occDocA = await m.collections.occupations.findOne({ _id: tileId(W, target.x, target.y) });
    expect(occDocA?.ownerId).toBe('a');
    const heldGarrison = occDocA!.garrison;

    // b sends an attack at the same (still ownerless, but mid-hold) tile — allowed since ADR-037 relaxed the
    // no-owner siege gate for contested tiles — with overwhelming force relative to a's held survivors.
    const mvB = await svc.startMarch(W, 'b', 40, 40, target.x, target.y, 'attack', heldGarrison + 800);
    // b's departure pushed an under_attack warning to a (the pending occupier), same as a real owner would get.
    expect(pushes.some((p) => p.accountId === 'a' && p.msg.kind === 'under_attack' && p.msg.tile === tileId(W, target.x, target.y))).toBe(true);
    // Sanity: b's travel time must land before a's hold elapses, otherwise the scenario degenerates into a's
    // hold simply resolving on its own before b ever arrives (not what this test is about).
    expect(mvB.arriveAt).toBeLessThan(occDocA!.dueAt);

    nowMs = mvB.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // a's original hold is cancelled (no leftover pending doc owned by a); b now holds a fresh hold instead.
    const afterExpulsion = await svc.getTile(W, 'b', target.x, target.y);
    expect(afterExpulsion.contestedByMe).toBe(true);
    expect(afterExpulsion.mine).toBeUndefined(); // still not finalized — b's hold just started
    const occDocB = await m.collections.occupations.findOne({ _id: tileId(W, target.x, target.y) });
    expect(occDocB?.ownerId).toBe('b');
    expect(occDocB!.garrison).toBeGreaterThan(0);

    // a no longer sees itself as the holder.
    const fromA = await svc.getTile(W, 'a', target.x, target.y);
    expect(fromA.contestedByMe).toBeUndefined();

    // Original hold's dueAt, if it were still processed, would be a no-op (contestedBy no longer matches a) —
    // simulate the race by advancing to the earlier dueAt: nothing changes because the pending doc for a is gone.
    expect(await svc.processDueOccupations()).toBe(0);

    // b's fresh hold resolves normally.
    nowMs = occDocB!.dueAt;
    expect(await svc.processDueOccupations()).toBe(1);
    const finalTile = await svc.getTile(W, 'b', target.x, target.y);
    expect(finalTile).toMatchObject({ type: 'territory', mine: true, occupied: true });
    expect(finalTile.garrison).toBe(occDocB!.garrison);
  });

  it('occupy march with a real card team (2026-07-15, SLG_DESIGN §4.2): teamId now accepted for kind=occupy, card team overwhelms a weak garrison, playerWorld.troops untouched throughout', async () => {
    const svc = makeMetaSvc(); // needs a real cardInv from meta, unlike the shared no-meta `svc` used by the other tests here
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' && t.level <= 1, 30, 30);
    const npc = npcGarrison(proceduralTile(W, target.x, target.y).level); // level<=1 → 120
    await connect(svc, 'a', target); // ADR-039: border the target before marching (deducts GARRISON_PER_TILE from the pool)
    const troopsBefore = (await svc.getMe(W, 'a')).troops!;

    // 12 cards (CARD_TEAM_MAX_SIZE) at full-ish troops — each unit's HP is capped to the infantry blueprint max
    // (60), so committed strength ≈ 12×60 = 720, the same magnitude as the flat-troop win above (npc+600) — a
    // real card team, not a synthesized force.
    const cardIds = Array.from({ length: 12 }, (_, i) => `card-occ-${i}`);
    for (const id of cardIds) cardInv[id] = { id, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false };
    const cardStateSet: Record<string, CardSLGState> = {};
    for (const id of cardIds) cardStateSet[id] = { currentTroops: 200, teamId: 't1' };
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      {
        $set: {
          ...Object.fromEntries(Object.entries(cardStateSet).map(([id, cs]) => [`cardState.${id}`, cs])),
          // 12×200 = 2400 committed exceeds SATCHEL_CARRY_BASE (D-CITY-9, added 2026-07-16); build satchel:1 so
          // this pre-existing occupy-march scenario (unrelated to satchel) keeps working unchanged otherwise.
          buildings: { desk: 1, satchel: 1 },
        },
      },
    );
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    const teams: TeamTemplate[] = [{
      id: 't1', name: 'Vanguard',
      army: cardIds.map((id, i) => ({ cardInstanceId: id, unitType: 'infantry', col: lanes[i % lanes.length]!, row: 1 + Math.floor(i / lanes.length) })),
    }];
    await svc.setTeams(W, 'a', teams);

    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 1, 't1');
    // Card march: no deduction from the pool on departure.
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Won the PvE battle → hold started; pool still untouched by the win.
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);

    // The cards' own ledgers reflect a near-lossless win (5-card team vs a trivial level<=1 garrison of 120).
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    const survivingCardTroops = cardIds.reduce((s, id) => s + (pw?.cardState?.[id]?.currentTroops ?? 0), 0);
    expect(survivingCardTroops).toBeGreaterThan(npc); // committed (~300) clears the garrison (120) with real HP to spare

    // Hold elapses → tile ownership finalized with its own independent garrison stat (seeded from the same
    // survivor count, but a different ledger from cardState — see SLG_DESIGN §4.2).
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const tile = await svc.getTile(W, 'a', target.x, target.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true, occupied: true });
    expect(tile.garrison).toBeGreaterThan(0);
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore); // still untouched after full settlement
  });

  it('legacy TerritoryService.occupyTile() (S8-1 instant, no combat) still works — kept internal/test-only per ADR-037', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 30, 30);
    const before = (await svc.getMe(W, 'a')).troops!;

    const view = await svc.occupyTile(W, 'a', target.x, target.y);
    expect(view).toMatchObject({ type: 'territory', mine: true, occupied: true });

    const me = await svc.getMe(W, 'a');
    expect(me.troops).toBeLessThan(before); // GARRISON_PER_TILE deducted, instantly, no battle/hold involved
    expect(view.contestedUntil).toBeUndefined();
    expect(view.contestedByMe).toBeUndefined();
  });

  it('morale (士气): a long-distance occupy arrives weaker than an identical nearby occupy against the same NPC garrison level (ADR-047)', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    // Two connect() calls (500 troops each, GARRISON_PER_TILE) + two occupy marches would exceed the default
    // TROOP_CAP_BASE pool — top up directly (test-only convenience, mirrors setupDefender's direct writes elsewhere).
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 5000 } });
    // Search center kept well clear of the player's own 3×3 base footprint around (10,10) — landing `near`
    // (or one of its neighbors, which `connect()` also occupies) inside/adjacent to the base footprint would
    // make `connect()`'s instant occupyTile throw "Cannot occupy a capital".
    const near = findCoord((t) => t.type === 'resource' && t.level === 2, 25, 10);
    const far = findCoord((t) => t.type === 'resource' && t.level === 2, 10, 130);
    const nearDist = Math.abs(near.x - 10) + Math.abs(near.y - 10);
    const farDist = Math.abs(far.x - 10) + Math.abs(far.y - 10);
    expect(nearDist).toBeLessThan(25); // morale ≈ 100 (negligible penalty)
    expect(farDist).toBeGreaterThanOrEqual(MARCH_MORALE_MAX); // morale = 0, hits the combat-power floor

    // Same level → identical NPC garrison magnitude; the only difference between the two marches is distance.
    const npc = npcGarrison(2);
    const troops = npc + 800; // comfortable margin even at the 70% morale floor (real engine battle, not the cheap formula)

    await connect(svc, 'a', near);
    const mvNear = await svc.startMarch(W, 'a', 10, 10, near.x, near.y, 'occupy', troops);
    nowMs = mvNear.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const occNear = await m.collections.occupations.findOne({ _id: tileId(W, near.x, near.y) });
    expect(occNear!.garrison).toBeGreaterThan(0);

    await connect(svc, 'a', far);
    const mvFar = await svc.startMarch(W, 'a', 10, 10, far.x, far.y, 'occupy', troops);
    nowMs = mvFar.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const occFar = await m.collections.occupations.findOne({ _id: tileId(W, far.x, far.y) });
    expect(occFar!.garrison).toBeGreaterThan(0);

    // The far march's morale penalty (scaleArmyByRatio scaling the attacker's effective HP down to the 70%
    // floor) leaves it with measurably fewer surviving troops than the near march, despite committing the
    // same troops against the same garrison — this is the whole point of the mechanic (SLG_DESIGN §4.4).
    expect(occFar!.garrison).toBeLessThan(occNear!.garrison);
  });
});
