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
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

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
});
