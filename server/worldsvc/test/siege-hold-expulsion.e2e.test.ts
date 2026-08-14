// worldsvc siege occupation-hold expulsion (2026-08-09): real Mongo + fake clock + captured pushes.
//   New scenario unlocked by the "nothing transfers instantly after a battle win" change (occupation.ts,
//   combatSiege/arrival.ts) — a PvP siege win (unlike the old instant-transfer behavior) now leaves a
//   OCCUPY_HOLD_SEC window during which the ORIGINAL owner can send a fresh attack march at the same tile and
//   fight the winner's real surviving garrison (applyOccupationExpulsion) to take it straight back, without
//   ever letting the winner's claim settle. This mirrors occupy-march.e2e.test.ts's "expulsion mid-hold" test,
//   but that one's starting hold comes from occupying NEUTRAL land (ADR-037 §5.4); this file covers the
//   PvP-siege-specific path (landSiege's writeContestedHold with a defenderId, combatSiege/arrival.ts) that the
//   memory task explicitly calls out as never having been exercised end-to-end before this change:
//   ① b sieges a's territory and wins → occupation hold (contestedBy=b, a loses ownerId/yield right away).
//   ② BEFORE b's hold elapses, a (the original owner) sends a fresh 'attack' march at the same tile — since
//      target.ownerId is now undefined and contestedBy=b with contestedUntil>now, this routes through
//      applySiege's expulsion branch (applyOccupationExpulsion), fighting b's real contestedGarrison (not a
//      re-derived NPC garrison). a wins with overwhelming force vs. b's survivors → b's OccupationDoc is
//      deleted, a starts a FRESH hold of its own (contestedBy=a); b's original dueAt, if it were still
//      processed, is a no-op (the doc it would have claimed no longer belongs to b).
//   ③ a's own hold elapses → settleOccupation lands ownerId=a: the tile is back with its original owner.
//   ④ (optional per the design task, included for completeness) the mirror case — a's counter-attack LOSES —
//      leaves b's original hold completely undisturbed; it settles normally to b.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  OCCUPY_HOLD_SEC,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_siege_hold_expulsion_test';
const W = 's1-siege-hold-expulsion';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.siege-hold-expulsion.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center';

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so a march to a far-away target clears the gate. `avoid` lets two different players each claim a
 * distinct neighbor of the same target (occupyTile rejects an already-owned tile).
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
    if (!NON_BLOCKING(proceduralTile(W, nx, ny))) continue;
    await svc.occupyTile(W, accountId, nx, ny);
    avoid.add(key);
    return;
  }
  throw new Error('no connector neighbor found');
}

describe.skipIf(!mongo)('worldsvc siege occupation-hold expulsion e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
    async broadcast(recipients, msg) { for (const accountId of recipients) pushes.push({ accountId, msg }); },
  };

  /** Directly inserts a defender (playerWorld + one tile), bypassing protection/direct-occupy constraints, with full control over garrison/resources — mirrors siege.e2e.test.ts's setupDefender. */
  async function setupDefender(
    accountId: string,
    x: number,
    y: number,
    opts: { type: TileDoc['type']; garrison: number; ink?: number },
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
      resources: { ink: opts.ink ?? 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
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

  it('a\'s counter-attack WINS during b\'s hold: cancels b\'s pending claim and starts a fresh hold of a\'s own, which settles ownership back to a', async () => {
    // a is a real (joinWorld) player who happens to already own a distant territory tile (fabricated directly,
    // like setupDefender) — a's real base gives it a troop pool + mainBaseTile for its OWN future counter-attack
    // march later, unlike siege.e2e.test.ts's NPC-only setupDefender accounts.
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('a', tgt.x, tgt.y, { type: 'territory', garrison: 3000, ink: 1000 });
    // ADR-039: a needs its OWN territory bordering tgt to send a future march there again after losing it
    // (a's real base at (5,5) is far away) — same connector trick as siege.e2e.test.ts's attacker-side `connect`.
    const claimed = new Set<string>();
    await connect(svc, 'a', tgt, claimed);

    // b, a real attacker, sieges a's territory and wins with overwhelming force.
    await svc.joinWorld(W, 'b', 40, 40);
    await connect(svc, 'b', tgt, claimed);
    const mvB = await svc.startMarch(W, 'b', 40, 40, tgt.x, tgt.y, 'attack', 4000);
    nowMs = mvB.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // b won → occupation hold, not instant capture: a already lost ownerId/yield, b's claim is still pending.
    const heldByB = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(heldByB.contestedByMe).toBe(true);
    const rawHeld = await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(rawHeld?.ownerId).toBeUndefined();
    const occDocB = await m.collections.occupations.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(occDocB).toMatchObject({ ownerId: 'b', dueAt: heldByB.contestedUntil });
    const bHeldGarrison = occDocB!.garrison;
    expect(bHeldGarrison).toBeGreaterThan(0);

    // Give a real troops (its own pool, from joinWorld) enough to overwhelm b's surviving held garrison, then
    // send a fresh 'attack' march at the SAME tile — target.ownerId is now undefined but contestedBy='b' with
    // contestedUntil>now, so this routes through applySiege's expulsion branch (applyOccupationExpulsion),
    // fighting b's REAL contestedGarrison, not a re-derived NPC garrison.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: bHeldGarrison + 2000, troopCap: bHeldGarrison + 2000 } });
    const mvA = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', bHeldGarrison + 2000);
    expect(mvA).toMatchObject({ kind: 'attack', status: 'marching' });
    // Sanity: a's counter-attack must land BEFORE b's hold elapses, otherwise the scenario degenerates into b's
    // hold simply resolving on its own before a's march even arrives (not what this test is about).
    expect(mvA.arriveAt).toBeLessThan(occDocB!.dueAt);

    nowMs = mvA.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // a's expulsion attack won: b's OccupationDoc is gone (replaced — same _id, new owner), a now holds a
    // fresh hold of its own; b no longer sees itself as the holder.
    const afterExpulsion = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(afterExpulsion.contestedByMe).toBe(true);
    expect(afterExpulsion.mine).toBeUndefined(); // not finalized yet — a's hold just started
    const occDocA = await m.collections.occupations.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(occDocA?.ownerId).toBe('a');
    expect(occDocA!.garrison).toBeGreaterThan(0);
    const fromB = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(fromB.contestedByMe).toBeUndefined();

    // The expulsion siege is recorded attacker_win against this tile. NOTE (pre-existing behavior, not a
    // regression from today's writeContestedHold/startOccupationHold split — applyOccupationExpulsion's win
    // branch has always funneled through startOccupationHold, which unconditionally records
    // `recordSiege(m, undefined, ...)`): the expelled pending occupier's id ('b') is silently dropped from the
    // siege doc's defenderId, even though a real player (not an NPC) was just expelled. Flagged in the final
    // report rather than "fixed" here per instructions to only adjust test assertions, not src/.
    const expulsionSiege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(expulsionSiege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, tgt.x, tgt.y) });
    expect(expulsionSiege?.defenderId).toBeUndefined(); // documents the current (arguably buggy) behavior
    const dueScanAtBsOldTime = await m.collections.occupations.find({ dueAt: { $lte: occDocB!.dueAt } }).toArray();
    expect(dueScanAtBsOldTime.some((d) => d._id === tileId(W, tgt.x, tgt.y) && d.ownerId === 'b')).toBe(false);

    // a's fresh hold elapses → settleOccupation lands ownerId=a: the tile is back with its original owner.
    nowMs = occDocA!.dueAt;
    expect(await svc.processDueOccupations()).toBe(1);
    const finalTile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(finalTile).toMatchObject({ type: 'territory', mine: true, occupied: true });
    expect(finalTile.garrison).toBe(occDocA!.garrison);
  });

  it('a\'s counter-attack LOSES during b\'s hold: b\'s original hold is undisturbed and settles normally to b', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('a', tgt.x, tgt.y, { type: 'territory', garrison: 3000, ink: 1000 });
    const claimed = new Set<string>();
    await connect(svc, 'a', tgt, claimed);

    await svc.joinWorld(W, 'b', 40, 40);
    await connect(svc, 'b', tgt, claimed);
    const mvB = await svc.startMarch(W, 'b', 40, 40, tgt.x, tgt.y, 'attack', 4000);
    nowMs = mvB.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const occDocB = await m.collections.occupations.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    const bHeldGarrison = occDocB!.garrison;

    // a's counter-attack this time is deliberately far too weak to beat b's held garrison (bHeldGarrison is in
    // the ~900 range from a 4000-vs-3000 siege — the legacy OCCUPY_MIN_TROOPS floor is comfortably below that).
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 500, troopCap: 500 } });
    const mvA = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 500);
    expect(mvA.arriveAt).toBeLessThan(occDocB!.dueAt);
    nowMs = mvA.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // a lost the expulsion attempt: b's original hold is completely undisturbed (same ownerId/dueAt/garrison).
    const occDocAfter = await m.collections.occupations.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(occDocAfter).toMatchObject({ ownerId: 'b', dueAt: occDocB!.dueAt, garrison: bHeldGarrison });
    const stillHeldByB = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(stillHeldByB.contestedByMe).toBe(true);

    const expulsionSiege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(expulsionSiege?.outcome).toBe('defender_win');

    // b's hold settles normally: ownerId lands on b, unaffected by a's failed counter-attack.
    nowMs = occDocB!.dueAt;
    expect(await svc.processDueOccupations()).toBe(1);
    const finalTile = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(finalTile).toMatchObject({ type: 'territory', mine: true, occupied: true });
  });
});
