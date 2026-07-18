// worldsvc NationChannelService end-to-end: real Mongo, fake gateway + meta.
// Covers send/read (basic happy path) and publicId resolution: meta-available → uses publicId;
// meta unavailable → fromPublicId is empty string (not the raw accountId).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorldMongo, type WorldMongo, type NationMessageDoc } from '../src/db';
import { NationChannelService } from '../src/nationChannelService';
import { nullWorldCommercialClient, type WorldCommercialClient } from '../src/commercialClient';
import type { HttpWorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldSocialsvcClient, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_nation_channel_test';
const W = 'nchan-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn('[worldsvc.nation-channel.e2e] Mongo unreachable — skipping. Run docker compose up -d first.');

describe.skipIf(!mongo)('NationChannelService e2e', () => {
  const broadcasts: Array<Record<string, unknown>> = [];
  const spends: Array<{ accountId: string; amount: number }> = [];

  const fakeGateway: HttpWorldGatewayClient = {
    available: true,
    async push() { /* targeted push unused by nation channel */ },
    async broadcast(recipients, msg) {
      broadcasts.push({ recipients, ...(msg as Record<string, unknown>) });
    },
  };

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spends.push({ accountId, amount }); },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    const cols = mongo!.collections;
    await Promise.all([
      cols.nationMessages.deleteMany({}),
      cols.playerWorld.deleteMany({}),
      cols.sects.deleteMany({}),
    ]);
    broadcasts.length = 0;
    spends.length = 0;

    // Settle alice into the world — most tests below exercise the title/sectName/familyName
    // resolution path, which is orthogonal to SLG-map settlement; a playerWorld record is not
    // required for send/read (see regression test below), it's just present in most fixtures.
    await cols.playerWorld.insertOne({
      _id: `${W}:alice`,
      worldId: W,
      accountId: 'alice',
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      troops: 0,
      troopCap: 500,
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: 0,
      rev: 1,
    });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  it('send + read: message persisted and returned', async () => {
    const svc = new NationChannelService({
      cols: mongo!.collections,
      gateway: fakeGateway,
      commercial: fakeCommercial,
      now: () => 1000,
    });
    const result = await svc.sendMessage(W, 'alice', 'Alice', 'hello world');
    expect(result.body).toBe('hello world');
    expect(result.senderId).toBe('alice');

    const history = await svc.getChannel(W, 'alice');
    expect(history).toHaveLength(1);
    expect(history[0].body).toBe('hello world');
  });

  // Regression: posting must ALWAYS charge WORLD_CHAT_COST coins. The old `if (commercial.available)`
  // guard let posts through for free whenever worldsvc lacked NW_COMMERCIAL_INTERNAL_URL.
  describe('regression: a world-chat post is never free', () => {
    it('charges exactly WORLD_CHAT_COST (50) coins when commercial is available', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 1100,
      });
      await svc.sendMessage(W, 'alice', 'Alice', 'paid post');
      expect(spends).toEqual([{ accountId: 'alice', amount: 50 }]);
    });

    it('rejects the post (throws) and persists nothing when commercial is unconfigured', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: nullWorldCommercialClient,
        now: () => 1200,
      });
      await expect(svc.sendMessage(W, 'alice', 'Alice', 'free post?')).rejects.toThrow();
      // No free message left behind.
      const history = await svc.getChannel(W, 'alice');
      expect(history).toHaveLength(0);
    });
  });

  // Regression (2026-07-18, account tao1 hit 403 on a fresh account that never entered the SLG
  // map): world chat is a social feature scoped to the shard, not to SLG map settlement — send
  // and read must both work for an account with no playerWorld record in this world.
  describe('regression: works without ever having settled a base (no playerWorld record)', () => {
    it('sendMessage() succeeds for an account with no playerWorld record', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 500,
      });
      const result = await svc.sendMessage(W, 'bob', 'Bob', 'hi from a bob with no base');
      expect(result.body).toBe('hi from a bob with no base');
      expect(result.senderId).toBe('bob');
    });

    it('getChannel() succeeds for an account with no playerWorld record', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 501,
      });
      await svc.sendMessage(W, 'alice', 'Alice', 'settled sender posts');
      const history = await svc.getChannel(W, 'bob');
      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('settled sender posts');
    });
  });

  it('fromPublicId resolved from meta when available', async () => {
    const fakeMeta: WorldMetaClient = {
      available: true,
      async getProfile(id) { return id === 'alice' ? { publicId: 'alice#0042', displayName: 'Alice' } : null; },
      async deductMaterial() { throw new Error('unused'); },
      async grantMaterial() { /* no-op */ },
      async getSaveFields() { return null; },
      async escrowEquipment() { throw new Error('unused'); },
      async grantEquipment() { /* no-op */ },
      async grantTitle() { /* no-op */ },
    };
    const svc = new NationChannelService({
      cols: mongo!.collections,
      gateway: fakeGateway,
      commercial: fakeCommercial,
      meta: fakeMeta,
      now: () => 2000,
    });
    await svc.sendMessage(W, 'alice', 'Alice', 'hi');
    expect(broadcasts[0]['fromPublicId']).toBe('alice#0042');
  });

  it('fromPublicId is empty string when meta not configured', async () => {
    const svc = new NationChannelService({
      cols: mongo!.collections,
      gateway: fakeGateway,
      commercial: fakeCommercial,
      now: () => 3000,
    });
    await svc.sendMessage(W, 'alice', 'Alice', 'hi');
    expect(broadcasts[0]['fromPublicId']).toBe('');
    // Must not expose the raw accountId as publicId.
    expect(broadcasts[0]['fromPublicId']).not.toBe('alice');
  });

  // Regression: the profile popup (client) needs a real public id to open + let the user
  // copy it. senderPublicId must be threaded onto both the sendMessage return value and
  // every entry returned by getChannel — not just the fire-and-forget push payload.
  describe('regression: senderPublicId on the message view (ProfilePopup needs a real id, not just the push payload)', () => {
    it('sendMessage() return value carries senderPublicId when meta resolves a profile', async () => {
      const fakeMeta: WorldMetaClient = {
        available: true,
        async getProfile(id) { return id === 'alice' ? { publicId: 'alice#0042', displayName: 'Alice' } : null; },
        async deductMaterial() { throw new Error('unused'); },
        async grantMaterial() { /* no-op */ },
        async getSaveFields() { return null; },
        async escrowEquipment() { throw new Error('unused'); },
        async grantEquipment() { /* no-op */ },
        async grantTitle() { /* no-op */ },
      };
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMeta,
        now: () => 4000,
      });
      const result = await svc.sendMessage(W, 'alice', 'Alice', 'hi');
      expect(result.senderPublicId).toBe('alice#0042');
    });

    it('getChannel() history carries senderPublicId for each message', async () => {
      const fakeMeta: WorldMetaClient = {
        available: true,
        async getProfile(id) { return id === 'alice' ? { publicId: 'alice#0042', displayName: 'Alice' } : null; },
        async deductMaterial() { throw new Error('unused'); },
        async grantMaterial() { /* no-op */ },
        async getSaveFields() { return null; },
        async escrowEquipment() { throw new Error('unused'); },
        async grantEquipment() { /* no-op */ },
        async grantTitle() { /* no-op */ },
      };
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMeta,
        now: () => 5000,
      });
      await svc.sendMessage(W, 'alice', 'Alice', 'hi again');

      const history = await svc.getChannel(W, 'alice');
      expect(history).toHaveLength(1);
      expect(history[0].senderPublicId).toBe('alice#0042');
    });

    it('getChannel() falls back to empty string for legacy docs written before this field existed', async () => {
      // Simulate a pre-migration document: no senderPublicId field at all.
      const legacyDoc = {
        _id: `nm:${W}:6000:1`,
        worldId: W,
        senderId: 'alice',
        senderName: 'Alice',
        body: 'legacy message',
        ts: new Date(6000),
        // senderPublicId intentionally omitted — pretends to predate the migration.
      } as unknown as NationMessageDoc;
      await mongo!.collections.nationMessages.insertOne(legacyDoc);

      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 6000,
      });
      const history = await svc.getChannel(W, 'alice');
      expect(history).toHaveLength(1);
      expect(history[0].senderPublicId).toBe('');
    });
  });

  // Regression: senderName must never trust a stale client-side cache (e.g. leftover from before
  // a rename, or the raw loginId fallback) once meta can resolve the account's real display name.
  describe('regression: senderName is resolved from meta, not blindly trusted from the client', () => {
    it('sendMessage() prefers meta.displayName over the client-supplied senderName', async () => {
      const fakeMeta: WorldMetaClient = {
        available: true,
        async getProfile(id) { return id === 'alice' ? { publicId: 'alice#0042', displayName: 'RealNickname' } : null; },
        async deductMaterial() { throw new Error('unused'); },
        async grantMaterial() { /* no-op */ },
        async getSaveFields() { return null; },
        async escrowEquipment() { throw new Error('unused'); },
        async grantEquipment() { /* no-op */ },
        async grantTitle() { /* no-op */ },
      };
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMeta,
        now: () => 7000,
      });
      // Client sends a stale cached name (e.g. the raw loginId) — meta's real nickname must win.
      const result = await svc.sendMessage(W, 'alice', '233784986', 'hi');
      expect(result.senderName).toBe('RealNickname');
      expect(broadcasts[0]['fromName']).toBe('RealNickname');

      const history = await svc.getChannel(W, 'alice');
      expect(history[0].senderName).toBe('RealNickname');
    });

    it('sendMessage() falls back to the client-supplied senderName when meta has no profile for the account', async () => {
      const fakeMeta: WorldMetaClient = {
        available: true,
        async getProfile() { return null; },
        async deductMaterial() { throw new Error('unused'); },
        async grantMaterial() { /* no-op */ },
        async getSaveFields() { return null; },
        async escrowEquipment() { throw new Error('unused'); },
        async grantEquipment() { /* no-op */ },
        async grantTitle() { /* no-op */ },
      };
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMeta,
        now: () => 8000,
      });
      const result = await svc.sendMessage(W, 'alice', 'ClientFallback', 'hi');
      expect(result.senderName).toBe('ClientFallback');
    });

    it('sendMessage() falls back to the client-supplied senderName when meta is not configured', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 9000,
      });
      const result = await svc.sendMessage(W, 'alice', 'ClientFallback', 'hi');
      expect(result.senderName).toBe('ClientFallback');
    });
  });

  // World chat spans every family/sect, so — unlike the family/sect-scoped channels where the
  // sender's own family/sect is already known — it must resolve an arbitrary sender's title
  // (via meta) and family/sect name (via socialsvc.getMember + getFamiliesByIds + a local
  // cols.sects lookup, since sects are worldsvc-owned) before persisting/returning the message.
  describe('title / sectName / familyName resolution', () => {
    const fakeMetaWithTitle: WorldMetaClient = {
      available: true,
      async getProfile(id) {
        return id === 'alice' ? { publicId: 'alice#0042', displayName: 'Alice', equippedTitle: 'Grandmaster' } : null;
      },
      async deductMaterial() { throw new Error('unused'); },
      async grantMaterial() { /* no-op */ },
      async getSaveFields() { return null; },
      async escrowEquipment() { throw new Error('unused'); },
      async grantEquipment() { /* no-op */ },
      async grantTitle() { /* no-op */ },
    } as unknown as WorldMetaClient;

    function fakeSocialsvc(mem: FamilyMembership | null, families: FamilySummary[]): WorldSocialsvcClient {
      return {
        available: true,
        async getFamilyId() { return mem?.familyId ?? null; },
        async getMember(id) { return id === 'alice' ? mem : null; },
        async getFamiliesByIds() { return families; },
        async getFamiliesBySect() { return []; },
        async setSect() { /* no-op */ },
        async bumpActivity() { /* no-op */ },
        async refreshProsperity() { return 0; },
        async resetSlgState() { /* no-op */ },
        async push() { /* no-op */ },
      };
    }

    it('sendMessage() resolves title + sectName + familyName and getChannel() returns them', async () => {
      await mongo!.collections.sects.insertOne({
        _id: 'sect1', worldId: W, name: 'IronSect', tag: 'IRON',
        leaderFamilyId: 'fam1', leaderId: 'alice', memberFamilyCount: 1,
        allySectIds: [], prosperity: 0, rev: 1,
      });
      const mem: FamilyMembership = { familyId: 'fam1', role: 'leader', leaderId: 'alice', name: 'WangFam', tag: 'WANG', memberCount: 1 };
      const families: FamilySummary[] = [{ familyId: 'fam1', name: 'WangFam', tag: 'WANG', leaderId: 'alice', memberCount: 1, prosperity: 0, sectId: 'sect1' }];

      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMetaWithTitle,
        socialsvc: fakeSocialsvc(mem, families),
        now: () => 10_000,
      });
      const result = await svc.sendMessage(W, 'alice', 'Alice', 'hi everyone');
      expect(result.title).toBe('Grandmaster');
      expect(result.sectName).toBe('IronSect');
      expect(result.familyName).toBe('WangFam');

      const history = await svc.getChannel(W, 'alice');
      expect(history[0]?.title).toBe('Grandmaster');
      expect(history[0]?.sectName).toBe('IronSect');
      expect(history[0]?.familyName).toBe('WangFam');
    });

    it('omits sectName when the sender\'s family is not in a sect (familyName still resolved)', async () => {
      const mem: FamilyMembership = { familyId: 'fam2', role: 'leader', leaderId: 'alice', name: 'LoneFam', tag: 'LONE', memberCount: 1 };
      const families: FamilySummary[] = [{ familyId: 'fam2', name: 'LoneFam', tag: 'LONE', leaderId: 'alice', memberCount: 1, prosperity: 0 }];

      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        meta: fakeMetaWithTitle,
        socialsvc: fakeSocialsvc(mem, families),
        now: () => 11_000,
      });
      const result = await svc.sendMessage(W, 'alice', 'Alice', 'hi');
      expect(result.familyName).toBe('LoneFam');
      expect(result.sectName).toBeUndefined();
    });

    it('omits title/sectName/familyName entirely when meta/socialsvc are not configured', async () => {
      const svc = new NationChannelService({
        cols: mongo!.collections,
        gateway: fakeGateway,
        commercial: fakeCommercial,
        now: () => 12_000,
      });
      const result = await svc.sendMessage(W, 'alice', 'Alice', 'hi');
      expect(result.title).toBeUndefined();
      expect(result.sectName).toBeUndefined();
      expect(result.familyName).toBeUndefined();
    });
  });
});
