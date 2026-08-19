// worldsvc httpApi route-dispatch coverage gaps (admin.ts + nationRoutes.ts): real node:http server via
// startHttpApi + real Mongo, mirroring test/season-ops.e2e.test.ts / test/shard.e2e.test.ts's setup for
// the X-Internal-Key admin branch. The business logic behind these routes (mergeShard/closeSeason/
// allocateNextSeason/patrolShardIsolation/…) is already deeply covered at the service level by
// transfer.e2e.test.ts, shard.e2e.test.ts and season-ops.e2e.test.ts — this file's only job is to walk
// an actual HTTP request through the remaining `/admin/world/*` branches in src/httpApi/admin.ts
// (close/merge success + validation, invalid JSON body, unknown-path 404, non-POST-method 404) and the
// remaining public routes in src/httpApi/nationRoutes.ts (GET /world/nations, POST
// /world/nations/:idx/name) that neither of those files walks over real HTTP. Entire suite skipped if
// Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo, type NationDoc } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { nullWorldGatewayClient } from '../src/gatewayClient';
import { nullWorldSocialsvcClient } from '../src/socialsvcClient';
import { startHttpApi } from '../src/httpApi';
import type { WorldCommercialClient } from '../src/commercialClient';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_http_admin_nation_gaps_test';
const SECRET = 'test-jwt-secret';
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
if (!mongo) console.warn(`[worldsvc.httpApiAdminNationGaps.e2e] Mongo unreachable (${URI}) — skipping.`);

const fakeCommercial: WorldCommercialClient = {
  available: true,
  async spend() { /* no-op */ },
  async grant() { /* no-op */ },
};

describe.skipIf(!mongo)('worldsvc httpApi route-dispatch gaps: admin.ts + nationRoutes.ts', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let svcRef: WorldService;
  const now = () => 1_700_000_000_000;
  const internalHeaders = { 'content-type': 'application/json', 'x-internal-key': KEY };
  const token = signToken('acct-1', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
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
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: KEY },
      svc, sectSvc, nationChannelSvc, nullWorldSocialsvcClient, mapTemplateSvc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  describe('admin.ts', () => {
    it('POST /admin/world/* with an invalid JSON body → 400 (readJson parse failure), not a 500', async () => {
      const r = await fetch(`${base}/admin/world/settle`, {
        method: 'POST', headers: internalHeaders, body: '{not-json',
      });
      expect(r.status).toBe(400);
    });

    it('an unsupported method under /admin/world/* (not POST, not the GET list/patrol/map-templates branches) → 404', async () => {
      const r = await fetch(`${base}/admin/world/settle`, { headers: internalHeaders }); // GET, not POST
      expect(r.status).toBe(404);
    });

    it('POST /admin/world/open missing worldId → 400', async () => {
      const r = await fetch(`${base}/admin/world/open`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ season: 1, shard: 0, capacity: 100 }),
      });
      expect(r.status).toBe(400);
    });

    it('an unknown /admin/world/* POST path (with a worldId) → 404', async () => {
      const r = await fetch(`${base}/admin/world/no-such-op`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: 's-admin-404' }),
      });
      expect(r.status).toBe(404);
    });

    it('POST /admin/world/merge: missing targetWorldId → 400; success moves the remaining player and closes the source shard', async () => {
      const season = 950;
      const a = `s${season}-0`;
      const b = `s${season}-1`;
      await svcRef.openSeason(a, season, 0, 100);
      await svcRef.openSeason(b, season, 1, 100);
      await svcRef.joinWorld(a, 'merge-player');

      const noTarget = await fetch(`${base}/admin/world/merge`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: a }),
      });
      expect(noTarget.status).toBe(400);

      const ok = await fetch(`${base}/admin/world/merge`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: a, targetWorldId: b }),
      });
      expect(ok.status).toBe(200);
      const body = await jsonBody(ok);
      expect(body.data.moved).toBe(1);
      const source = await m.collections.worlds.findOne({ _id: a });
      expect(source!.status).toBe('closed');
    });

    it('POST /admin/world/reset: rejected (SlgError → mapped HTTP status) when the world has not been settled first; success after settling', async () => {
      const wid = 's-admin-reset-test';
      await svcRef.openSeason(wid, 952, 0, 100);

      // resetSeason guards on status (must settle first) — this exercises admin.ts's catch(SlgError) branch,
      // which no existing e2e file reaches over real HTTP (season-ops.e2e.test.ts asserts the same guard by
      // calling svc.resetSeason directly, not through the /admin/world/reset route).
      const rejected = await fetch(`${base}/admin/world/reset`, { method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: wid }) });
      expect(rejected.status).toBe(409); // WORLD_CLOSED
      const rejectedBody = await jsonBody(rejected);
      expect(rejectedBody.error.code).toBe('WORLD_CLOSED');

      await svcRef.joinWorld(wid, 'reset-test-player'); // 'open' → 'active' (settleSeason requires active/settling)
      await svcRef.settleSeason(wid);
      const ok = await fetch(`${base}/admin/world/reset`, { method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: wid }) });
      expect(ok.status).toBe(200);
      const w = await m.collections.worlds.findOne({ _id: wid });
      expect(w!.status).toBe('open');
    });

    it('POST /admin/world/close: success closes an open shard', async () => {
      const wid = 's-admin-close-test';
      await svcRef.openSeason(wid, 951, 0, 100);
      const r = await fetch(`${base}/admin/world/close`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ worldId: wid }),
      });
      expect(r.status).toBe(200);
      const w = await m.collections.worlds.findOne({ _id: wid });
      expect(w!.status).toBe('closed');
    });
  });

  describe('nationRoutes.ts', () => {
    const W = 's1-http-nation';

    it('GET /world/nations: missing worldId → 400; success (empty before any nation is founded)', async () => {
      const bad = await fetch(`${base}/world/nations`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/nations?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await jsonBody(ok)).data)).toBe(true);
    });

    it('POST /world/nations/:idx/name: missing worldId/name → 400; success renames a nation the caller owns', async () => {
      const nation: NationDoc = { _id: `nation:${W}:0`, worldId: W, capitalIdx: 0, x: 5, y: 5, ownerId: 'acct-1', rev: 1 };
      await m.collections.nations.insertOne(nation);

      const noWorld = await fetch(`${base}/world/nations/0/name`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'MyNation' }) });
      expect(noWorld.status).toBe(400);
      const noName = await fetch(`${base}/world/nations/0/name`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noName.status).toBe(400);

      const ok = await fetch(`${base}/world/nations/0/name`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, name: 'MyNation' }),
      });
      expect(ok.status).toBe(200);
      const stored = await m.collections.nations.findOne({ _id: `nation:${W}:0` });
      expect(stored!.nationName).toBe('MyNation');

      // A different account (not the capital's owner) is rejected.
      const otherToken = signToken('acct-2', { secret: SECRET });
      const denied = await fetch(`${base}/world/nations/0/name`, {
        method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W, name: 'Hijack' }),
      });
      expect(denied.status).toBe(403);
    });
  });
});
