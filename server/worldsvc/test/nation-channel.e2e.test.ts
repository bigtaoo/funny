// worldsvc NationChannelService end-to-end: real Mongo, fake gateway + meta.
// Covers send/read (basic happy path) and publicId resolution: meta-available → uses publicId;
// meta unavailable → fromPublicId is empty string (not the raw accountId).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorldMongo, type WorldMongo, type NationMessageDoc } from '../src/db';
import { NationChannelService } from '../src/nationChannelService';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { HttpWorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

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
    ]);
    broadcasts.length = 0;
    spends.length = 0;

    // Settle alice into the world so sendMessage passes the NOT_IN_WORLD guard.
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
});
