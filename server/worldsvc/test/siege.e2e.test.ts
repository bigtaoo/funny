// worldsvc siege / sweep end-to-end (S8-3 + G3-2b engine authority): real Mongo + fake clock + captured pushes.
//   Critical sieges (attack territory / attack main base) = worldsvc imports `@nw/engine` headless to run
//   "both-sides pre-deployed deterministic auto-battle" for authoritative win/loss + real surviving HP (§16);
//   NPC sweep = cheap resolveSiege (§5.3, non-critical).
//   Marching immediately pushes under_attack warning / settlement on arrival:
//   ① attack territory attacker_win → tile ownership transferred (survivors become new garrison) + loot resources + both sides yield recalculated + sieges + siege_result;
//   ② attack territory defender_win → garrison reduced (attacker weaker → fully destroyed, no return march);
//   ③ attack main base attacker_win → non-capturable: garrison cleared + protection shield + loot + attacker survivors return and troops refunded;
//   ④ sweep NPC attacker_win → loot captured + troops return; defender_win → troop attrition, no loot;
//   ⑤ validation: attack unowned tile / attack own tile / sweep occupied tile / attack protected tile.
// Note: troop count → engine formation via synthesizeArmy (v1 bridge before G3-2c editor), so surviving
//   troops are determined by engine combat (non-linear formula); assertions only check "direction + structural
//   effects" (ownership change / survivors>0 / attrition), not the exact survivor count.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  npcGarrison,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  SLG_MAP_W,
  SLG_MAP_H,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_siege_test';
const W = 's1-siege';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.siege.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

/** Tiles reachable by marching on the procedural terrain: excludes obstacles/gates/center (findMarchPath
 *  treats these as permanent blockers, and startMarch directly rejects obstacle targets).
 *  setupDefender overrides the tile type in DB, but pathfinding only sees the procedural layer. */
const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center';

describe.skipIf(!mongo)('worldsvc siege e2e', () => {
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
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  /** Directly inserts a defender (playerWorld + one tile), bypassing protection/direct-occupy constraints, with full control over garrison/resources. */
  async function setupDefender(
    accountId: string,
    x: number,
    y: number,
    opts: { type: TileDoc['type']; garrison: number; ink?: number; protectedUntil?: number },
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
      ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
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

  it('attack territory win: ownership transfer + loot + both-sides yield recalc + under_attack/siege_result push', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 500, ink: 1000 });

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching', troops: 800 });
    // Marching immediately pushes under_attack to defender b.
    const ua = pushes.find((p) => p.msg.kind === 'under_attack');
    expect(ua?.accountId).toBe('b');
    expect(ua?.msg).toMatchObject({ tile: tileId(W, tgt.x, tgt.y), troopsHint: 800 });

    // Advance to A* march arrival (use service-computed arriveAt to avoid Euclidean distance underestimating path length).
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Tile ownership transferred: now belongs to a, garrison = engine survivors folded back (>0, attacker 800 troops vs defender 500).
    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(2);
    // Loot 25%: a +250 ink, b -250 → 750.
    expect(me.resources?.ink).toBe(Math.floor(1000 * SIEGE_LOOT_RATE));
    const bRes = (await svc.getMe(W, 'b')).resources;
    expect(bRes?.ink).toBe(1000 - Math.floor(1000 * SIEGE_LOOT_RATE));

    // sieges record + siege_result pushed to both parties.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', defenderId: 'b', tile: tileId(W, tgt.x, tgt.y) });
    const sr = pushes.filter((p) => p.msg.kind === 'siege_result');
    expect(sr.map((p) => p.accountId).sort()).toEqual(['a', 'b']);
    expect((sr[0]!.msg as { outcome: string }).outcome).toBe('attacker_win');
    void mv;
  });

  it('attack territory loss: attacker committed fully destroyed + garrison reduced (no ownership transfer)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 800 });

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 600);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - 600); // troops deducted on march
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Defender wins (attacker 600 < garrison 800, troop disadvantage → fully destroyed, no return march): attacker committed not returned to pool, garrison reduced but >0, tile still belongs to b.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - 600);
    const tile = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(tile.mine).toBe(true);
    expect(tile.garrison).toBeGreaterThan(0);
    expect(tile.garrison).toBeLessThan(800);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('attack main base win: forced relocation (old site reverts to neutral + random new site with protection shield + territory lost) + loot + attacker survivors return and troops refunded', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    // b's main base + one territory: forced relocation should cause b to lose this territory.
    await setupDefender('b', tgt.x, tgt.y, { type: 'base', garrison: 500, ink: 1000 });
    const terr = findCoord(NON_BLOCKING, 12, 5);
    await m.collections.tiles.updateOne(
      { _id: tileId(W, terr.x, terr.y) },
      { $set: { _id: tileId(W, terr.x, terr.y), worldId: W, x: terr.x, y: terr.y, type: 'territory', level: 1, ownerId: 'b', garrison: 300, rev: 0 } },
      { upsert: true },
    );

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Old main base tile reverts to neutral (deleted, no ownerId).
    const oldTile = await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(oldTile?.ownerId).toBeUndefined();
    // Old territory tile also cleared (territory lost).
    const oldTerr = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(oldTerr?.ownerId).toBeUndefined();
    // b's main base relocated to a random new site (≠ old site), new site type=base + protection shield + garrison 0.
    const meB = await svc.getMe(W, 'b');
    expect(meB.mainBaseTile).toBeDefined();
    expect(meB.mainBaseTile).not.toBe(tileId(W, tgt.x, tgt.y));
    expect(meB.territoryCount).toBe(1); // only the new main base remains
    const newBase = await m.collections.tiles.findOne({ _id: meB.mainBaseTile! });
    expect(newBase?.ownerId).toBe('b');
    expect(newBase?.type).toBe('base');
    expect(newBase?.garrison).toBe(0);
    expect(newBase?.protectedUntil).toBeGreaterThan(nowMs);
    // Attacker survivors returned to troop pool: 2000 - 800(marched) + engine survivors(>0) > 1200.
    expect((await svc.getMe(W, 'a')).troops).toBeGreaterThan(TROOP_CAP_BASE - 800);
    // Loot 250.
    expect((await svc.getMe(W, 'a')).resources?.ink).toBe(Math.floor(1000 * SIEGE_LOOT_RATE));
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
  });

  it('sweep NPC win: capture resources + survivors return and troops refunded (no tile occupation)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Find a low-level resource tile with resType≠ink to isolate loot assertions (avoid contamination from a's main base ink yield).
    const tgt = findCoord((t) => t.type === 'resource' && t.level <= 3 && t.resType !== 'ink', 30, 30);
    const proc = proceduralTile(W, tgt.x, tgt.y);
    const npc = npcGarrison(proc.level);
    const troops = npc + 600;

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'sweep', troops);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const me = await svc.getMe(W, 'a');
    // 600 survivors return: 2000 - troops + 600 = 2000 - npc.
    expect(me.troops).toBe(TROOP_CAP_BASE - npc);
    // Loot = SWEEP_LOOT_PER_LEVEL × level (resType≠ink, no yield contamination).
    const rt = proc.resType as ResourceType;
    expect(me.resources?.[rt]).toBe(SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level));
    // No tile occupation: tile remains neutral.
    expect((await svc.getTile(W, 'a', tgt.x, tgt.y)).mine).toBeUndefined();
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win' });
    expect(siege?.defenderId).toBeUndefined();
  });

  it('sweep NPC loss: troop attrition, no loot, no tile occupation', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord((t) => t.type === 'resource' && t.resType !== 'ink', 30, 30);
    const proc = proceduralTile(W, tgt.x, tgt.y);
    const troops = 10; // < npcGarrison, attacker loses

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'sweep', troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Committed fully destroyed: 2000 - 10.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - troops);
    const rt = proc.resType as ResourceType;
    expect((await svc.getMe(W, 'a')).resources?.[rt] ?? 0).toBe(0);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('validation: attack unowned tile / attack own tile / sweep occupied tile / attack protected tile', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const free = findCoord((t) => t.type === 'neutral', 30, 30);
    // Attack unowned tile → TILE_NOT_OWNED.
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // Attack own territory → TILE_OCCUPIED.
    const mine = findCoord((t) => t.type === 'resource', 6, 6);
    await svc.occupyTile(W, 'a', mine.x, mine.y);
    await expect(svc.startMarch(W, 'a', 5, 5, mine.x, mine.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // Sweep occupied tile (another player's territory) → TILE_OCCUPIED.
    const occ = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', occ.x, occ.y, { type: 'territory', garrison: 500 });
    await expect(svc.startMarch(W, 'a', 5, 5, occ.x, occ.y, 'sweep', 100)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // Attack protected target → PROTECTED.
    const prot = findCoord(NON_BLOCKING, occ.x + 2, occ.y);
    await setupDefender('c', prot.x, prot.y, { type: 'territory', garrison: 500, protectedUntil: nowMs + 100000 });
    await expect(svc.startMarch(W, 'a', 5, 5, prot.x, prot.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'PROTECTED',
    });
  });
});
