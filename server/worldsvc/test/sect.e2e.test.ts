// worldsvc SectService end-to-end (S8-4b): dedicated real Mongo database. Entire suite skipped if Mongo is unreachable.
// Sect CRUD / join / leave / dissolve / ally / impeach-and-elect / channel; permission guards (leader required); deduct coins on founding.
// Also includes WorldService.settleSeason aggregating nation count by sect.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sectId,
  familyId,
  familyMemberId,
  SECT_CREATE_COST,
  SECT_ALLY_CAP,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type NationDoc } from '../src/db';
import { SectService } from '../src/sectService';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_sect_test';
const W = 'sect-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.sect.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

describe.skipIf(!mongo)('SectService e2e', () => {
  let sect: SectService;
  const spends: Array<{ accountId: string; amount: number }> = [];
  const grants: Array<{ accountId: string; amount: number }> = [];

  const commercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spends.push({ accountId, amount }); },
    async grant(accountId, amount) { grants.push({ accountId, amount }); },
  };

  // Capture sect channel fan-out (broadcast recipients + message) to assert real-time push targets are correct.
  const broadcasts: Array<{ recipients: string[]; kind: string; body?: string }> = [];
  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* sect does not use targeted push */ },
    async broadcast(recipients, msg) {
      broadcasts.push({ recipients, kind: msg.kind, body: (msg as { body?: string }).body });
    },
  };

  beforeEach(async () => {
    const cols = mongo!.collections;
    await Promise.all([
      cols.families.deleteMany({}),
      cols.familyMembers.deleteMany({}),
      cols.sects.deleteMany({}),
      cols.sectMessages.deleteMany({}),
      cols.playerWorld.deleteMany({}),
      cols.nations.deleteMany({}),
    ]);
    spends.length = 0;
    grants.length = 0;
    broadcasts.length = 0;
    sect = new SectService({ cols, commercial, gateway: fakeGateway, now: () => Date.now() });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  /**
   * Insert a family directly into the database (family logic has been migrated to socialsvc; worldsvc only retains
   * SectService reading the families/familyMembers collections, so test fixtures insert directly without relying on
   * the removed FamilyService). name is padded to ≥2 characters as a fallback.
   * activity controls the prosperity threshold (§17.4): createSect calls refreshFamilyProsperity to recompute
   * familyProsperity(territory, memberCount, activity), requiring ≥ SECT_FOUND_PROSPERITY_MIN(2000) to found a sect.
   */
  async function insertFamily(leader: string, name: string, tag: string, activity: number): Promise<string> {
    const cols = mongo!.collections;
    const fid = familyId(W, tag);
    await cols.families.insertOne({
      _id: fid,
      worldId: W,
      name: name.length >= 2 ? name : `Fam${name}`,
      tag,
      leaderId: leader,
      memberCount: 1,
      territoryCount: 0,
      activity,
      rev: 1,
    });
    await cols.familyMembers.insertOne({
      _id: familyMemberId(W, leader),
      worldId: W,
      accountId: leader,
      familyId: fid,
      role: 'leader',
      joinedAt: 0,
    });
    return leader;
  }

  /** Creates a family that meets the sect-founding prosperity threshold (activity=500 → sufficient prosperity); test cases that do not care about the threshold use this by default. */
  async function makeFamily(leader: string, name: string, tag: string): Promise<string> {
    return insertFamily(leader, name, tag, 500);
  }

  /** Insert an account into a family directly in the database (member role + memberCount++). */
  async function joinFamily(account: string, fid: string): Promise<void> {
    const cols = mongo!.collections;
    await cols.familyMembers.insertOne({
      _id: familyMemberId(W, account),
      worldId: W,
      accountId: account,
      familyId: fid,
      role: 'member',
      joinedAt: 0,
    });
    await cols.families.updateOne({ _id: fid }, { $inc: { memberCount: 1 } });
  }

  it('found sect: deduct 5000 coins + family becomes the leading family', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    const detail = await sect.createSect(W, 'alice', 'Sky Sect', 'SKY');
    expect(detail.sectId).toBe(sectId(W, 'SKY'));
    expect(detail.leaderId).toBe('alice');
    expect(detail.leaderFamilyId).toBe(familyId(W, 'AW'));
    expect(detail.memberFamilyCount).toBe(1);
    expect(spends).toEqual([{ accountId: 'alice', amount: SECT_CREATE_COST }]);
  });

  it('founding prosperity threshold: low-prosperity family → PROSPERITY_TOO_LOW (G2/§17.4)', async () => {
    // Inserting a family with no activity → prosperity = memberCount*50 = 50 < 2000, should be blocked.
    await insertFamily('poor', 'Poor', 'PR', 0);
    await expect(sect.createSect(W, 'poor', 'Broke', 'BRK')).rejects.toMatchObject({ code: 'PROSPERITY_TOO_LOW' });
  });

  it('non-leader cannot found a sect → NO_PERMISSION', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await joinFamily('bob', familyId(W, 'AW')); // bob = member
    await expect(sect.createSect(W, 'bob', 'X', 'XX')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('player not in any family cannot found a sect → NOT_IN_FAMILY', async () => {
    await expect(sect.createSect(W, 'nobody', 'X', 'XX')).rejects.toMatchObject({ code: 'NOT_IN_FAMILY' });
  });

  it('family already in a sect → ALREADY_IN_SECT', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await expect(sect.createSect(W, 'alice', 'Other', 'OTH')).rejects.toMatchObject({ code: 'ALREADY_IN_SECT' });
  });

  it('TAG collision → ALREADY_IN_SECT + refund', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('carol', 'Gamma', 'GA');
    await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await expect(sect.createSect(W, 'carol', 'Sky2', 'SKY')).rejects.toMatchObject({ code: 'ALREADY_IN_SECT' });
    expect(grants.length).toBe(1); // refund
  });

  it('join + list + detail', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('bob', 'Beta', 'BT');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    const list = await sect.listSects(W);
    expect(list[0].memberFamilyCount).toBe(2);
    const detail = await sect.getSect(s.sectId);
    expect(detail!.memberFamilies.map((f) => f.tag).sort()).toEqual(['AW', 'BT']);
  });

  it('leave sect: member family may leave; leader family cannot leave directly', async () => {
    await makeFamily('alice', 'Alpha', 'AW');
    await makeFamily('bob', 'Beta', 'BT');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.leaveSect(W, 'bob');
    expect((await sect.getSect(s.sectId))!.memberFamilyCount).toBe(1);
    await expect(sect.leaveSect(W, 'alice')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('alliance: bidirectional + cap SECT_ALLY_CAP', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    await makeFamily('dave', 'D', 'DD');
    const a = await sect.createSect(W, 'alice', 'SA', 'SA');
    const b = await sect.createSect(W, 'bob', 'SB', 'SB');
    const c = await sect.createSect(W, 'carol', 'SC', 'SC');
    const d = await sect.createSect(W, 'dave', 'SD', 'SD');
    await sect.allySect(W, 'alice', b.sectId);
    await sect.allySect(W, 'alice', c.sectId);
    // Bidirectional write
    expect((await sect.getSect(a.sectId))!.allySectIds.sort()).toEqual([b.sectId, c.sectId].sort());
    expect((await sect.getSect(b.sectId))!.allySectIds).toContain(a.sectId);
    // Exceeding cap → ALLY_CAP_REACHED
    expect(SECT_ALLY_CAP).toBe(2);
    await expect(sect.allySect(W, 'alice', d.sectId)).rejects.toMatchObject({ code: 'ALLY_CAP_REACHED' });
  });

  it('impeach and elect: 2/3 leader vote → leadership transfers', async () => {
    // 3 families in sect → needed = ceil(3 * 2/3) = 2
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.joinSect(W, 'carol', s.sectId);

    const nominee = familyId(W, 'BB');
    const r1 = await sect.voteRemoveLeader(W, 'bob', nominee);
    expect(r1).toMatchObject({ passed: false, voteCount: 1, needed: 2 });
    const r2 = await sect.voteRemoveLeader(W, 'carol', nominee);
    expect(r2.passed).toBe(true);
    const after = await sect.getSect(s.sectId);
    expect(after!.leaderId).toBe('bob');
    expect(after!.leaderFamilyId).toBe(nominee);
  });

  it('channel: member send/read; non-member → NOT_IN_SECT', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB'); // does not join the sect
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.sendMessage(W, 'alice', 'Alice', 'hello sect');
    const msgs = await sect.getChannel(W, 'alice');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('hello sect');
    await expect(sect.getChannel(W, 'bob')).rejects.toMatchObject({ code: 'NOT_IN_SECT' });
    void s;
  });

  it('channel real-time fan-out: broadcast pushed to other sect members, sender not in recipient list', async () => {
    // alice (leader family) + bob + carol, three families in the same sect; bob and carol each have one member.
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    await joinFamily('bob2', familyId(W, 'BB'));
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);
    await sect.joinSect(W, 'carol', s.sectId);

    await sect.sendMessage(W, 'alice', 'Alice', 'hello everyone');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].kind).toBe('sect_msg');
    expect(broadcasts[0].body).toBe('hello everyone');
    // Recipients = all sect members minus the sender alice: bob, bob2, carol (unordered).
    expect([...broadcasts[0].recipients].sort()).toEqual(['bob', 'bob2', 'carol']);
    expect(broadcasts[0].recipients).not.toContain('alice');
  });

  it('dissolve: clear member sectId + delete channel + bidirectional alliance removal', async () => {
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    const a = await sect.createSect(W, 'alice', 'SA', 'SA');
    const b = await sect.createSect(W, 'bob', 'SB', 'SB');
    await sect.allySect(W, 'alice', b.sectId);
    await sect.sendMessage(W, 'alice', 'Alice', 'hi');
    await sect.dissolveSect(W, 'alice');
    expect(await sect.getSect(a.sectId)).toBeNull();
    // Ally b's allySectIds has had a removed
    expect((await sect.getSect(b.sectId))!.allySectIds).not.toContain(a.sectId);
    // alice family's sectId has been cleared
    const fAlice = await mongo!.collections.families.findOne({ _id: familyId(W, 'AA') });
    expect(fAlice!.sectId).toBeUndefined();
  });

  it('settleSeason: aggregate nation count by sect (sect > family > solo)', async () => {
    const cols = mongo!.collections;
    // alice+bob in the same sect SKY; carol is an independent family; dave is a solo player.
    await makeFamily('alice', 'A', 'AA');
    await makeFamily('bob', 'B', 'BB');
    await makeFamily('carol', 'C', 'CC');
    const s = await sect.createSect(W, 'alice', 'Sky', 'SKY');
    await sect.joinSect(W, 'bob', s.sectId);

    const nation = (capitalIdx: number, ownerId: string, fid?: string): NationDoc => ({
      _id: `nation:${W}:${capitalIdx}`,
      worldId: W, capitalIdx, x: capitalIdx, y: capitalIdx,
      ownerId, ...(fid ? { familyId: fid } : {}), rev: 1,
    });
    await cols.nations.insertMany([
      nation(0, 'alice', familyId(W, 'AA')), // SKY
      nation(1, 'bob', familyId(W, 'BB')),   // SKY
      nation(2, 'carol', familyId(W, 'CC')), // independent family CC
      nation(3, 'dave'),                     // solo
    ]);

    const svc = new WorldService({ cols, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now: () => Date.now() });
    const ranking = await svc.settleSeason(W);
    // SKY holds 2 nations, ranks first
    expect(ranking[0]).toMatchObject({ scope: 'sect', familyId: s.sectId, nationCount: 2 });
    const carol = ranking.find((r) => r.scope === 'family');
    expect(carol).toMatchObject({ familyId: familyId(W, 'CC'), nationCount: 1 });
    const dave = ranking.find((r) => r.scope === 'solo');
    expect(dave).toMatchObject({ familyId: 'dave', nationCount: 1 });
  });

  it('channel: fromPublicId resolved from meta; falls back to empty string when meta unavailable', async () => {
    await makeFamily('alice', 'A', 'AA');
    await sect.createSect(W, 'alice', 'Sky', 'SKY');

    // Case 1: meta available, returns a publicId — push payload must use it.
    const fakeMeta: WorldMetaClient = {
      available: true,
      async getProfile(id) { return id === 'alice' ? { publicId: 'alice#1234', displayName: 'Alice' } : null; },
      async deductMaterial() { throw new Error('unused'); },
      async grantMaterial() { /* no-op */ },
      async getSaveFields() { return null; },
      async escrowEquipment() { throw new Error('unused'); },
      async grantEquipment() { /* no-op */ },
      async grantTitle() { /* no-op */ },
    };
    const sectWithMeta = new SectService({ cols: mongo!.collections, commercial, gateway: fakeGateway, meta: fakeMeta, now: () => Date.now() });
    broadcasts.length = 0;
    await sectWithMeta.sendMessage(W, 'alice', 'Alice', 'hi from alice');
    expect(broadcasts[0]).toMatchObject({ kind: 'sect_msg' });
    expect((broadcasts[0] as Record<string, unknown>)['fromPublicId']).toBe('alice#1234');

    // Case 2: meta not configured (nullWorldMetaClient) — fromPublicId must be empty string, not the raw accountId.
    broadcasts.length = 0;
    const sectNoMeta = new SectService({ cols: mongo!.collections, commercial, gateway: fakeGateway, now: () => Date.now() });
    await sectNoMeta.sendMessage(W, 'alice', 'Alice', 'hi again');
    expect((broadcasts[0] as Record<string, unknown>)['fromPublicId']).toBe('');
  });
});
