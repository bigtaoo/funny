// worldsvc idle re-dispatch + in-place occupation e2e (ADR-051 P3c): a 停留 idle field team is NOT busy — it can
// be re-commanded straight from where it stands, without recalling home first. Two flows:
//   ① re-dispatch move: an idle team walks from its station cell to a NEW tile and parks there — the old station
//      doc + its occupancy entry are dropped, the new cell picks them up. No recall, no pool deduction.
//   ② in-place occupation (§4.3, the original trigger §1.1): an idle team occupies the very neutral cell it stands
//      on — a zero-distance occupy march that settles instantly through the normal applyOccupy pipeline, fights the
//      tile's NPC garrison, and on the hold's completion the cell is owned and the team stays stationed (idle) on it.
//   ③ a 驻扎 garrison stays locked (must recall first) — only 停留 idle teams are re-commandable.
// Mirrors field-garrison.e2e's harness (in-memory FakeRedis + a permissive fake meta cardInv).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  npcGarrison,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState, TileDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

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

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_redispatch_test';
const W = 's1-redis';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.redispatch.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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
  occSize(worldId: string): number { return this.hashes.get(`world:${worldId}:occ`)?.size ?? 0; }
  occHas(worldId: string, tid: string): boolean { return this.hashes.get(`world:${worldId}:occ`)?.has(tid) ?? false; }
}

function findCoord(pred: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number, avoid: Set<string> = new Set()): { x: number; y: number } {
  const cx = Math.floor(SLG_MAP_W / 2), cy = Math.floor(SLG_MAP_H / 2);
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === cx && y === cy) continue;
        if (avoid.has(`${x}:${y}`)) continue;
        if (pred(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

describe.skipIf(!mongo)('worldsvc idle re-dispatch + in-place occupation e2e (ADR-051 P3c)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); } };

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

  /** A 12-card team strong enough (12×200 committed, satchel:1 to carry it) to overwhelm a level-1 NPC garrison (120). */
  async function setupStrongTeam(teamId: string): Promise<void> {
    const cardIds = Array.from({ length: 12 }, (_, i) => `card-${teamId}-${i}`);
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    await svc.setTeams(W, 'a', [{
      id: teamId, name: teamId,
      army: cardIds.map((id, i) => ({ cardInstanceId: id, unitType: 'infantry', col: lanes[i % lanes.length]!, row: 1 + Math.floor(i / lanes.length) })),
    }] as TeamTemplate[]);
    const set: Record<string, CardSLGState> = {};
    for (const id of cardIds) set[`cardState.${id}`] = { currentTroops: 200, teamId } as CardSLGState;
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { ...set, buildings: { desk: 1, satchel: 1 } } },
    );
  }

  /** ADR-039: own a neighbor of `target` (instant/test-only occupyTile) so `target` borders the player's territory. */
  async function connect(target: { x: number; y: number }): Promise<void> {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
      const nx = target.x + dx, ny = target.y + dy;
      if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
      const t = proceduralTile(W, nx, ny);
      if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
      // A neighbor may be a base cell (if `target` borders the capital — in which case it's already connected via
      // the capital footprint) or otherwise unclaimable; skip it and try the next neighbor.
      try { await svc.occupyTile(W, 'a', nx, ny); return; } catch { /* try next neighbor */ }
    }
    throw new Error('no connector neighbor found');
  }

  /** Move `t1` to `dest` as 停留 idle (default intent) and drive the arrival; asserts it parked there. */
  async function stationIdleAt(dest: { x: number; y: number }): Promise<void> {
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'move', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const st = await m.collections.stationed.findOne({ _id: tileId(W, dest.x, dest.y) });
    expect(st?.teamId).toBe('t1');
    expect(st?.mode).toBe('idle');
  }

  it('re-dispatch move: an idle team walks from its station cell to a new tile without a recall; the old cell is freed', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupStrongTeam('t1');
    const a = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 10, 10);
    const b = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 16, 16, new Set([`${a.x}:${a.y}`]));
    const aTid = tileId(W, a.x, a.y), bTid = tileId(W, b.x, b.y);

    await stationIdleAt(a);
    expect(redis.occSize(W)).toBe(1);
    expect(redis.occHas(W, aTid)).toBe(true);
    const troopsBefore = (await svc.getMe(W, 'a')).troops;

    // Re-command the idle team straight from cell A to cell B — no recall, not rejected as TEAM_BUSY. The client
    // may pass any origin (the UI knows the station cell); the server snaps the origin to where the team stands.
    const mv = await svc.startMarch(W, 'a', a.x, a.y, b.x, b.y, 'move', 1, 't1');
    expect(mv.kind).toBe('move');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Parked on B; A is fully released (no stationed doc, no occupancy entry); exactly one occupant on the map (B).
    expect(await m.collections.stationed.findOne({ _id: aTid })).toBeNull();
    const stB = await m.collections.stationed.findOne({ _id: bTid });
    expect(stB?.teamId).toBe('t1');
    expect(stB?.mode).toBe('idle');
    expect(redis.occSize(W)).toBe(1);
    expect(redis.occHas(W, bTid)).toBe(true);
    expect(redis.occHas(W, aTid)).toBe(false);
    const list = await svc.getStationed(W, 'a');
    expect(list).toHaveLength(1);
    expect(list[0]!.x).toBe(b.x);
    // Card army → the pool is never touched by either the original station or the re-dispatch.
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
  });

  it('re-dispatch move whose new destination becomes blocked mid-flight parks the team back at its ORIGINAL station cell — never vanishes, no pool refund (regression, 2026-08-01 fix)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupStrongTeam('t1');
    const a = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 10, 10);
    const b = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 16, 16, new Set([`${a.x}:${a.y}`]));
    const aTid = tileId(W, a.x, a.y), bTid = tileId(W, b.x, b.y);

    await stationIdleAt(a);
    const troopsBefore = (await svc.getMe(W, 'a')).troops;

    // Re-command the idle team from A towards B (no recall) — same re-dispatch path as the sibling test above.
    const mv = await svc.startMarch(W, 'a', a.x, a.y, b.x, b.y, 'move', 1, 't1');
    expect(mv.kind).toBe('move');

    // Someone else claims cell B while the re-dispatched team is in transit.
    const rivalTile: TileDoc = { _id: bTid, worldId: W, x: b.x, y: b.y, type: 'territory', level: 1, ownerId: 'rival', garrison: 0, rev: 0 };
    await m.collections.tiles.updateOne({ _id: bTid }, { $set: rivalTile }, { upsert: true });

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Parks back at A (the field cell it stood on before the re-dispatch), never at B, never gone.
    expect(await m.collections.stationed.findOne({ _id: bTid })).toBeNull();
    const stA = await m.collections.stationed.findOne({ _id: aTid });
    expect(stA?.teamId).toBe('t1');
    expect(stA?.mode).toBe('idle');
    expect(redis.occSize(W)).toBe(1);
    expect(redis.occHas(W, aTid)).toBe(true);

    // Card army + idle re-dispatch → the pool was never touched at any point (dispatch, block, or park-back).
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);

    // Still recallable normally afterwards — not a dead-end state.
    const back = await svc.recallStationed(W, 'a', 't1');
    expect(await svc.getStationed(W, 'a')).toHaveLength(0);
    nowMs = (back as { arriveAt: number }).arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
  });

  it('in-place occupation (§4.3): an idle team occupies the neutral cell it stands on — a 0-distance occupy that settles to owned territory with the team still stationed', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupStrongTeam('t1');
    // Far from the base (its initial territory grant owns cells near the capital) so A is a genuinely unowned
    // neutral cell; level ≤ 1 keeps the NPC garrison (120) within the 12-card team's reach.
    const a = findCoord((t) => (t.type === 'resource' || t.type === 'neutral') && t.level <= 1, 30, 30);
    const aTid = tileId(W, a.x, a.y);
    await connect(a); // ADR-039: border A so the in-place occupy clears the connectivity gate
    await stationIdleAt(a);
    const troopsBefore = (await svc.getMe(W, 'a')).troops;

    // 就地占领: fromTile === toTile === the team's current cell. A zero-length path settles instantly.
    const npc = npcGarrison(proceduralTile(W, a.x, a.y).level);
    expect(npc).toBeGreaterThan(0);
    const mv = await svc.startMarch(W, 'a', a.x, a.y, a.x, a.y, 'occupy', 1, 't1');
    expect(mv.arriveAt).toBe(mv.departAt); // instant — no travel
    // Dispatch atomically claimed the station doc and its occupancy entry (the team is now "occupying").
    expect(await m.collections.stationed.findOne({ _id: aTid })).toBeNull();

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1); // applyOccupy: beats the NPC garrison → starts the hold
    const held = await svc.getTile(W, 'a', a.x, a.y);
    expect(held.mine).toBeFalsy();           // not owned yet — mid occupation-hold
    expect(held.contestedUntil).toBeTruthy();

    // Hold elapses → ownership settles and the capturing team stays stationed (idle) on its now-owned cell.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const owned = await svc.getTile(W, 'a', a.x, a.y);
    expect(owned.mine).toBe(true);
    const st = await m.collections.stationed.findOne({ _id: aTid });
    expect(st?.teamId).toBe('t1');
    expect(st?.mode).toBe('idle');
    expect(redis.occHas(W, aTid)).toBe(true); // re-registered as an occupant on the owned cell
    // Card army throughout → the troop pool was never charged for the occupation.
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
  });

  it('a 驻扎 garrison stays locked: it cannot be re-commanded without a recall first', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupStrongTeam('t1');
    const a = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 10, 10);
    const b = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 16, 16, new Set([`${a.x}:${a.y}`]));

    // 驻守 rule (2026-08-02): garrison only ever lands on own/allied territory — pre-own `a` so the dispatch
    // validates (the re-dispatch lock under test is orthogonal to tile ownership).
    await m.collections.tiles.updateOne(
      { _id: tileId(W, a.x, a.y) },
      { $set: { _id: tileId(W, a.x, a.y), worldId: W, x: a.x, y: a.y, type: 'territory', level: 1, ownerId: 'a', garrison: 0, rev: 0 } as TileDoc },
      { upsert: true },
    );

    // Station as 驻扎 garrison (explicit intent).
    const mv = await svc.startMarch(W, 'a', 5, 5, a.x, a.y, 'move', 1, 't1', 'garrison');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    expect((await m.collections.stationed.findOne({ _id: tileId(W, a.x, a.y) }))?.mode).toBe('garrison');

    // A garrison is busy — re-dispatch (move, in-place occupy, or attack) is rejected until it is recalled.
    await expect(svc.startMarch(W, 'a', a.x, a.y, b.x, b.y, 'move', 1, 't1')).rejects.toThrow(/marching, occupying, or stationed/i);
    await expect(svc.startMarch(W, 'a', a.x, a.y, a.x, a.y, 'occupy', 1, 't1')).rejects.toThrow(/marching, occupying, or stationed/i);
    await expect(svc.startMarch(W, 'a', a.x, a.y, b.x, b.y, 'attack', 1, 't1')).rejects.toThrow(/marching, occupying, or stationed/i);
  });

  // Feature (2026-08-08, user request, account tao): attack gets the same forward-staging parity as occupy/move —
  // a 停留 idle team standing in the field can be sent straight into a siege without first recalling it home.
  // Previously idleRedispatch only whitelisted kind 'occupy'/'move', so this same setup threw TEAM_BUSY.
  it('re-dispatch attack: an idle team launches a siege straight from its station cell — no recall, no round trip home', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await setupStrongTeam('t1');
    const a = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 10, 10);
    const target = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 16, 16, new Set([`${a.x}:${a.y}`]));
    const aTid = tileId(W, a.x, a.y);
    const targetTid = tileId(W, target.x, target.y);

    // Someone else's territory — a valid siege target.
    await m.collections.tiles.updateOne(
      { _id: targetTid },
      { $set: { _id: targetTid, worldId: W, x: target.x, y: target.y, type: 'territory', level: 1, ownerId: 'rival', garrison: 0, rev: 0 } as TileDoc },
      { upsert: true },
    );
    await connect(target); // ADR-039: border the target with own territory so the siege clears the connectivity gate

    await stationIdleAt(a);
    const troopsBefore = (await svc.getMe(W, 'a')).troops;

    // Re-command the idle team straight from its station cell A into a siege on `target` — no recall, and the
    // client's own-base coordinates (a stale/irrelevant origin for an idle re-dispatch) are ignored server-side.
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'attack', 1, 't1');
    expect(mv.kind).toBe('attack');
    expect(mv.fromTile).toBe(aTid); // departed from the field cell, not the base
    expect(mv.toTile).toBe(targetTid);
    expect(mv.teamId).toBe('t1');

    // Old station cell is claimed/freed immediately (atomic StationedDoc removal, same as move/occupy re-dispatch).
    expect(await m.collections.stationed.findOne({ _id: aTid })).toBeNull();
    expect(redis.occHas(W, aTid)).toBe(false);

    // Card army + idle re-dispatch → the pool is never touched, same exemption as move/occupy re-dispatch.
    expect((await svc.getMe(W, 'a')).troops).toBe(troopsBefore);
  });
});
