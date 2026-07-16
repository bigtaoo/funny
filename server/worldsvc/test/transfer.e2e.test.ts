// G6 mid-season shard transfer/merge e2e (§27): real dedicated Mongo DB.
//   • transferShard: happy path (vacates fromWorldId incl. capital, joins toWorldId fresh, population moves) /
//     same-shard rejected / different-season target rejected / full target rejected / in-flight march or
//     occupation blocks (TRANSFER_BUSY) / cooldown blocks a second transfer / cooldown does not block a
//     transfer in a different season.
//   • mergeShard: moves every remaining player out of the source shard into the target, force-clearing
//     in-flight marches/occupations first, then closes the source shard (excluded from future join routing).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerWorldId, SLG_MAP_W, SLG_MAP_H, SHARD_TRANSFER_COOLDOWN_MS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type MarchDoc, type OccupationDoc } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_transfer_test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.transfer.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 1_700_000_000_000;
const now = (): number => (t += 1000);

describe.skipIf(!mongo)('worldsvc G6 shard transfer/merge e2e (§27)', () => {
  const m = mongo!;
  const svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });

  async function wipe(): Promise<void> {
    const c = m.collections;
    await Promise.all([
      c.worlds.deleteMany({}), c.playerWorld.deleteMany({}), c.tiles.deleteMany({}),
      c.marches.deleteMany({}), c.occupations.deleteMany({}), c.shardTransfers.deleteMany({}),
    ]);
  }
  beforeEach(wipe);
  afterAll(async () => { await m.db.dropDatabase(); await m.close(); });

  async function twoShards(season: number, cap = 100): Promise<[string, string]> {
    const a = `s${season}-0`, b = `s${season}-1`;
    await svc.openSeason(a, season, 0, cap);
    await svc.openSeason(b, season, 1, cap);
    return [a, b];
  }

  it('happy path: vacates fromWorldId (incl. capital + population), joins toWorldId fresh, no cooldown record blocks a later different-season transfer', async () => {
    const [a, b] = await twoShards(20);
    await svc.joinWorld(a, 'p1');
    expect((await m.collections.worlds.findOne({ _id: a }))!.population).toBe(1);

    const view = await svc.transferShard('p1', a, b);
    expect(view.joined).toBe(true);
    expect(view.worldId).toBe(b);

    // Source: playerWorld doc gone, all tiles (incl. capital) gone, population decremented back to 0.
    expect(await m.collections.playerWorld.findOne({ _id: playerWorldId(a, 'p1') })).toBeNull();
    expect(await m.collections.tiles.find({ worldId: a, ownerId: 'p1' }).toArray()).toEqual([]);
    expect((await m.collections.worlds.findOne({ _id: a }))!.population).toBe(0);

    // Destination: fresh playerWorld + capital tiles, population incremented.
    const destPw = await m.collections.playerWorld.findOne({ _id: playerWorldId(b, 'p1') });
    expect(destPw).toBeTruthy();
    expect((await m.collections.tiles.find({ worldId: b, ownerId: 'p1' }).toArray()).length).toBe(9); // 3×3 capital footprint
    expect((await m.collections.worlds.findOne({ _id: b }))!.population).toBe(1);

    const cooldownDoc = await m.collections.shardTransfers.findOne({ _id: 'p1' });
    expect(cooldownDoc).toMatchObject({ fromWorldId: a, toWorldId: b, season: 20 });
  });

  it('rejects same-shard transfer', async () => {
    const [a] = await twoShards(21);
    await svc.joinWorld(a, 'p1');
    await expect(svc.transferShard('p1', a, a)).rejects.toMatchObject({ code: 'TRANSFER_SAME_SHARD' });
  });

  it('rejects a target in a different season', async () => {
    const [a] = await twoShards(22);
    await svc.openSeason('s23-0', 23, 0, 100);
    await svc.joinWorld(a, 'p1');
    await expect(svc.transferShard('p1', a, 's23-0')).rejects.toMatchObject({ code: 'TRANSFER_TARGET_INVALID' });
  });

  it('rejects a nonexistent target', async () => {
    const [a] = await twoShards(24);
    await svc.joinWorld(a, 'p1');
    await expect(svc.transferShard('p1', a, 's24-99')).rejects.toMatchObject({ code: 'TRANSFER_TARGET_INVALID' });
  });

  it('rejects a full target shard', async () => {
    const [a, b] = await twoShards(25, 1); // capacity 1 each
    await svc.joinWorld(a, 'p1');
    await svc.joinWorld(b, 'other'); // fills b to capacity
    await expect(svc.transferShard('p1', a, b)).rejects.toMatchObject({ code: 'TRANSFER_TARGET_INVALID' });
  });

  it('blocks transfer while a march (non-recalled) is in flight in the source shard', async () => {
    const [a, b] = await twoShards(26);
    await svc.joinWorld(a, 'p1');
    const march: MarchDoc = {
      _id: 'm-busy', worldId: a, ownerId: 'p1', fromTile: `${a}:1:1`, toTile: `${a}:2:2`,
      kind: 'occupy', troops: 10, departAt: 1, arriveAt: 999_999_999_999, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(march);
    await expect(svc.transferShard('p1', a, b)).rejects.toMatchObject({ code: 'TRANSFER_BUSY' });
    // A recalled march does not block.
    await m.collections.marches.updateOne({ _id: 'm-busy' }, { $set: { status: 'recalled' } });
    await expect(svc.transferShard('p1', a, b)).resolves.toBeTruthy();
  });

  it('blocks transfer while an occupation-hold is active in the source shard', async () => {
    const [a, b] = await twoShards(27);
    await svc.joinWorld(a, 'p1');
    const hold: OccupationDoc = {
      _id: `${a}:3:3`, worldId: a, ownerId: 'p1', tile: `${a}:3:3`, x: 3, y: 3, level: 1, garrison: 10,
      dueAt: 999_999_999_999, teamId: 't1',
    };
    await m.collections.occupations.insertOne(hold);
    await expect(svc.transferShard('p1', a, b)).rejects.toMatchObject({ code: 'TRANSFER_BUSY' });
  });

  it('enforces the per-account cooldown within a season, but not across seasons', async () => {
    const [a, b] = await twoShards(28);
    await svc.joinWorld(a, 'p1');
    await svc.transferShard('p1', a, b); // first transfer ok
    const [, c] = ['s28-0', await (async () => { await svc.openSeason('s28-2', 28, 2, 100); return 's28-2'; })()];
    await expect(svc.transferShard('p1', b, c)).rejects.toMatchObject({ code: 'TRANSFER_COOLDOWN' });

    // Fast-forward past the cooldown window (simulate by rewriting the stored lastTransferAt).
    await m.collections.shardTransfers.updateOne({ _id: 'p1' }, { $set: { lastTransferAt: now() - SHARD_TRANSFER_COOLDOWN_MS - 1 } });
    await expect(svc.transferShard('p1', b, c)).resolves.toBeTruthy();
  });

  it('mergeShard: moves every remaining player, force-clears in-flight marches/occupations, closes the source shard', async () => {
    const [a, b] = await twoShards(30);
    await svc.joinWorld(a, 'p1');
    await svc.joinWorld(a, 'p2');
    // p1 has a stuck march + occupation that would block a voluntary transfer — merge must force through it.
    const march: MarchDoc = {
      _id: 'm-merge', worldId: a, ownerId: 'p1', fromTile: `${a}:1:1`, toTile: `${a}:2:2`,
      kind: 'occupy', troops: 10, departAt: 1, arriveAt: 999_999_999_999, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(march);
    const hold: OccupationDoc = {
      _id: `${a}:3:3`, worldId: a, ownerId: 'p1', tile: `${a}:3:3`, x: 3, y: 3, level: 1, garrison: 10,
      dueAt: 999_999_999_999, teamId: 't1',
    };
    await m.collections.occupations.insertOne(hold);

    const r = await svc.mergeShard(a, b);
    expect(r.moved).toBe(2);
    expect(r.failed).toEqual([]);

    expect(await m.collections.playerWorld.find({ worldId: a }).toArray()).toEqual([]);
    expect((await m.collections.playerWorld.find({ worldId: b }).toArray()).length).toBe(2);
    expect(await m.collections.marches.findOne({ _id: 'm-merge' })).toBeNull();
    expect(await m.collections.occupations.findOne({ _id: 'o-merge' })).toBeNull();

    const sourceWorld = await m.collections.worlds.findOne({ _id: a });
    expect(sourceWorld!.status).toBe('closed');

    // A closed shard is excluded from future join routing (§17.3 status filter, already-existing behavior).
    const resolved = await svc.resolveSeasonShard(30, 'newbie');
    expect(resolved.worldId).not.toBe(a);
  });

  it('mergeShard rejects when the target lacks room for everyone remaining', async () => {
    const [a, b] = await twoShards(31, 1); // capacity 1 each
    await svc.joinWorld(a, 'p1');
    // b already full with a different player.
    await svc.joinWorld(b, 'other');
    await expect(svc.mergeShard(a, b)).rejects.toMatchObject({ code: 'TRANSFER_TARGET_INVALID' });
  });

  it('mergeShard rejects same-shard / cross-season targets', async () => {
    const [a] = await twoShards(32);
    await expect(svc.mergeShard(a, a)).rejects.toMatchObject({ code: 'TRANSFER_SAME_SHARD' });
    await svc.openSeason('s33-0', 33, 0, 100);
    await expect(svc.mergeShard(a, 's33-0')).rejects.toMatchObject({ code: 'TRANSFER_TARGET_INVALID' });
  });
});
