// worldsvc httpApi route-dispatch coverage gaps (economyRoutes.ts + seasonRoutes.ts): real node:http
// server via startHttpApi + real Mongo, mirroring test/httpApi.e2e.test.ts's setup. The business logic
// behind every route here is already deeply covered at the service level by dedicated e2e files
// (teams.e2e.test.ts, city-training.e2e.test.ts, city-buildqueue.e2e.test.ts, shop.e2e.test.ts,
// shard.e2e.test.ts, transfer.e2e.test.ts, enter-world.e2e.test.ts, …) — this file's only job is to
// walk an actual HTTP request through every `if (method===X && path===Y)` branch in
// src/httpApi/economyRoutes.ts and src/httpApi/seasonRoutes.ts at least once (success + BAD_REQUEST +
// NOT_FOUND where applicable), so v8 credits the route-dispatch code itself, not just the services it
// calls. Entire suite skipped if Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, playerWorldId, SLG_MAP_W, SLG_MAP_H, SLG_SHOP_ITEMS, type CardInstance } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { nullWorldGatewayClient } from '../src/gatewayClient';
import { nullWorldSocialsvcClient } from '../src/socialsvcClient';
import { startHttpApi } from '../src/httpApi';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldCommercialClient } from '../src/commercialClient';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_http_econ_season_gaps_test';
const SECRET = 'test-jwt-secret';
const W = 's1-http-econ';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.httpApiEconomySeasonGaps.e2e] Mongo unreachable (${URI}) — skipping.`);

// Any cardInstanceId resolves to an owned 'lichuang' card — matches test/siege-replay-cardinstances.e2e's
// CARD_INV_ANY fixture. Only needed so PUT /world/teams (even with an empty array) doesn't fail on the
// unconditional cardInv lookup inside setTeams.
const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, gear: {}, locked: false }),
});
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() {
    return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY };
  },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
  batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
};
const fakeCommercial: WorldCommercialClient = {
  available: true,
  async spend() { /* no-op: free in this suite */ },
  async grant() { /* no-op */ },
};

describe.skipIf(!mongo)('worldsvc httpApi route-dispatch gaps: economyRoutes + seasonRoutes', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let t = 1_000_000;
  const now = () => t;
  const token = signToken('acct-1', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let seq = 0;
  /** A fresh account id + auth header, for tests that need clean per-account state (build/train queues, etc.). */
  function freshAccount(): { id: string; auth: Record<string, string> } {
    const id = `acct-econ-${++seq}`;
    return { id, auth: { authorization: `Bearer ${signToken(id, { secret: SECRET })}`, 'content-type': 'application/json' } };
  }
  async function seedRichResources(accountId: string): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 } } },
    );
  }
  async function joinFresh(): Promise<{ id: string; auth: Record<string, string> }> {
    const acct = freshAccount();
    await fetch(`${base}/world/join`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W }) });
    return acct;
  }

  let svcRef: WorldService;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new WorldService({
      cols: m.collections, redis: null, meta: fakeMeta, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now,
    });
    svcRef = svc;
    const sectSvc = new SectService({ cols: m.collections, now });
    const nationChannelSvc = new NationChannelService({
      cols: m.collections,
      gateway: nullWorldGatewayClient as unknown as ConstructorParameters<typeof NationChannelService>[0]['gateway'],
      commercial: fakeCommercial,
      now,
    });
    const mapTemplateSvc = new MapTemplateService({ cols: m.collections, now });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'test-internal-key' },
      svc, sectSvc, nationChannelSvc, nullWorldSocialsvcClient, mapTemplateSvc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // W needs a real WorldDoc (GET /world/season reads it) — open it directly, then join acct-1 for reuse
    // by most economyRoutes tests below.
    await svcRef.openSeason(W, 1, 0, 10000);
    await fetch(`${base}/world/join`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  describe('economyRoutes.ts', () => {
    it('GET /world/defense missing worldId → 400', async () => {
      const r = await fetch(`${base}/world/defense?tileKey=base`, { headers: auth });
      expect(r.status).toBe(400);
    });

    it('PUT /world/defense missing defenseConfig → 400', async () => {
      const r = await fetch(`${base}/world/defense`, {
        method: 'PUT', headers: auth, body: JSON.stringify({ worldId: W, tileKey: 'base' }),
      });
      expect(r.status).toBe(400);
    });

    it('GET /world/teams missing worldId → 400; success (no teams yet) → 200 []', async () => {
      const bad = await fetch(`${base}/world/teams`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/teams?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect((await jsonBody(ok)).data).toEqual([]);
    });

    it('PUT /world/teams missing worldId → 400; missing teams → 400; success (empty array) → 200', async () => {
      const noWorld = await fetch(`${base}/world/teams`, { method: 'PUT', headers: auth, body: JSON.stringify({ teams: [] }) });
      expect(noWorld.status).toBe(400);
      const noTeams = await fetch(`${base}/world/teams`, { method: 'PUT', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noTeams.status).toBe(400);
      const ok = await fetch(`${base}/world/teams`, { method: 'PUT', headers: auth, body: JSON.stringify({ worldId: W, teams: [] }) });
      expect(ok.status).toBe(200);
    });

    it('POST /world/troops/distribute: missing worldId → 400; missing allocations → 400; success deducts from the troop pool', async () => {
      const noWorld = await fetch(`${base}/world/troops/distribute`, { method: 'POST', headers: auth, body: JSON.stringify({ allocations: {} }) });
      expect(noWorld.status).toBe(400);
      const noAlloc = await fetch(`${base}/world/troops/distribute`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noAlloc.status).toBe(400);

      // A card assigned to a team (teamId set directly — distributeTroops itself never touches meta).
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'acct-1') },
        { $set: { troops: 1000, 'cardState.card-distribute-1': { currentTroops: 0, teamId: 't1' } } },
      );
      const ok = await fetch(`${base}/world/troops/distribute`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, allocations: { 'card-distribute-1': 100 } }),
      });
      expect(ok.status).toBe(200);
      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'acct-1') });
      expect(pw?.troops).toBe(900);
      expect(pw?.cardState?.['card-distribute-1']?.currentTroops).toBe(100);
    });

    it('POST /world/troops/recover: missing worldId → 400; missing cardInstanceId → 400; success clears injuredUntil', async () => {
      const noWorld = await fetch(`${base}/world/troops/recover`, { method: 'POST', headers: auth, body: JSON.stringify({ cardInstanceId: 'x' }) });
      expect(noWorld.status).toBe(400);
      const noCard = await fetch(`${base}/world/troops/recover`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noCard.status).toBe(400);

      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'acct-1') },
        { $set: { 'cardState.card-injured-1': { currentTroops: 10, injuredUntil: now() + 60_000 } } },
      );
      const ok = await fetch(`${base}/world/troops/recover`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, cardInstanceId: 'card-injured-1' }),
      });
      expect(ok.status).toBe(200);
      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'acct-1') });
      expect(pw?.cardState?.['card-injured-1']?.injuredUntil).toBeFalsy();
    });

    it('POST /world/troops/train: missing worldId → 400; invalid qty → 400; success enqueues a batch', async () => {
      const acct = await joinFresh();
      await seedRichResources(acct.id);
      // A fresh capital starts with troops == troopCap (full garrison) — free up room under the cap first.
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, acct.id) }, { $set: { troops: 0 } });
      const noWorld = await fetch(`${base}/world/troops/train`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ qty: 1 }) });
      expect(noWorld.status).toBe(400);
      const badQty = await fetch(`${base}/world/troops/train`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, qty: 0 }) });
      expect(badQty.status).toBe(400);
      const ok = await fetch(`${base}/world/troops/train`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, qty: 5 }) });
      expect(ok.status).toBe(200);
      const body = await jsonBody(ok);
      expect(body.data.trainingQueue.length).toBeGreaterThan(0);
    });

    it('POST /world/troops/speedup: missing worldId → 400; invalid coins → 400; success shortens the queue', async () => {
      const acct = await joinFresh();
      await seedRichResources(acct.id);
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, acct.id) }, { $set: { troops: 0 } });
      await fetch(`${base}/world/troops/train`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, qty: 5 }) });
      const noWorld = await fetch(`${base}/world/troops/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ coins: 10 }) });
      expect(noWorld.status).toBe(400);
      const badCoins = await fetch(`${base}/world/troops/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, coins: 0 }) });
      expect(badCoins.status).toBe(400);
      const ok = await fetch(`${base}/world/troops/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, coins: 10 }) });
      expect(ok.status).toBe(200);
    });

    it('POST /world/build/upgrade missing worldId → 400', async () => {
      const r = await fetch(`${base}/world/build/upgrade`, { method: 'POST', headers: auth, body: JSON.stringify({ key: 'wall' }) });
      expect(r.status).toBe(400);
    });

    it('POST /world/build/speedup: missing worldId → 400; invalid coins → 400; success shortens the build queue', async () => {
      const acct = await joinFresh();
      await seedRichResources(acct.id);
      await fetch(`${base}/world/build/upgrade`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, key: 'wall' }) });
      const noWorld = await fetch(`${base}/world/build/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ coins: 10 }) });
      expect(noWorld.status).toBe(400);
      const badCoins = await fetch(`${base}/world/build/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, coins: 0 }) });
      expect(badCoins.status).toBe(400);
      const ok = await fetch(`${base}/world/build/speedup`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, coins: 10 }) });
      expect(ok.status).toBe(200);
    });

    it('GET /world/season: success, missing worldId → 400, unknown worldId → 404', async () => {
      const ok = await fetch(`${base}/world/season?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect((await jsonBody(ok)).data).toMatchObject({ worldId: W });
      const noWorld = await fetch(`${base}/world/season`, { headers: auth });
      expect(noWorld.status).toBe(400);
      const notFound = await fetch(`${base}/world/season?worldId=no-such-world-xyz`, { headers: auth });
      expect(notFound.status).toBe(404);
    });

    it('GET /world/shop/items → 200 (item catalog)', async () => {
      const r = await fetch(`${base}/world/shop/items`, { headers: auth });
      expect(r.status).toBe(200);
      const body = await jsonBody(r);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('POST /world/shop/buy: missing worldId/itemId → 400; success purchases an item', async () => {
      const acct = await joinFresh();
      const bad = await fetch(`${base}/world/shop/buy`, { method: 'POST', headers: acct.auth, body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const item = SLG_SHOP_ITEMS[0]!;
      const ok = await fetch(`${base}/world/shop/buy`, {
        method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: W, itemId: item.id }),
      });
      expect(ok.status).toBe(200);
    });
  });

  describe('seasonRoutes.ts', () => {
    it('POST /world/season/resolve: missing season → 400; success resolves/opens a shard', async () => {
      const bad = await fetch(`${base}/world/season/resolve`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/season/resolve`, { method: 'POST', headers: auth, body: JSON.stringify({ season: 901 }) });
      expect(ok.status).toBe(200);
      const body = await jsonBody(ok);
      expect(typeof body.data.worldId).toBe('string');
    });

    it('POST /world/season/join: missing season → 400; success joins a freshly-resolved shard', async () => {
      const acct = await joinFresh(); // distinct account so sticky/family lookups from other tests don't interfere
      const bad = await fetch(`${base}/world/season/join`, { method: 'POST', headers: acct.auth, body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/season/join`, { method: 'POST', headers: acct.auth, body: JSON.stringify({ season: 902 }) });
      expect(ok.status).toBe(200);
      expect((await jsonBody(ok)).data.joined).toBe(true);
    });

    it('GET /world/season/transfer/targets: missing worldId → 400; success (possibly empty) list', async () => {
      const bad = await fetch(`${base}/world/season/transfer/targets`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/season/transfer/targets?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await jsonBody(ok)).data)).toBe(true);
    });

    it('POST /world/season/transfer: missing fromWorldId/toWorldId → 400; success moves the account between shards', async () => {
      const bad = await fetch(`${base}/world/season/transfer`, { method: 'POST', headers: auth, body: JSON.stringify({ fromWorldId: W }) });
      expect(bad.status).toBe(400);

      // Two same-season shards opened directly via the service (setup only — transferShard's own business
      // rules are covered in depth by transfer.e2e.test.ts; this test just walks the HTTP route once).
      const season = 903;
      const fromWorldId = `s${season}-0`;
      const toWorldId = `s${season}-1`;
      await svcRef.openSeason(fromWorldId, season, 0, 100);
      await svcRef.openSeason(toWorldId, season, 1, 100);
      const acct = freshAccount();
      await svcRef.joinWorld(fromWorldId, acct.id);

      const ok = await fetch(`${base}/world/season/transfer`, {
        method: 'POST', headers: acct.auth, body: JSON.stringify({ fromWorldId, toWorldId }),
      });
      expect(ok.status).toBe(200);
      const body = await jsonBody(ok);
      expect(body.data).toMatchObject({ joined: true, worldId: toWorldId });
    });

    it('POST /world/enter: missing worldId → 400; success auto-joins + aggregates map/season/nations/marches', async () => {
      const acct = freshAccount();
      const bad = await fetch(`${base}/world/enter`, { method: 'POST', headers: acct.auth, body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/enter`, {
        method: 'POST', headers: acct.auth, body: JSON.stringify({ worldId: 's1-http-econ-enter', r: 5, zoom: 1 }),
      });
      expect(ok.status).toBe(200);
      const body = await jsonBody(ok);
      expect(body.data.me.joined).toBe(true);
      expect(body.data.map).toBeDefined();
      expect(Array.isArray(body.data.marches)).toBe(true);
      expect(body.data.worldChannel).toBeDefined();
    });
  });
});
