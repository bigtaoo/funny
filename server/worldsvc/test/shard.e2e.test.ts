// G6 multi-shard runtime scheduling e2e (§20): real dedicated Mongo DB + pure-function unit tests.
//   • Pure functions (always-run): worldShardId / shardCountForPopulation.
//   • allocateNextSeason: first season with no previous season → 1 shard; subsequent seasons open N shards
//     using snake-draft balancing based on previous-season sect strength + populate familyShard
//     (families in the same sect land in the same shard; stray families fill the shard with the fewest families).
//   • resolveShardForJoin (via resolveSeasonShard): sticky > family lookup > least-populated open shard > overflow opens new shard ($inc shardCount).
//   • patrolShardIsolation: cross-shard marches / dual-login players / orphan tiles are flagged; clean DB returns all zeros.
//   • admin /admin/world/{allocate,patrol} gated by X-Internal-Key.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  signToken, worldShardId, shardCountForPopulation,
  playerWorldId, SLG_MAP_W, SLG_MAP_H, WORLD_CAPACITY,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import {
  createWorldMongo, type WorldMongo,
  type WorldDoc, type FamilyDoc, type FamilyMemberDoc, type SeasonResultDoc, type PlayerWorldDoc, type MarchDoc, type TileDoc,
} from '../src/db';
import { WorldService } from '../src/service';
import { startHttpApi } from '../src/httpApi';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_shard_test';
const SECRET = 'test-jwt-secret';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.shard.e2e] Mongo unreachable (${URI}) — skipping.`);

// ── Pure-function unit tests (no Mongo dependency) ────────────────────────────────
describe('G6 shard pure functions (§20.3)', () => {
  it('worldShardId format = s{season}-{shard}', () => {
    expect(worldShardId(2, 0)).toBe('s2-0');
    expect(worldShardId(11, 3)).toBe('s11-3');
  });
  it('shardCountForPopulation rounds up, minimum 1', () => {
    expect(shardCountForPopulation(0, 10000)).toBe(1);   // first season with no players → 1 shard
    expect(shardCountForPopulation(1, 10000)).toBe(1);
    expect(shardCountForPopulation(10000, 10000)).toBe(1);
    expect(shardCountForPopulation(10001, 10000)).toBe(2);
    expect(shardCountForPopulation(25000, 10000)).toBe(3);
    expect(shardCountForPopulation(4, 2)).toBe(2);
    expect(shardCountForPopulation(-5, 10000)).toBe(1);  // negative input falls back to 1
  });
});

describe.skipIf(!mongo)('worldsvc G6 multi-shard runtime e2e', () => {
  const m = mongo!;
  const svc = new WorldService({
    cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => 1_700_000_000_000,
  });

  async function wipe(): Promise<void> {
    const c = m.collections;
    await Promise.all([
      c.worlds.deleteMany({}), c.families.deleteMany({}), c.familyMembers.deleteMany({}),
      c.seasonResults.deleteMany({}), c.shardAllocations.deleteMany({}),
      c.playerWorld.deleteMany({}), c.marches.deleteMany({}), c.tiles.deleteMany({}), c.nations.deleteMany({}),
    ]);
  }

  beforeEach(wipe);
  afterAll(async () => { await m.db.dropDatabase(); });

  it('allocate first season (no previous results) → shardCount=1 + opens s{season}-0', async () => {
    const res = await svc.allocateNextSeason(1, WORLD_CAPACITY);
    expect(res.shardCount).toBe(1);
    expect(res.worldIds).toEqual(['s1-0']);
    const w = await m.collections.worlds.findOne({ _id: 's1-0' });
    expect(w).toMatchObject({ season: 1, shard: 0, status: 'open', capacity: WORLD_CAPACITY, engineVersion: ENGINE_VERSION });
    const alloc = await m.collections.shardAllocations.findOne({ _id: 's1' });
    expect(alloc).toMatchObject({ season: 1, shardCount: 1 });
    expect(Object.keys(alloc!.familyShard).length).toBe(0); // no previous season → no family pre-allocation
  });

  it('allocate subsequent season: snake-draft opens N shards + same-sect families in same shard + stray families fill gaps', async () => {
    // Previous season s1-0: two sects SA (rank1, families fa1/fa2 strong) / SB (rank2, family fb1) + one stray family fl1.
    const fam = (id: string, sectId?: string): FamilyDoc => ({
      _id: id, worldId: 's1-0', name: id, tag: id.toUpperCase(), leaderId: `${id}-lead`,
      memberCount: 1, territoryCount: 1, prosperity: 100, ...(sectId ? { sectId } : {}), rev: 1,
    });
    await m.collections.families.insertMany([fam('fa1', 'SA'), fam('fa2', 'SA'), fam('fb1', 'SB'), fam('fl1')]);
    // 4 members (capacity=2 → shardCount=ceil(4/2)=2).
    const mem = (acct: string, famId: string): FamilyMemberDoc => ({
      _id: `s1-0:${acct}`, worldId: 's1-0', accountId: acct, familyId: famId, role: 'leader', joinedAt: 1,
    });
    await m.collections.familyMembers.insertMany([mem('a1', 'fa1'), mem('a2', 'fa2'), mem('b1', 'fb1'), mem('l1', 'fl1')]);
    await m.collections.worlds.insertOne({
      _id: 's1-0', season: 1, shard: 0, status: 'closed', mapW: SLG_MAP_W, mapH: SLG_MAP_H,
      openAt: 1, capacity: 10000, population: 4, engineVersion: ENGINE_VERSION, rev: 1,
    });
    const ranking: SeasonResultDoc['ranking'] = [
      { rank: 1, scope: 'sect', id: 'SA', nationCount: 5, capitalIdxs: [0, 1, 2, 3, 4], prosperity: 200, memberFamilyIds: ['fa1', 'fa2'], tier: 'champion' },
      { rank: 2, scope: 'sect', id: 'SB', nationCount: 1, capitalIdxs: [5], prosperity: 100, memberFamilyIds: ['fb1'], tier: 'top10' },
    ];
    await m.collections.seasonResults.insertOne({ _id: 's1-0:s1', worldId: 's1-0', season: 1, settledAt: 1, ranking });

    const res = await svc.allocateNextSeason(2, 2); // capacity=2 → shardCount=2
    expect(res.shardCount).toBe(2);
    expect(res.worldIds.sort()).toEqual(['s2-0', 's2-1']);

    const alloc = await m.collections.shardAllocations.findOne({ _id: 's2' });
    const fs = alloc!.familyShard;
    // Same-sect families land in the same shard (snake-draft: SA→0, SB→1).
    expect(fs['fa1']).toBe(fs['fa2']);          // SA's two families in the same shard
    expect(fs['fa1']).not.toBe(fs['fb1']);      // SA and SB in different shards (strong/weak balance)
    // Stray family fl1 fills the shard with the fewest families (SA occupies 2 in shard0 → fl1 goes to shard1).
    expect(fs['fl1']).toBe(fs['fb1']);
    // Both worlds were opened.
    for (const wid of ['s2-0', 's2-1']) {
      expect(await m.collections.worlds.findOne({ _id: wid })).toMatchObject({ status: 'open', season: 2 });
    }
  });

  it('resolve sticky: player already has a playerWorld this season → returns same shard', async () => {
    await svc.openSeason('s3-0', 3, 0, 10000);
    await svc.openSeason('s3-1', 3, 1, 10000);
    const pw: PlayerWorldDoc = {
      _id: playerWorldId('s3-1', 'sticky'), worldId: 's3-1', accountId: 'sticky',
      troops: 100, troopCap: 100, resources: { food: 0, iron: 0, wood: 0 }, yieldRate: { food: 0, iron: 0, wood: 0 },
      lastTickAt: 1, rev: 0,
    };
    await m.collections.playerWorld.insertOne(pw);
    expect((await svc.resolveSeasonShard(3, 'sticky')).worldId).toBe('s3-1');
  });

  it('resolve family lookup: two accounts in the same previous-season family → routed to the shard specified by familyShard', async () => {
    await svc.openSeason('s4-0', 4, 0, 10000);
    await svc.openSeason('s4-1', 4, 1, 10000);
    await m.collections.shardAllocations.insertOne({
      _id: 's4', season: 4, shardCount: 2, capacity: 10000, familyShard: { 'famX': 1 }, createdAt: 1,
    });
    // Family members from previous season s3-* (both accounts in famX).
    await m.collections.familyMembers.insertMany([
      { _id: 's3-0:p1', worldId: 's3-0', accountId: 'p1', familyId: 'famX', role: 'leader', joinedAt: 1 },
      { _id: 's3-0:p2', worldId: 's3-0', accountId: 'p2', familyId: 'famX', role: 'member', joinedAt: 1 },
    ]);
    expect((await svc.resolveSeasonShard(4, 'p1')).worldId).toBe('s4-1');
    expect((await svc.resolveSeasonShard(4, 'p2')).worldId).toBe('s4-1'); // same family → same shard
  });

  it('resolve least-populated shard: no family mapping → assigned to the open shard with fewest players', async () => {
    await svc.openSeason('s5-0', 5, 0, 10000);
    await svc.openSeason('s5-1', 5, 1, 10000);
    await m.collections.worlds.updateOne({ _id: 's5-0' }, { $set: { population: 50 } });
    await m.collections.worlds.updateOne({ _id: 's5-1' }, { $set: { population: 3 } });
    expect((await svc.resolveSeasonShard(5, 'newbie')).worldId).toBe('s5-1'); // least populated
  });

  it('resolve overflow: all shards full → open new shard + $inc shardCount', async () => {
    await svc.openSeason('s6-0', 6, 0, 5);
    await m.collections.worlds.updateOne({ _id: 's6-0' }, { $set: { population: 5 } }); // full
    await m.collections.shardAllocations.insertOne({
      _id: 's6', season: 6, shardCount: 1, capacity: 5, familyShard: {}, createdAt: 1,
    });
    const r = await svc.resolveSeasonShard(6, 'overflow');
    expect(r.worldId).toBe('s6-1'); // new shard opened
    expect(await m.collections.worlds.findOne({ _id: 's6-1' })).toMatchObject({ status: 'open', season: 6 });
    expect((await m.collections.shardAllocations.findOne({ _id: 's6' }))!.shardCount).toBe(2); // $inc
  });

  it('patrol: cross-shard marches / dual-login players / orphan tiles flagged; clean DB returns 0', async () => {
    await svc.openSeason('s7-0', 7, 0, 10000);
    await svc.openSeason('s7-1', 7, 1, 10000);
    // Cross-shard march: worldId=s7-0 but toTile points to a tile in s7-1.
    const badMarch: MarchDoc = {
      _id: 'm-bad', worldId: 's7-0', ownerId: 'x', fromTile: 's7-0:1:1', toTile: 's7-1:2:2',
      kind: 'occupy', troops: 10, departAt: 1, arriveAt: 2, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(badMarch);
    // Dual-login player: playerWorld exists in both shards of season 7.
    const pw = (wid: string): PlayerWorldDoc => ({
      _id: playerWorldId(wid, 'dual'), worldId: wid, accountId: 'dual',
      troops: 1, troopCap: 1, resources: { food: 0, iron: 0, wood: 0 }, yieldRate: { food: 0, iron: 0, wood: 0 },
      lastTickAt: 1, rev: 0,
    });
    await m.collections.playerWorld.insertMany([pw('s7-0'), pw('s7-1')]);
    // Orphan tile: _id prefix does not match worldId field.
    const orphan: TileDoc = { _id: 's7-9:3:3', worldId: 's7-0', x: 3, y: 3, type: 'neutral', level: 1, rev: 0 };
    await m.collections.tiles.insertOne(orphan);

    const rep = await svc.patrolShardIsolation();
    expect(rep.crossWorldMarches.count).toBe(1);
    expect(rep.crossWorldMarches.samples).toContain('m-bad');
    expect(rep.multiShardPlayers.count).toBe(1);
    expect(rep.multiShardPlayers.samples[0]).toContain('dual@s7');
    expect(rep.orphanTiles.count).toBe(1);
    expect(rep.orphanTiles.samples).toContain('s7-9:3:3');
  });

  it('patrol: clean DB returns all zeros', async () => {
    await svc.openSeason('s8-0', 8, 0, 10000);
    const rep = await svc.patrolShardIsolation();
    expect(rep.crossWorldMarches.count).toBe(0);
    expect(rep.multiShardPlayers.count).toBe(0);
    expect(rep.orphanTiles.count).toBe(0);
  });

  describe('admin /admin/world/{allocate,patrol} gated by X-Internal-Key', () => {
    let server: Server;
    let base: string;
    beforeEach(async () => {
      server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: KEY }, svc, {} as never, {} as never, {} as never);
      await new Promise<void>((res) => server.on('listening', res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => server?.close());

    it('no key → allocate/patrol 401', async () => {
      const a = await fetch(`${base}/admin/world/allocate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season: 9 }),
      });
      expect(a.status).toBe(401);
      const p = await fetch(`${base}/admin/world/patrol`);
      expect(p.status).toBe(401);
      server.close();
    });

    it('player JWT calling allocate → 401 (not internal)', async () => {
      const token = signToken('player', { secret: SECRET });
      const r = await fetch(`${base}/admin/world/allocate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ season: 9 }),
      });
      expect(r.status).toBe(401);
      server.close();
    });

    it('valid X-Internal-Key → allocate + patrol 200', async () => {
      const a = await fetch(`${base}/admin/world/allocate`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': KEY }, body: JSON.stringify({ season: 9 }),
      });
      expect(a.status).toBe(200);
      const ab = (await a.json()) as { ok: boolean; data: { shardCount: number; worldIds: string[] } };
      expect(ab.data.shardCount).toBe(1);
      expect(ab.data.worldIds).toEqual(['s9-0']);

      const p = await fetch(`${base}/admin/world/patrol`, { headers: { 'x-internal-key': KEY } });
      expect(p.status).toBe(200);
      const pb = (await p.json()) as { ok: boolean; data: { scannedWorlds: number } };
      expect(pb.data.scannedWorlds).toBeGreaterThanOrEqual(1);
      server.close();
    });
  });
});
