// Account-deletion purge e2e (worldsvc leg of metaserver's purge job): real dedicated Mongo DB + an in-process
// fake socialsvc whose rosters already reflect socialsvc's own purge (which runs first).
//   • Shard presence: marches / occupations / stationed / tiles / playerWorld removed in EVERY world the account
//     is in, population decremented once per world, a tile the account was contesting is un-contested, its
//     pending siege hits deleted (hits against it are left for the besieger's stale-target path), nation claim
//     unset, chat deleted, season-result name blanked, transfer cooldown deleted.
//   • Sects: leader family survived with a new leader → sect.leaderId follows; leader family dissolved → the
//     largest remaining family takes over; last family gone → sect dissolved (channel gone, allies pulled);
//     memberFamilyCount recomputed; removalVote cleaned.
//   • Idempotency: a second call reports zero counts and does not double-decrement population.
//   • HTTP: POST /internal/accounts/:id/purge requires X-Internal-Key.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { playerWorldId, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo, type MarchDoc, type OccupationDoc, type StationedDoc, type SiegeDamageDoc, type SectDoc } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { startHttpApi } from '../src/httpApi';
import type { WorldSocialsvcClient, FamilyMembership, FamilySummary } from '../src/socialsvcClient';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_account_purge_test';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.accountPurge.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Minimal socialsvc roster fake: families keyed by id, each optionally pointing at a sect. */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  families = new Map<string, FamilySummary>();
  bySectCalls = 0;

  add(familyId: string, leaderId: string, memberCount: number, sectId?: string): void {
    this.families.set(familyId, {
      familyId, name: familyId, tag: familyId.slice(-3).toUpperCase(), leaderId, memberCount, prosperity: 0,
      ...(sectId ? { sectId } : {}),
    });
  }
  async getFamilyId(): Promise<string | null> { return null; }
  async getMember(): Promise<FamilyMembership | null> { return null; }
  async getFamiliesByIds(ids: string[]): Promise<FamilySummary[]> {
    return ids.map((id) => this.families.get(id)).filter((f): f is FamilySummary => !!f).map((f) => ({ ...f }));
  }
  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    this.bySectCalls++;
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }
  async setSect(familyId: string, sid: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) f.sectId = sid; else delete f.sectId;
  }
  async bumpActivity(): Promise<void> {}
  async refreshProsperity(): Promise<number> { return 0; }
  async bumpActivityAndProsperity(): Promise<number> { return 0; }
  async resetSlgState(): Promise<void> {}
  async push(): Promise<void> {}
}

let t = 1_700_000_000_000;
const now = (): number => (t += 1000);

const DEAD = 'acc-dead';

function sectDoc(id: string, worldId: string, leaderFamilyId: string, leaderId: string, extra: Partial<SectDoc> = {}): SectDoc {
  return {
    _id: id, worldId, name: id, tag: id.slice(-3).toUpperCase(), leaderFamilyId, leaderId,
    memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1, ...extra,
  };
}

describe.skipIf(!mongo)('worldsvc account purge e2e', () => {
  const m = mongo!;
  const social = new FakeSocialsvc();
  const svc = new WorldService({ cols: m.collections, redis: null, socialsvc: social, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  const A = 'purge-s1-0';
  const B = 'purge-s1-1';

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });
  beforeEach(async () => {
    const c = m.collections;
    social.families.clear();
    await Promise.all([
      c.worlds.deleteMany({}), c.playerWorld.deleteMany({}), c.tiles.deleteMany({}), c.marches.deleteMany({}),
      c.occupations.deleteMany({}), c.stationed.deleteMany({}), c.siegeDamage.deleteMany({}), c.nations.deleteMany({}),
      c.sects.deleteMany({}), c.sectMessages.deleteMany({}), c.nationMessages.deleteMany({}), c.familyMessages.deleteMany({}),
      c.seasonResults.deleteMany({}), c.shardTransfers.deleteMany({}),
    ]);
    await svc.openSeason(A, 1, 0, 100);
    await svc.openSeason(B, 1, 1, 100);
  });
  afterAll(async () => { await m.db.dropDatabase(); await m.close(); });

  it('clears shard presence in every world, is idempotent, and leaves other players alone', async () => {
    const c = m.collections;
    await svc.joinWorld(A, DEAD);
    await svc.joinWorld(B, DEAD);
    await svc.joinWorld(A, 'other');
    expect((await c.worlds.findOne({ _id: A }))!.population).toBe(2);

    await c.marches.insertOne({
      _id: 'm-dead', worldId: A, ownerId: DEAD, fromTile: `${A}:1:1`, toTile: `${A}:2:2`,
      kind: 'occupy', troops: 10, departAt: 1, arriveAt: 9e12, status: 'marching', rev: 0,
    } as MarchDoc);
    await c.occupations.insertOne({
      _id: `${A}:60:60`, worldId: A, ownerId: DEAD, tile: `${A}:60:60`, x: 60, y: 60, level: 1, garrison: 5, dueAt: 9e12,
    } as OccupationDoc);
    await c.tiles.insertOne({
      _id: `${A}:60:60`, worldId: A, x: 60, y: 60, type: 'territory', level: 1,
      contestedBy: DEAD, contestedUntil: 9e12, contestedGarrison: 5, rev: 0,
    } as never);
    await c.stationed.insertOne({
      _id: `${B}:70:70`, worldId: B, ownerId: DEAD, tile: `${B}:70:70`, x: 70, y: 70, teamId: 't1', army: [], troops: 3, sinceAt: 1, mode: 'garrison',
    } as StationedDoc);
    const hit = (id: string, attackerId: string, defenderId: string): SiegeDamageDoc => ({
      _id: id, worldId: A, attackerId, defenderId, tile: `${A}:5:5`, isBase: false, damage: 1, attackerSurvivors: 1, dueAt: 9e12,
    });
    await c.siegeDamage.insertMany([hit('sd-by-dead', DEAD, 'other'), hit('sd-vs-dead', 'other', DEAD)]);
    await c.nations.updateOne({ _id: `nation:${A}:0` }, { $set: { ownerId: DEAD, familyId: 'fam:x', nationName: 'Deadland', foundedAt: 1 } });
    const ts = new Date();
    await c.sectMessages.insertMany([
      { _id: 'sm1', worldId: A, sectId: 's:x', senderId: DEAD, senderName: 'dead', body: 'hi', ts },
      { _id: 'sm2', worldId: A, sectId: 's:x', senderId: 'other', senderName: 'o', body: 'yo', ts },
    ]);
    await c.nationMessages.insertOne({ _id: 'nm1', worldId: A, senderId: DEAD, senderName: 'dead', senderPublicId: '1', body: 'x', ts });
    await c.familyMessages.insertOne({ _id: 'fm1', worldId: A, familyId: 'fam:x', senderId: DEAD, senderName: 'dead', body: 'x', ts });
    await c.seasonResults.insertOne({
      _id: `${A}:s0`, worldId: A, season: 0, settledAt: 1,
      ranking: [
        { rank: 1, scope: 'solo', id: 'other', name: 'Other', nationCount: 2, capitalIdxs: [1, 2], tier: 'champion' },
        { rank: 2, scope: 'solo', id: DEAD, name: 'Dead', nationCount: 1, capitalIdxs: [3], tier: 'top3' },
      ],
    });
    await c.shardTransfers.insertOne({ _id: DEAD, lastTransferAt: 1, season: 1, fromWorldId: A, toWorldId: B });

    const r1 = await svc.purgeAccount(DEAD);
    expect(r1).toMatchObject({ done: true, worlds: 2, sects: { reassigned: 0, dissolved: 0 } });
    expect(r1.removed).toMatchObject({
      marches: 1, occupations: 1, stationed: 1, contestedTiles: 1, siegeDamage: 1, nations: 1,
      sectMessages: 1, nationMessages: 1, familyMessages: 1, seasonResults: 1, shardTransfers: 1, playerWorld: 2,
    });
    expect(r1.removed.tiles).toBe(18); // two 3×3 capitals

    for (const w of [A, B]) {
      expect(await c.playerWorld.findOne({ _id: playerWorldId(w, DEAD) })).toBeNull();
      expect(await c.tiles.countDocuments({ worldId: w, ownerId: DEAD })).toBe(0);
    }
    expect((await c.worlds.findOne({ _id: A }))!.population).toBe(1);
    expect((await c.worlds.findOne({ _id: B }))!.population).toBe(0);
    expect(await c.marches.countDocuments({ ownerId: DEAD })).toBe(0);
    expect(await c.occupations.countDocuments({ ownerId: DEAD })).toBe(0);
    expect(await c.stationed.countDocuments({ ownerId: DEAD })).toBe(0);
    const contested = await c.tiles.findOne({ _id: `${A}:60:60` });
    expect(contested?.contestedBy).toBeUndefined();
    expect(contested?.contestedGarrison).toBeUndefined();
    expect((await c.siegeDamage.find({}).toArray()).map((d) => d._id)).toEqual(['sd-vs-dead']);
    const nation = await c.nations.findOne({ _id: `nation:${A}:0` });
    expect(nation).toBeTruthy(); // the capital slot survives, only the claim is gone
    expect(nation?.ownerId).toBeUndefined();
    expect(nation?.nationName).toBeUndefined();
    expect((await c.sectMessages.find({}).toArray()).map((d) => d._id)).toEqual(['sm2']);
    expect(await c.nationMessages.countDocuments({})).toBe(0);
    expect(await c.familyMessages.countDocuments({})).toBe(0);
    const sr = await c.seasonResults.findOne({ _id: `${A}:s0` });
    expect(sr!.ranking[0]).toMatchObject({ id: 'other', name: 'Other' });
    expect(sr!.ranking[1]).toMatchObject({ id: DEAD, nationCount: 1, rank: 2 });
    expect(sr!.ranking[1]!.name).toBeUndefined();
    expect(await c.shardTransfers.findOne({ _id: DEAD })).toBeNull();
    // The other player is untouched.
    expect(await c.playerWorld.findOne({ _id: playerWorldId(A, 'other') })).toBeTruthy();
    expect(await c.tiles.countDocuments({ worldId: A, ownerId: 'other' })).toBe(9);

    // Second run: nothing left to do, population not decremented again.
    const r2 = await svc.purgeAccount(DEAD);
    expect(r2).toMatchObject({ done: true, worlds: 0, sects: { reassigned: 0, dissolved: 0 } });
    expect(Object.values(r2.removed).every((n) => n === 0)).toBe(true);
    expect((await c.worlds.findOne({ _id: A }))!.population).toBe(1);
  });

  it('a retry after the playerWorld doc is already gone does not decrement population again', async () => {
    const c = m.collections;
    await svc.joinWorld(A, DEAD);
    await svc.joinWorld(A, 'other');
    // Simulate a previous run that died right after vacating: doc gone, population already decremented.
    await c.playerWorld.deleteOne({ _id: playerWorldId(A, DEAD) });
    await c.worlds.updateOne({ _id: A }, { $inc: { population: -1 } });
    const r = await svc.purgeAccount(DEAD);
    expect(r.worlds).toBe(0);
    expect((await c.worlds.findOne({ _id: A }))!.population).toBe(1);
  });

  it('reconciles sects against socialsvc: leader follows, successor by size, sole-family sect dissolved', async () => {
    const c = m.collections;
    await svc.joinWorld(A, DEAD);
    await svc.joinWorld(B, DEAD);

    // S1: DEAD led fam:lead (still alive; socialsvc handed it to 'heir'). Stale count 3; a vote whose voters
    //     include a family that is no longer in the sect.
    social.add('fam:lead', 'heir', 4, 's:A:ONE');
    social.add('fam:two', 'two-leader', 2, 's:A:ONE');
    // S2: DEAD's own family (sole member) led it and is now dissolved; three families remain, two tied on size.
    social.add('fam:small', 'small-leader', 2, 's:A:TWO');
    social.add('fam:zbig', 'zbig-leader', 5, 's:A:TWO');
    social.add('fam:abig', 'abig-leader', 5, 's:A:TWO');
    // S3: DEAD's dissolved family was the only one → nothing in socialsvc.
    // S4: DEAD was a plain member of a family in this sect (found only through the playerWorld mirror in B);
    //     the vote's nominee family has left.
    social.add('fam:four', 'four-leader', 3, 's:B:FOR');

    await c.sects.insertMany([
      sectDoc('s:A:ONE', A, 'fam:lead', DEAD, {
        memberFamilyCount: 3, allySectIds: ['s:A:THR'],
        removalVote: { nomineeFamilyId: 'fam:two', voterFamilyIds: ['fam:gone', 'fam:two'] },
      }),
      sectDoc('s:A:TWO', A, 'fam:dead', DEAD, {
        memberFamilyCount: 4, removalVote: { nomineeFamilyId: 'fam:small', voterFamilyIds: ['fam:small'] },
      }),
      sectDoc('s:A:THR', A, 'fam:dead3', DEAD, { allySectIds: ['s:A:ONE'] }),
      sectDoc('s:B:FOR', B, 'fam:four', 'four-leader', {
        memberFamilyCount: 3, removalVote: { nomineeFamilyId: 'fam:left', voterFamilyIds: ['fam:four'] },
      }),
    ]);
    await c.playerWorld.updateOne({ _id: playerWorldId(B, DEAD) }, { $set: { sectId: 's:B:FOR' } });
    const ts = new Date();
    await c.sectMessages.insertMany([
      { _id: 'thr-1', worldId: A, sectId: 's:A:THR', senderId: 'someone', senderName: 's', body: 'bye', ts },
      { _id: 'one-1', worldId: A, sectId: 's:A:ONE', senderId: 'someone', senderName: 's', body: 'hi', ts },
    ]);

    const r1 = await svc.purgeAccount(DEAD);
    expect(r1.sects).toEqual({ reassigned: 2, dissolved: 1 });

    const one = await c.sects.findOne({ _id: 's:A:ONE' });
    expect(one).toMatchObject({ leaderFamilyId: 'fam:lead', leaderId: 'heir', memberFamilyCount: 2, allySectIds: [] });
    expect(one!.removalVote).toEqual({ nomineeFamilyId: 'fam:two', voterFamilyIds: ['fam:two'] });
    expect(one!.rev).toBe(2);

    const two = await c.sects.findOne({ _id: 's:A:TWO' });
    // 5 vs 5 tie → familyId ascending picks fam:abig; a leadership change voids the pending vote.
    expect(two).toMatchObject({ leaderFamilyId: 'fam:abig', leaderId: 'abig-leader', memberFamilyCount: 3 });
    expect(two!.removalVote).toBeUndefined();

    expect(await c.sects.findOne({ _id: 's:A:THR' })).toBeNull();
    expect(await c.sectMessages.countDocuments({ sectId: 's:A:THR' })).toBe(0);
    expect(await c.sectMessages.countDocuments({ sectId: 's:A:ONE' })).toBe(1);

    const four = await c.sects.findOne({ _id: 's:B:FOR' });
    expect(four).toMatchObject({ leaderFamilyId: 'fam:four', leaderId: 'four-leader', memberFamilyCount: 1 });
    expect(four!.removalVote).toBeUndefined();

    // Second run: no candidate sect is left to find (mirrors + leaderId=DEAD are gone) → nothing changes.
    const before = await c.sects.find({}).sort({ _id: 1 }).toArray();
    const r2 = await svc.purgeAccount(DEAD);
    expect(r2.sects).toEqual({ reassigned: 0, dissolved: 0 });
    expect(await c.sects.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it('refuses (throws) rather than dissolving sects when socialsvc is unavailable', async () => {
    const c = m.collections;
    await c.sects.insertOne(sectDoc('s:A:NOS', A, 'fam:x', DEAD));
    social.available = false;
    try {
      await expect(svc.purgeAccount(DEAD)).rejects.toThrow(/socialsvc unavailable/);
    } finally {
      social.available = true;
    }
    expect(await c.sects.findOne({ _id: 's:A:NOS' })).toBeTruthy();
  });

  describe('HTTP POST /internal/accounts/:id/purge', () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      const sectSvc = new SectService({ cols: m.collections, now });
      const nationChannelSvc = new NationChannelService({ cols: m.collections, now } as ConstructorParameters<typeof NationChannelService>[0]);
      const mapTemplateSvc = new MapTemplateService({ cols: m.collections, now });
      server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: 'secret', internalKey: KEY }, svc, sectSvc, nationChannelSvc, social, mapTemplateSvc);
      await new Promise<void>((res) => server.on('listening', res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => { server.close(); });

    it('401 without X-Internal-Key (no JWT fallback either)', async () => {
      const r = await fetch(`${base}/internal/accounts/${DEAD}/purge`, { method: 'POST' });
      expect(r.status).toBe(401);
    });

    it('purges with the key and answers the done envelope; unknown /internal path → 404', async () => {
      await svc.joinWorld(A, DEAD);
      const headers = { 'x-internal-key': KEY, 'x-internal-caller': 'metaserver' };
      const r = await fetch(`${base}/internal/accounts/${encodeURIComponent(DEAD)}/purge`, { method: 'POST', headers });
      expect(r.status).toBe(200);
      const body = await jsonBody<{ ok: boolean; data: { done: boolean; worlds: number; removed: Record<string, number>; sects: object } }>(r);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({ done: true, worlds: 1, sects: { reassigned: 0, dissolved: 0 } });
      expect(body.data.removed.playerWorld).toBe(1);
      expect(await m.collections.playerWorld.findOne({ _id: playerWorldId(A, DEAD) })).toBeNull();

      const nf = await fetch(`${base}/internal/nope`, { method: 'POST', headers });
      expect(nf.status).toBe(404);
    });
  });
});
