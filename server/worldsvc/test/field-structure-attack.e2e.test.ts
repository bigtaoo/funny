// worldsvc structure-durability e2e (ADR-051 §5.2, P5b→v2): a player-built structure (arrowTower / blocker) now
// wears down its own hp under attack instead of being razed the instant its tile is captured. Each cleared-garrison
// assault chips structure.hp by the surviving assault force (attack-only wear); while hp > 0 the tile does NOT change
// hands (the assault retreats), and only the blow that drops hp≤0 razes the structure AND captures the tile (an arrow
// tower's 3×3 coverage is swept on that final capture). Also covers the passiveRelocate gap: when a defeated player's
// whole territory is wiped, any arrow-tower coverage it registered is swept from the reverse index too.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  baseFootprintCells,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  baseDurabilityMax,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  type CardInstance,
  type BuildingKey,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, MarchDoc, TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldRedis } from '../src/redis';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMailClient, WorldMailContent } from '../src/mailClient';

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
const DB = 'nw_world_struct_attack_test';
const W = 's1-structatk';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.struct-attack.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    h.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> { return this.hashes.get(key)?.get(field) ?? null; }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async quit(): Promise<unknown> { return 'OK'; }
  coverSize(worldId: string): number { return this.hashes.get(`world:${worldId}:cover`)?.size ?? 0; }
  setCoverTower(worldId: string, cx: number, cy: number, ownerId: string): void {
    const tidG = tileId(worldId, cx, cy);
    for (const c of baseFootprintCells(cx, cy)) {
      if (c.x < 0 || c.y < 0 || c.x >= SLG_MAP_W || c.y >= SLG_MAP_H) continue;
      void this.hset(`world:${worldId}:cover`, tileId(worldId, c.x, c.y),
        JSON.stringify({ [tidG]: { kind: 'tower', sourceTile: tidG, ownerId } }));
    }
  }
}

interface MailCall { accountId: string; content: WorldMailContent }

describe.skipIf(!mongo)('worldsvc structure-durability e2e (ADR-051 §5.2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  const mailCalls: MailCall[] = [];
  const fakeGateway: WorldGatewayClient = { available: true, async push() {}, broadcast: () => { throw new Error('fake WorldGatewayClient.broadcast() is not stubbed in this test'); } };
  const fakeMail: WorldMailClient = {
    available: true,
    async sendSystemMail(accountId, _key, content) { mailCalls.push({ accountId, content }); },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    mailCalls.length = 0;
    redis = new FakeRedis();
    svc = new WorldService({ cols: m.collections, redis, gateway: fakeGateway, meta: fakeMeta, mail: fakeMail, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Give 'a' an owned tile bordering (tx,ty) so applySiege's arrival-time connectivity re-check passes. */
  async function connect(tx: number, ty: number): Promise<void> {
    const nx = tx - 1, ny = ty;
    await m.collections.tiles.insertOne({
      _id: tileId(W, nx, ny), worldId: W, x: nx, y: ny, type: 'territory', level: 1, ownerId: 'a', garrison: 10, rev: 0,
    } as TileDoc);
  }

  /** Insert an enemy ('b') territory tile carrying a structure (0 garrison → the assault always clears it). */
  async function enemyStructureTile(x: number, y: number, kind: 'arrowTower' | 'blocker', hp: number, hpMax: number): Promise<string> {
    const tid = tileId(W, x, y);
    await m.collections.tiles.insertOne({
      _id: tid, worldId: W, x, y, type: 'territory', level: 1, ownerId: 'b', garrison: 0,
      structure: { kind, level: 1, hp, hpMax, ownerId: 'b', builtAt: now() }, rev: 0,
    } as TileDoc);
    if (kind === 'arrowTower') redis.setCoverTower(W, x, y, 'b');
    return tid;
  }

  /** Insert an already-arrived flat-troop attack march by 'a' against (tx,ty), then settle arrivals. */
  async function attack(tx: number, ty: number, troops: number): Promise<void> {
    await m.collections.marches.insertOne({
      _id: `mA-${tx}-${ty}-${nowMs}-${troops}`, worldId: W, ownerId: 'a',
      fromTile: tileId(W, 5, 5), toTile: tileId(W, tx, ty),
      kind: 'attack', troops, departAt: nowMs, arriveAt: nowMs, status: 'marching', rev: 0,
    } as MarchDoc);
    await svc.processDueArrivals();
  }

  it('arrow tower: an assault chips hp (no capture, coverage intact); the blow to hp≤0 razes it + captures the tile + clears coverage', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tid = await enemyStructureTile(20, 5, 'arrowTower', 1000, 2000); // partially-worn tower
    await connect(20, 5);
    expect(redis.coverSize(W)).toBe(9);

    // Assault #1: 600 survivors vs 1000 hp → structure holds. Tile stays with 'b', hp 1000→400, garrison spent, coverage intact.
    await attack(20, 5, 600);
    let tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBe('b');
    expect(tile!.structure!.hp).toBe(400);
    expect(tile!.garrison).toBe(0);
    expect(redis.coverSize(W)).toBe(9);

    // Assault #2: 600 survivors vs 400 hp → hp≤0 → tower razed, coverage swept immediately; the tile itself now
    // enters an OCCUPY_HOLD_SEC contested hold (2026-08-09) rather than changing hands instantly — mirrors the
    // neutral-land occupation hold (ADR-037 §5.4).
    await attack(20, 5, 600);
    tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBeUndefined();
    expect(tile!.contestedBy).toBe('a');
    expect(tile!.contestedGarrison).toBe(600); // survivors become the pending garrison
    expect(tile!.structure).toBeUndefined();
    expect(redis.coverSize(W)).toBe(0); // coverage sweep is unconditional/immediate, not deferred to settlement

    // Hold elapses → ownership finalized (processDueOccupations, same machinery as any neutral-land capture).
    nowMs = tile!.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBe('a');
    expect(tile!.structure).toBeUndefined();
    expect(tile!.garrison).toBe(600); // survivors become the new garrison
    expect(redis.coverSize(W)).toBe(0);
  });

  it('blocker: same attack-wear (hold → capture), and a blocker registers no coverage to sweep', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tid = await enemyStructureTile(20, 5, 'blocker', 800, 3000);
    await connect(20, 5);
    expect(redis.coverSize(W)).toBe(0); // blockers act at pathing time, never register cover

    // Hold: 500 < 800.
    await attack(20, 5, 500);
    let tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBe('b');
    expect(tile!.structure!.hp).toBe(300);

    // Capture: 500 ≥ 300 → blocker destroyed; the tile enters an OCCUPY_HOLD_SEC contested hold (2026-08-09)
    // rather than changing hands instantly (mirrors ADR-037 §5.4's neutral-land occupation hold).
    await attack(20, 5, 500);
    tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBeUndefined();
    expect(tile!.contestedBy).toBe('a');
    expect(tile!.structure).toBeUndefined();

    // Hold elapses → ownership finalized.
    nowMs = tile!.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    tile = await m.collections.tiles.findOne({ _id: tid });
    expect(tile!.ownerId).toBe('a');
    expect(tile!.structure).toBeUndefined();
  });

  it('passiveRelocate: wiping a defeated player\'s territory sweeps its arrow-tower coverage', async () => {
    // 'b' is a defender whose base is one durability hit from destruction, plus a tower on a separate territory tile.
    const base = { x: 20, y: 40 };
    const anchor = tileId(W, base.x, base.y);
    for (const c of baseFootprintCells(base.x, base.y)) {
      const isAnchor = c.x === base.x && c.y === base.y;
      await m.collections.tiles.insertOne({
        _id: tileId(W, c.x, c.y), worldId: W, x: c.x, y: c.y, type: 'base', level: 1, ownerId: 'b',
        ...(isAnchor ? { garrison: 0, durability: 5, durabilityMax: baseDurabilityMax(0), durabilityRegenAt: now() } : { baseRing: true, baseAnchor: anchor }),
        rev: 0,
      } as TileDoc);
    }
    const buildings: Partial<Record<BuildingKey, number>> = { desk: 1 };
    await m.collections.playerWorld.insertOne({
      _id: playerWorldId(W, 'b'), worldId: W, accountId: 'b', troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE,
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 }, yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: now(), mainBaseTile: anchor, buildings, rev: 0,
    } as PlayerWorldDoc);
    // A tower on b's separate territory registers 3×3 coverage that must be swept when the territory is lost.
    await enemyStructureTile(23, 40, 'arrowTower', 2000, 2000);
    expect(redis.coverSize(W)).toBe(9);

    // 'a' clears the (undefended) base → a delayed durability hit is scheduled; settling it depletes durability → passiveRelocate.
    await svc.joinWorld(W, 'a', 5, 5);
    const { inv, army, state } = mkCards('ca', 3);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 't1', army }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: Object.fromEntries(Object.entries(state).map(([id, s]) => [`cardState.${id}`, s])) },
    );
    void inv; // fakeMeta serves any card id via CARD_INV_ANY
    // connector bordering the base footprint (two cells out; ±1 lands inside the 3×3).
    await m.collections.tiles.insertOne({
      _id: tileId(W, base.x - 2, base.y), worldId: W, x: base.x - 2, y: base.y, type: 'territory', level: 1, ownerId: 'a', garrison: 10, rev: 0,
    } as TileDoc);

    await m.collections.marches.insertOne({
      _id: `mBase-${nowMs}`, worldId: W, ownerId: 'a', fromTile: tileId(W, 5, 5), toTile: anchor,
      kind: 'attack', troops: army.length * 60, army, teamId: 't1', departAt: nowMs, arriveAt: nowMs, status: 'marching', rev: 0,
    } as MarchDoc);
    await svc.processDueArrivals();

    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    expect(await svc.processDueSiegeDamage()).toBe(1);

    // b was force-relocated (mail sent), its old territory + tower are gone, and the tower's coverage was swept.
    expect(mailCalls.some((c) => c.accountId === 'b' && c.content.subject === 'slg.city.durabilityBreached.subject')).toBe(true);
    expect(await m.collections.tiles.findOne({ _id: tileId(W, 23, 40) })).toBeNull();
    expect(redis.coverSize(W)).toBe(0);
  });

  /** Minimal card team builder (ids resolve via CARD_INV_ANY in the fake meta). */
  function mkCards(prefix: string, n: number): { inv: Record<string, CardInstance>; army: TeamTemplate['army']; state: Record<string, CardSLGState> } {
    const inv: Record<string, CardInstance> = {};
    const army: TeamTemplate['army'] = [];
    const state: Record<string, CardSLGState> = {};
    for (let i = 0; i < n; i++) {
      const id = `${prefix}${i}`;
      inv[id] = { id, defId: 'lichuang', level: 1, gear: {}, locked: false };
      army.push({ cardInstanceId: id, col: i, row: 1 });
      state[id] = { currentTroops: 60 };
    }
    return { inv, army, state };
  }
});
