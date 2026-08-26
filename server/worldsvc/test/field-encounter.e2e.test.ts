// worldsvc real-time field-encounter e2e (ADR-051 P2b): a stepping march that enters a cell already held by an
// ENEMY field unit fights it via runSiegeBattle the moment it steps on (§3.4). Two scenarios:
//   scenario 1 — the resident is a parked stationed team;
//   scenario 2 — the resident is another march still occupying the cell (occ region overlap, leaveAt > now).
// The winner keeps marching/standing with survivors; the loser is removed (§2.2). Uses the same in-memory
// FakeRedis occ hash as field-occupancy.e2e so the encounter index is actually exercised (default harness runs
// redis:null which no-ops occ writes). Outcomes are forced deterministic via an overwhelming troop disparity
// (SIEGE_CHEAP_RATIO → resolveSiege linear settlement), so we assert on doc/occ lifecycle, not exact survivors.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  baseFootprintCells,
  MARCH_SPEED_SEC_PER_TILE,
  MARCH_MORALE_MAX,
  SATCHEL_CARRY_BASE,
  SATCHEL_CARRY_STEP,
  GARRISON_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import type { CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState, StationedDoc, MarchDoc } from '../src/db';
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
const DB = 'nw_world_encounter_test';
const W = 's1-enc';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.encounter.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Same minimal in-memory Redis surface as field-occupancy.e2e (ZSET no-op + hash + occ test helpers). */
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
  occAt(worldId: string, tid: string): { kind: string; id: string; ownerId: string; tile: string; leaveAt: number } | null {
    const raw = this.hashes.get(`world:${worldId}:occ`)?.get(tid);
    return raw ? JSON.parse(raw) : null;
  }
  coverSize(worldId: string): number { return this.hashes.get(`world:${worldId}:cover`)?.size ?? 0; }
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

describe.skipIf(!mongo)('worldsvc field-encounter e2e (ADR-051 P2b)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  const fakeGateway: WorldGatewayClient = { available: true, async push(a, msg) { pushes.push({ accountId: a, msg }); }, broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); } };

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

  /**
   * Set a card team on a player + its deployed troop count in cardState, and grant whatever satchel level that
   * deployment needs to be legal at departure (startMarch's SATCHEL_CAP_EXCEEDED check).
   *
   * The satchel level is DERIVED, not assumed: these fixtures deploy deliberately overwhelming armies (9,000+)
   * that used to fit under the no-satchel carry cap back when SATCHEL_CARRY_BASE was 10,000, and the 2026-08-25
   * re-tune (base 5,000, +1,500/level) silently turned every one of them into a departure rejection. Deriving it
   * keeps the tests about field encounters instead of about carry-cap arithmetic.
   */
  async function setupCardArmy(accountId: string, teamId: string, cardId: string, troops: number): Promise<void> {
    await svc.setTeams(W, accountId, [{ id: teamId, name: teamId, army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    const satchel = Math.max(0, Math.ceil((troops - SATCHEL_CARRY_BASE) / SATCHEL_CARRY_STEP));
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { [`cardState.${cardId}`]: { currentTroops: troops, teamId } as CardSLGState, 'buildings.satchel': satchel } },
    );
  }

  /** Start A's 'move' march to a far empty tile and return its persisted path (authoritative — A actually steps this). */
  async function startAMove(dest: { x: number; y: number }): Promise<{ marchId: string; departAt: number; path: { x: number; y: number }[] }> {
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'move', 1, 'at1');
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    return { marchId: mv.marchId, departAt: mv.departAt, path: doc!.path! };
  }

  /** Place an enemy (B) stationed team on tile T + its occupancy entry (scenario 1 resident). */
  async function stationEnemyAt(T: { x: number; y: number }, cardId: string, troops: number): Promise<string> {
    const tid = tileId(W, T.x, T.y);
    await setupCardArmy('b', 'bt1', cardId, troops);
    const st: StationedDoc = {
      _id: tid, worldId: W, ownerId: 'b', tile: tid, x: T.x, y: T.y,
      teamId: 'bt1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }], troops: 1, sinceAt: now(),
    };
    await m.collections.stationed.insertOne(st);
    redis.setOcc(W, tid, { kind: 'stationed', id: tid, ownerId: 'b', teamId: 'bt1', tile: tid, leaveAt: Number.MAX_SAFE_INTEGER });
    return tid;
  }

  /**
   * Start A's flat (non-card) 'sweep' march to a far empty tile — a plain troops-count army with no team, the
   * legacy `!aHasCard` path in resolveFieldEncounter/applyTowerDamage (synthesizeArmy at combat time, pool
   * troops deducted on departure). 'sweep' is used (not 'move', which always requires a team per startMarch)
   * and targets the same unowned resource/neutral tiles the card-army tests use.
   */
  async function startAFlatMarch(dest: { x: number; y: number }, troops: number): Promise<{ marchId: string; departAt: number; path: { x: number; y: number }[] }> {
    // Same derivation as setupCardArmy, plus a pool big enough to fund the march (a flat army is debited from
    // `troops` on departure, and TROOP_CAP_BASE is 5,000 since 2026-08-25).
    const satchel = Math.max(0, Math.ceil((troops - SATCHEL_CARRY_BASE) / SATCHEL_CARRY_STEP));
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { 'buildings.satchel': satchel, troops: troops + GARRISON_PER_TILE * 9, troopCap: troops + GARRISON_PER_TILE * 9 } },
    );
    const mv = await svc.startMarch(W, 'a', 5, 5, dest.x, dest.y, 'sweep', troops);
    const doc = await m.collections.marches.findOne({ _id: mv.marchId });
    return { marchId: mv.marchId, departAt: mv.departAt, path: doc!.path! };
  }

  /** Place an enemy (B) flat (non-card) stationed force on tile T + its occupancy entry — the `!dHasCard` path. */
  async function stationEnemyFlatAt(T: { x: number; y: number }, troops: number): Promise<string> {
    const tid = tileId(W, T.x, T.y);
    const st: StationedDoc = {
      _id: tid, worldId: W, ownerId: 'b', tile: tid, x: T.x, y: T.y,
      teamId: 'bt-flat', army: [], troops, sinceAt: now(),
    };
    await m.collections.stationed.insertOne(st);
    redis.setOcc(W, tid, { kind: 'stationed', id: tid, ownerId: 'b', teamId: 'bt-flat', tile: tid, leaveAt: Number.MAX_SAFE_INTEGER });
    return tid;
  }

  it('scenario 1 — a march wins against an enemy stationed team, destroys it, and keeps marching', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 9_000); // overwhelming attacker (>10x defender, satchel level derived in setupCardArmy)

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3); // need an intermediate cell (path[2]) that is not the destination

    const T = path[2]!;
    const tidT = await stationEnemyAt(T, 'b-card', 30); // weak defender

    // Advance A exactly to T (path[2]); the step onto T triggers the encounter, then A halts mid-route.
    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // mid-route: A did not settle at its destination

    // Enemy stationed team destroyed; its occ is gone and A now holds the cell.
    expect(await m.collections.stationed.findOne({ _id: tidT })).toBeNull();
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ).not.toBeNull();
    expect(occ!.kind).toBe('march');
    expect(occ!.id).toBe(marchId);

    // A's march survives and keeps stepping (still marching, cursor advanced to T = index 2).
    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc).not.toBeNull();
    expect(aDoc!.status).toBe('marching');
    expect(aDoc!.stepIndex).toBe(2);

    // A battle report was recorded with the attacker winning, pinned to the encounter cell.
    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege).not.toBeNull();
    expect(siege!.outcome).toBe('attacker_win');
    expect(siege!.defenderId).toBe('b');
    // marchKind='move' (not 'attack'/'occupy') is what the client's applySiegeResult would need to give A's
    // own win here a correct (non-"defender") toast — see the known follow-up flagged in SLG_DESIGN_LOG.md §51
    // (field-encounter classification is not yet wired client-side; this pins the server-side data it needs).
    expect(siege!.attackerId).toBe('a');
    expect(siege!.marchKind).toBe('move');
  });

  it('scenario 1 — a march that loses to an enemy stationed team is destroyed; the defender holds', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 30); // weak attacker

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);

    const T = path[2]!;
    const tidT = await stationEnemyAt(T, 'b-card', 3_000); // decisively stronger defender (engine battle, defender_win)

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    await svc.processDueArrivals(); // A steps into T, loses, is removed

    // A's march is gone (destroyed en route); the defender's stationed team + occ are untouched.
    expect(await m.collections.marches.findOne({ _id: marchId })).toBeNull();
    expect(await m.collections.stationed.findOne({ _id: tidT })).not.toBeNull();
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ!.kind).toBe('stationed');
    expect(occ!.id).toBe(tidT);

    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege!.outcome).toBe('defender_win');
    expect(siege!.attackerId).toBe('a');
    expect(siege!.marchKind).toBe('move');
  });

  it('scenario 1 (flat/non-card army) — a march wins against a flat enemy stationed force, destroys it, and keeps marching with scaled survivors', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    // No setTeams/cardState for 'a' — a plain flat-troops march (the `!aHasCard` branch).

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAFlatMarch(dest, 9_000); // overwhelming attacker (>10x defender)
    expect(path.length).toBeGreaterThan(3);

    const T = path[2]!;
    const tidT = await stationEnemyFlatAt(T, 30); // weak flat defender

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // mid-route: A did not settle at its destination

    // Enemy flat stationed force destroyed; its occ is gone and A now holds the cell.
    expect(await m.collections.stationed.findOne({ _id: tidT })).toBeNull();
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ!.kind).toBe('march');
    expect(occ!.id).toBe(marchId);

    // A's march survives with scaled-down (but still overwhelming) flat troops and keeps stepping.
    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc).not.toBeNull();
    expect(aDoc!.status).toBe('marching');
    expect(aDoc!.stepIndex).toBe(2);
    expect(aDoc!.troops).toBeGreaterThan(0);
    expect(aDoc!.troops).toBeLessThanOrEqual(9_000);

    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege!.outcome).toBe('attacker_win');
    expect(siege!.defenderId).toBe('b');
  });

  it('scenario 1 (flat/non-card army) — a march that loses to a flat enemy stationed force is destroyed; the defender holds with reduced troops', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAFlatMarch(dest, 30); // weak flat attacker
    expect(path.length).toBeGreaterThan(3);

    const T = path[2]!;
    const tidT = await stationEnemyFlatAt(T, 3_000); // decisively stronger flat defender (engine battle, defender_win)

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    await svc.processDueArrivals(); // A steps into T, loses, is removed

    // A's march is gone (destroyed en route); the defender's flat stationed force survives with reduced (but
    // still positive, given the lopsided troop ratio) troops — the `!dHasCard` / defStationed branch of the
    // "defender holds with reduced survivors" else-clause in resolveFieldEncounter.
    expect(await m.collections.marches.findOne({ _id: marchId })).toBeNull();
    const defAfter = await m.collections.stationed.findOne({ _id: tidT });
    expect(defAfter).not.toBeNull();
    expect(defAfter!.troops).toBeGreaterThan(0);
    expect(defAfter!.troops).toBeLessThanOrEqual(3_000);
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ!.kind).toBe('stationed');
    expect(occ!.id).toBe(tidT);

    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege!.outcome).toBe('defender_win');
    expect(siege!.attackerId).toBe('a');
  });

  it('scenario 2 — a march wins against another enemy march sharing the cell and takes it over', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 9_000); // overwhelming attacker (>10x defender, satchel level derived in setupCardArmy)
    await setupCardArmy('b', 'bt1', 'b-card', 30);      // weak resident march

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);

    const T = path[2]!;
    const tidT = tileId(W, T.x, T.y);
    // Resident enemy MARCH still occupying T (leaveAt far in the future → region overlaps A's entry). No
    // stepping cursor + far-future arriveAt so processDueArrivals never self-processes it — it just sits there.
    const bMid = 'bmarch-scn2';
    const bMarch: MarchDoc = {
      _id: bMid, worldId: W, ownerId: 'b', fromTile: tileId(W, 40, 40), toTile: tileId(W, dest.x, dest.y),
      kind: 'move', troops: 1, army: [{ cardInstanceId: 'b-card', col: 0, row: 1 }], teamId: 'bt1',
      morale: MARCH_MORALE_MAX, departAt: now() - 1000, arriveAt: now() + 10_000_000, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(bMarch);
    redis.setOcc(W, tidT, { kind: 'march', id: bMid, ownerId: 'b', teamId: 'bt1', tile: tidT, leaveAt: now() + 10_000_000 });

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // A halts mid-route after the encounter

    // Resident march destroyed; A holds the cell and keeps marching.
    expect(await m.collections.marches.findOne({ _id: bMid })).toBeNull();
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ!.kind).toBe('march');
    expect(occ!.id).toBe(marchId);
    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc!.status).toBe('marching');
    expect(aDoc!.stepIndex).toBe(2);

    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege!.outcome).toBe('attacker_win');
  });

  it('scenario 2 (flat/non-card army) — a march that loses to a resident flat enemy march is destroyed; the resident march holds with reduced troops', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAFlatMarch(dest, 30); // weak flat attacker
    expect(path.length).toBeGreaterThan(3);

    const T = path[2]!;
    const tidT = tileId(W, T.x, T.y);
    // Resident enemy MARCH (flat, no card — `!dHasCard`) still occupying T, decisively stronger than A. Same
    // no-self-processing setup as the card-based scenario-2 tests (far-future arriveAt, stationary).
    const bMid = 'bmarch-scn2-flat';
    const bMarch: MarchDoc = {
      _id: bMid, worldId: W, ownerId: 'b', fromTile: tileId(W, 40, 40), toTile: tileId(W, dest.x, dest.y),
      kind: 'move', troops: 3_000, morale: MARCH_MORALE_MAX,
      departAt: now() - 1000, arriveAt: now() + 10_000_000, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(bMarch);
    redis.setOcc(W, tidT, { kind: 'march', id: bMid, ownerId: 'b', tile: tidT, leaveAt: now() + 10_000_000 });

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    await svc.processDueArrivals(); // A steps into T, loses, is removed

    // A's march is gone (destroyed en route); the resident march SURVIVES with reduced (but still positive)
    // troops — the `!dHasCard` / defMarch branch (cols.marches.updateOne with newDefTroops/newDefArmy) of the
    // "defender holds with reduced survivors" else-clause in resolveFieldEncounter (combatSiege/encounter.ts).
    expect(await m.collections.marches.findOne({ _id: marchId })).toBeNull();
    const bAfter = await m.collections.marches.findOne({ _id: bMid });
    expect(bAfter).not.toBeNull();
    expect(bAfter!.status).toBe('marching');
    expect(bAfter!.troops).toBeGreaterThan(0);
    expect(bAfter!.troops).toBeLessThanOrEqual(3_000);
    // The updateOne's $inc: { rev: 1 } only runs on this (!dHasCard) branch — a bumped rev proves the branch
    // actually executed (troops staying numerically at 3_000, e.g. from a rounding fluke, would not).
    expect(bAfter!.rev).toBe(1);
    expect(redis.occSize(W)).toBe(1);
    const occ = redis.occAt(W, tidT);
    expect(occ!.kind).toBe('march');
    expect(occ!.id).toBe(bMid);

    const siege = await m.collections.sieges.findOne({ marchId, tile: tidT });
    expect(siege!.outcome).toBe('defender_win');
    expect(siege!.attackerId).toBe('a');
  });

  it('friendly (same-family) unit on the cell does NOT trigger an encounter', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 9_000);
    // Put A and B in the same family so B's stationed team is an ally (no fight, march passes through).
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { familyId: 'fam1' } });
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'b') }, { $set: { familyId: 'fam1' } });

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);
    const T = path[2]!;
    const tid = tileId(W, T.x, T.y);
    await setupCardArmy('b', 'bt1', 'b-card', 30);
    const st: StationedDoc = {
      _id: tid, worldId: W, ownerId: 'b', familyId: 'fam1', tile: tid, x: T.x, y: T.y,
      teamId: 'bt1', army: [{ cardInstanceId: 'b-card', col: 0, row: 1 }], troops: 1, sinceAt: now(),
    };
    await m.collections.stationed.insertOne(st);
    redis.setOcc(W, tid, { kind: 'stationed', id: tid, ownerId: 'b', familyId: 'fam1', tile: tid, leaveAt: Number.MAX_SAFE_INTEGER });

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    await svc.processDueArrivals();

    // No fight: the ally stationed team survives, and no siege report was recorded for this march.
    expect(await m.collections.stationed.findOne({ _id: tid })).not.toBeNull();
    expect(await m.collections.sieges.findOne({ marchId })).toBeNull();
    // The ally's occ entry is preserved (the passing march must NOT clobber a stationed ally out of the index).
    const occ = redis.occAt(W, tid);
    expect(occ!.kind).toBe('stationed');
    expect(occ!.id).toBe(tid);
    // A's march marches on (still alive, cursor advanced past the ally cell).
    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc!.status).toBe('marching');
  });

  /**
   * Place an enemy (B) GARRISON on a center tile G + its occ + its 3×3 coverage index (scenario 3 resident). G is
   * chosen adjacent to `near` (so `near` falls inside G's footprint) but NOT on A's path (so only the cover check —
   * not an occ scenario-1 hit — fires as A passes `near`). Returns the garrison's center tileId.
   */
  async function garrisonEnemyAround(near: { x: number; y: number }, avoid: { x: number; y: number }[], cardId: string, troops: number): Promise<string> {
    const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    const cand = dirs
      .map((d) => ({ x: near.x + d[0], y: near.y + d[1] }))
      .filter((g) => g.x >= 0 && g.y >= 0 && g.x < SLG_MAP_W && g.y < SLG_MAP_H && !avoid.some((a) => a.x === g.x && a.y === g.y));
    const G = cand[0]!;
    const tidG = tileId(W, G.x, G.y);
    await setupCardArmy('b', 'bt1', cardId, troops);
    await m.collections.stationed.insertOne({
      _id: tidG, worldId: W, ownerId: 'b', tile: tidG, x: G.x, y: G.y,
      teamId: 'bt1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }], troops: 1, sinceAt: now(), mode: 'garrison',
    });
    redis.setOcc(W, tidG, { kind: 'stationed', id: tidG, ownerId: 'b', teamId: 'bt1', tile: tidG, leaveAt: Number.MAX_SAFE_INTEGER });
    for (const c of baseFootprintCells(G.x, G.y)) {
      if (c.x < 0 || c.y < 0 || c.x >= SLG_MAP_W || c.y >= SLG_MAP_H) continue;
      await redis.hset(`world:${W}:cover`, tileId(W, c.x, c.y),
        JSON.stringify({ [tidG]: { kind: 'garrison', sourceTile: tidG, ownerId: 'b', teamId: 'bt1' } }));
    }
    return tidG;
  }

  it('scenario 3 — an enemy garrison intercepts a march passing through its 9-cell footprint (garrison wiped on loss)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 9_000); // overwhelming attacker

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);

    const C = path[2]!;                          // A passes C (not the garrison's own cell)
    const tidC = tileId(W, C.x, C.y);
    const tidG = await garrisonEnemyAround(C, [path[1]!, path[3]!], 'b-card', 30); // weak garrison off the path

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    expect(await svc.processDueArrivals()).toBe(0); // A halts mid-route after the interception

    // Garrison destroyed: its stationed doc, its occ (on G), and its whole coverage index are gone.
    expect(await m.collections.stationed.findOne({ _id: tidG })).toBeNull();
    expect(redis.coverSize(W)).toBe(0);
    // A holds the passed cell and keeps marching.
    expect(redis.occAt(W, tidC)!.id).toBe(marchId);
    const aDoc = await m.collections.marches.findOne({ _id: marchId });
    expect(aDoc!.status).toBe('marching');
    // Report recorded at the garrison's cell.
    const siege = await m.collections.sieges.findOne({ marchId, tile: tidG });
    expect(siege!.outcome).toBe('attacker_win');
  });

  it('scenario 3 — a march that loses to an intercepting garrison is destroyed; the garrison + its coverage hold', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'b', 40, 40);
    await setupCardArmy('a', 'at1', 'a-card', 30); // weak attacker

    const dest = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 5, 22);
    const { marchId, departAt, path } = await startAMove(dest);
    expect(path.length).toBeGreaterThan(3);

    const C = path[2]!;
    const tidG = await garrisonEnemyAround(C, [path[1]!, path[3]!], 'b-card', 3_000); // decisively stronger garrison

    nowMs = departAt + 2 * MARCH_SPEED_SEC_PER_TILE * 1000;
    await svc.processDueArrivals();

    // A destroyed; garrison + its coverage index untouched.
    expect(await m.collections.marches.findOne({ _id: marchId })).toBeNull();
    expect(await m.collections.stationed.findOne({ _id: tidG })).not.toBeNull();
    expect(redis.coverSize(W)).toBe(9); // full 3×3 footprint still covered (G is interior)
    const siege = await m.collections.sieges.findOne({ marchId, tile: tidG });
    expect(siege!.outcome).toBe('defender_win');
  });
});
