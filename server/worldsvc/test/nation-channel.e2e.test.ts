// worldsvc NationChannelService end-to-end: real Mongo, fake gateway + meta.
// Covers send/read (basic happy path) and publicId resolution: meta-available → uses publicId;
// meta unavailable → fromPublicId is empty string (not the raw accountId).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorldMongo, type WorldMongo } from '../src/db';
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
});
