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
  MARCH_MORALE_MAX,
  moraleCombatMultiplier,
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
  t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center';

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so an attack march to a far-away target clears the new gate. Costs GARRISON_PER_TILE troops.
 */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    if (!NON_BLOCKING(proceduralTile(W, nx, ny))) continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

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
    await connect(svc, 'a', tgt); // ADR-039: border the target before attacking

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching', troops: 800 });
    // Marching immediately pushes under_attack to defender b.
    const ua = pushes.find((p) => p.msg.kind === 'under_attack');
    expect(ua?.accountId).toBe('b');
    expect(ua?.msg).toMatchObject({ tile: tileId(W, tgt.x, tgt.y), troopsHint: 800 });

    // Advance to A* march arrival (use service-computed arriveAt to avoid Euclidean distance underestimating path length).
    nowMs = mv.arriveAt;
    // Snapshot a's ink at the arrival instant BEFORE the siege/loot side-effect runs: the ADR-039
    // connector tile is a real procedural resource tile (2026-07-15 rewrite — resType is now an
    // independent per-tile draw, not a stable zone, so this connector may itself passively yield some
    // ink over the march duration) — diffing against this snapshot isolates the loot's own
    // contribution regardless of whatever incidental yield accrued while marching.
    const preLootInk = (await svc.getMe(W, 'a')).resources?.ink ?? 0;
    expect(await svc.processDueArrivals()).toBe(1);

    // Tile ownership transferred: now belongs to a, garrison = engine survivors folded back (>0, attacker 800 troops vs defender 500).
    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(11); // ADR-025: 9 base footprint cells + 1 ADR-039 connector tile + 1 captured territory tile
    // Loot 25%: a +250 ink on top of its pre-loot balance, b -250 → 750.
    expect(me.resources?.ink).toBe(preLootInk + Math.floor(1000 * SIEGE_LOOT_RATE));
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
    // Defender garrison must be large enough that the engine leaves survivors after the attacker is destroyed
    // (attacker 500 = siege minimum vs garrison 1000 → defender wins with garrison reduced but >0).
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 1000 });
    await connect(svc, 'a', tgt); // ADR-039: border the target before attacking (costs GARRISON_PER_TILE)

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 500);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE - 500); // troops deducted on march
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Defender wins (attacker 500 < garrison 1000, troop disadvantage → fully destroyed, no return march): attacker committed not returned to pool, garrison reduced but >0, tile still belongs to b.
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE - 500);
    const tile = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(tile.mine).toBe(true);
    expect(tile.garrison).toBeGreaterThan(0);
    expect(tile.garrison).toBeLessThan(1000);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('overwhelming synthesized attacker army (12,000 troops, beyond synthesizeArmy board capacity of 9,600) vs a modest garrison still resolves attacker_win via the cheap fallback', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 500 });
    await connect(svc, 'a', tgt);
    // 12,000 = the max satchel/troopCap a maxed drillYard+satchel allows (D-CITY-9); a plain (no-team) attack march
    // has no real army layout, so this goes through synthesizeArmy — well past its 9,600-troop placement capacity,
    // which used to make the real engine congest and time out (defender wins regardless of true strength).
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: { troops: 12_000, troopCap: 12_000 } },
    );

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 12_000);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    // No replay fields persisted → confirms the cheap linear path ran, not the congested real engine.
    expect(siege?.seed).toBeUndefined();
    expect(siege?.attackerArmy).toBeUndefined();
  });

  it('overwhelming synthesized defender garrison (20,000, beyond board capacity) vs a modest attacker still resolves defender_win via the cheap fallback (future-proofs a raised garrison constant)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    // No custom formation set on the tile → buildDefenderConfig falls back to synthesizeArmy('defender', 20,000),
    // itself beyond the 9,600-troop board capacity — same congestion risk on the defender side, independent of
    // the attacker. Regular tiles never carry a garrison this large today, but stronghold/crossing NPC garrisons
    // could after a future balance pass (see SLG_DESIGN_LOG.md §27), so this guards that path too.
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 20_000 });
    await connect(svc, 'a', tgt);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', OCCUPY_MIN_TROOPS);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const tile = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(tile.mine).toBe(true); // still b's — attacker did not win
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
    expect(siege?.seed).toBeUndefined();
  });

  // NOTE (ADR-026): "attack main base" is no longer an instant single-battle capture. A base now has HP + wave defenders
  // (t1..t5) + a delayed siege-value settlement (see design/DECISIONS.md ADR-026). The full base-siege lifecycle —
  // wave order, attacker survivor carry-over, defeated-team injury, out-team skip, delayed HP hit, HP depletion → forced
  // relocation — is covered end-to-end in `base-siege.e2e.test.ts`. This file now only covers the unchanged territory path.

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
    // Morale (士气): the sweep march travels an unobstructed straight Manhattan route from (5,5) → tgt (no bases/
    // crossings in between on this fixture), so the server's path-length-based morale cost matches the raw
    // Manhattan distance exactly; effective (post-morale) troops determine the cheap-formula survivor count.
    const dist = Math.abs(tgt.x - 5) + Math.abs(tgt.y - 5);
    const morale = Math.max(0, MARCH_MORALE_MAX - dist);
    const effTroops = Math.round(troops * moraleCombatMultiplier(morale));
    expect(me.troops).toBe(TROOP_CAP_BASE - troops + (effTroops - npc));
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
    const free = findCoord((t) => t.type === 'resource' || t.type === 'neutral', 30, 30);
    // Attack unowned tile → TILE_NOT_OWNED.
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // Attack own territory → TILE_OCCUPIED. Search clear of a's 3×3 base footprint (anchor (5,5) → (4,4)..(6,6)).
    const mine = findCoord((t) => t.type === 'resource', 20, 20);
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
