// worldsvc httpApi route-dispatch coverage gaps (actionRoutes.ts + siegeRoutes.ts + mapRoutes.ts): real
// node:http server via startHttpApi + real Mongo, mirroring test/httpApi.e2e.test.ts's setup. The
// business logic behind every route here is already deeply covered at the service level by dedicated
// e2e files (occupy-march.e2e.test.ts, teams.e2e.test.ts, watchtower.e2e.test.ts, field-*.e2e.test.ts,
// march-*.e2e.test.ts, siege.e2e.test.ts, territories.e2e.test.ts, …) — this file's only job is to walk
// an actual HTTP request through every `if (method===X && path===Y)` branch in
// src/httpApi/actionRoutes.ts, src/httpApi/siegeRoutes.ts and src/httpApi/mapRoutes.ts at least once
// (success + BAD_REQUEST + NOT_FOUND where applicable), so v8 credits the route-dispatch code itself,
// not just the services it calls. Entire suite skipped if Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  signToken, proceduralTile, tileId, npcGarrison, playerWorldId, SLG_MAP_W, SLG_MAP_H,
  type CardInstance,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { nullWorldGatewayClient } from '../src/gatewayClient';
import { nullWorldSocialsvcClient } from '../src/socialsvcClient';
import { startHttpApi } from '../src/httpApi';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_http_action_siege_map_gaps_test';
const SECRET = 'test-jwt-secret';
const W = 's1-http-action';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.httpApiActionSiegeMapGaps.e2e] Mongo unreachable (${URI}) — skipping.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(predicate: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number): { x: number; y: number } {
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

/** ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only occupyTile. */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }, avoid: Set<string> = new Set()): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    const key = `${nx}:${ny}`;
    if (avoid.has(key)) continue;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    avoid.add(key);
    return;
  }
  throw new Error('no connector neighbor found');
}

// Any cardInstanceId resolves to an owned 'lichuang' card (matches siege-replay-cardinstances.e2e.test.ts) —
// only needed so setTeams (a prerequisite for team-based march/cancel-occupation/recall-stationed routes)
// doesn't fail on its unconditional cardInv lookup.
const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false }),
});
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};
const fakeCommercial: WorldCommercialClient = {
  available: true,
  async spend() { /* no-op: free in this suite */ },
  async grant() { /* no-op */ },
};

describe.skipIf(!mongo)('worldsvc httpApi route-dispatch gaps: actionRoutes + siegeRoutes + mapRoutes', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let t = 1_000_000;
  const now = () => t;
  let svcRef: WorldService;
  const token = signToken('acct-1', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let baseX = 0;
  let baseY = 0;

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

    const jr = await fetch(`${base}/world/join`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
    const data = (await jr.json()).data as { mainBaseTile: string };
    const parts = data.mainBaseTile.split(':');
    baseX = Number(parts[parts.length - 2]);
    baseY = Number(parts[parts.length - 1]);
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  describe('mapRoutes.ts', () => {
    it('GET /world/map/sparse: missing worldId → 400; success with default (thin) and mid lod', async () => {
      const bad = await fetch(`${base}/world/map/sparse`, { headers: auth });
      expect(bad.status).toBe(400);
      const thin = await fetch(`${base}/world/map/sparse?worldId=${W}&cx=${baseX}&cy=${baseY}&r=3`, { headers: auth });
      expect(thin.status).toBe(200);
      const mid = await fetch(`${base}/world/map/sparse?worldId=${W}&cx=${baseX}&cy=${baseY}&r=3&lod=mid`, { headers: auth });
      expect(mid.status).toBe(200);
    });

    it('GET /world/tile/:id: malformed tileId (not 3 parts) → 400; non-numeric coords → 400', async () => {
      const badParts = await fetch(`${base}/world/tile/${encodeURIComponent('not-enough-parts')}`, { headers: auth });
      expect(badParts.status).toBe(400);
      const badCoords = await fetch(`${base}/world/tile/${encodeURIComponent(`${W}:abc:def`)}`, { headers: auth });
      expect(badCoords.status).toBe(400);
    });

    it('GET /world/march: missing worldId → 400; success (list)', async () => {
      const bad = await fetch(`${base}/world/march`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/march?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json()).data)).toBe(true);
    });

    it('GET /world/occupations: missing worldId → 400; success (list)', async () => {
      const bad = await fetch(`${base}/world/occupations`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/occupations?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json()).data)).toBe(true);
    });

    it('GET /world/stationed: missing worldId → 400; success (list)', async () => {
      const bad = await fetch(`${base}/world/stationed`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/stationed?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json()).data)).toBe(true);
    });

    it('GET /world/territories: missing worldId → 400; success (list)', async () => {
      const bad = await fetch(`${base}/world/territories`, { headers: auth });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/world/territories?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json()).data)).toBe(true);
    });
  });

  describe('actionRoutes.ts: abandon / relocate / watchtower', () => {
    it('shared validation: missing worldId → 400; missing x/y → 400', async () => {
      const noWorld = await fetch(`${base}/world/watchtower`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 1, y: 1 }) });
      expect(noWorld.status).toBe(400);
      const noXY = await fetch(`${base}/world/watchtower`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noXY.status).toBe(400);
    });

    it('POST /world/abandon: success releases an owned non-capital tile', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX + 20, baseY);
      await svcRef.occupyTile(W, 'acct-1', target.x, target.y);
      const r = await fetch(`${base}/world/abandon`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: target.x, y: target.y }),
      });
      expect(r.status).toBe(200);
      expect(await m.collections.tiles.findOne({ _id: tileId(W, target.x, target.y) })).toBeNull();
    });

    it('POST /world/relocate: success no-op when the target is already the current base tile', async () => {
      const r = await fetch(`${base}/world/relocate`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: baseX, y: baseY }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data.mainBaseTile).toBe(tileId(W, baseX, baseY));
    });

    it('POST /world/watchtower: success builds a watchtower on an owned territory', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX - 20, baseY);
      await svcRef.occupyTile(W, 'acct-1', target.x, target.y);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'acct-1') },
        { $set: { resources: { ink: 100_000, paper: 100_000, graphite: 100_000, metal: 100_000, sticker: 100_000 } } },
      );
      const r = await fetch(`${base}/world/watchtower`, {
        method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: target.x, y: target.y }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data).toMatchObject({ x: target.x, y: target.y, watchtower: true });
      expect(body.data.me).toBeDefined();
    });
  });

  describe('actionRoutes.ts: structure build/demolish', () => {
    it('POST /world/structure: missing worldId/x/y/kind → 400; success builds a blocker', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX + 25, baseY + 10);
      await svcRef.occupyTile(W, 'acct-1', target.x, target.y);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'acct-1') },
        { $set: { resources: { ink: 100_000, paper: 100_000, graphite: 100_000, metal: 100_000, sticker: 100_000 } } },
      );
      const noWorld = await fetch(`${base}/world/structure`, { method: 'POST', headers: auth, body: JSON.stringify({ x: target.x, y: target.y, kind: 'blocker' }) });
      expect(noWorld.status).toBe(400);
      const noXY = await fetch(`${base}/world/structure`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, kind: 'blocker' }) });
      expect(noXY.status).toBe(400);
      const badKind = await fetch(`${base}/world/structure`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: target.x, y: target.y, kind: 'nope' }) });
      expect(badKind.status).toBe(400);
      const ok = await fetch(`${base}/world/structure`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: target.x, y: target.y, kind: 'blocker' }) });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.data.structure).toMatchObject({ kind: 'blocker' });
      expect(body.data.me).toBeDefined();
    });

    it('POST /world/structure/demolish: missing worldId/x/y → 400; success removes the structure just built above', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX + 25, baseY + 10);
      const noWorld = await fetch(`${base}/world/structure/demolish`, { method: 'POST', headers: auth, body: JSON.stringify({ x: target.x, y: target.y }) });
      expect(noWorld.status).toBe(400);
      const noXY = await fetch(`${base}/world/structure/demolish`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(noXY.status).toBe(400);
      const ok = await fetch(`${base}/world/structure/demolish`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W, x: target.x, y: target.y }) });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.data.structure).toBeUndefined();
    });
  });

  describe('actionRoutes.ts: march recall / instant-return', () => {
    it('POST /world/march/:id/recall then /world/march/:id/instant-return: missing worldId → 400 on both; success flips to a return leg and then settles it instantly', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX + 30, baseY + 30);
      await connect(svcRef, 'acct-1', target);
      const dispatch = await fetch(`${base}/world/march`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ worldId: W, fromX: baseX, fromY: baseY, toX: target.x, toY: target.y, kind: 'occupy', troops: 600 }),
      });
      expect(dispatch.status).toBe(200);
      const marchId = (await dispatch.json()).data.marchId as string;

      const noWorldRecall = await fetch(`${base}/world/march/${marchId}/recall`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
      expect(noWorldRecall.status).toBe(400);

      const recall = await fetch(`${base}/world/march/${marchId}/recall`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(recall.status).toBe(200);
      expect((await recall.json()).data.kind).toBe('return');

      const noWorldReturn = await fetch(`${base}/world/march/${marchId}/instant-return`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
      expect(noWorldReturn.status).toBe(400);

      const instant = await fetch(`${base}/world/march/${marchId}/instant-return`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(instant.status).toBe(200);
      // The return leg is gone (settled instantly), not still in the march list.
      const marches = await fetch(`${base}/world/march?worldId=${W}`, { headers: auth });
      expect((await marches.json()).data.some((mm: { marchId: string }) => mm.marchId === marchId)).toBe(false);
    });
  });

  describe('actionRoutes.ts: team cancel-occupation / recall-stationed', () => {
    it('POST /world/team/:id/cancel-occupation: missing worldId → 400; success frees a mid-hold team', async () => {
      const target = findCoord((tl) => (tl.type === 'resource' || tl.type === 'neutral') && tl.level <= 2, baseX, baseY + 40);
      const proc = proceduralTile(W, target.x, target.y);
      const npc = npcGarrison(proc.level);
      await connect(svcRef, 'acct-1', target, new Set([`${baseX}:${baseY}`]));
      // 12 cards (CARD_TEAM_MAX_SIZE) spread across lanes, each carrying a comfortable overwhelming-force
      // margin over the NPC garrison (mirrors teams.e2e.test.ts's winning-formation convention) — a single
      // card in one lane can lose to a full-width NPC spread on raw troop count alone.
      const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 0, 1];
      const entries: TeamTemplate['army'] = lanes.map((col, i) => ({ cardInstanceId: `card-cancel-${i}`, col, row: 1 + Math.floor(i / lanes.length) }));
      const cardStateSet: Record<string, unknown> = {};
      for (let i = 0; i < entries.length; i++) cardStateSet[`cardState.card-cancel-${i}`] = { currentTroops: Math.ceil(npc / 8) + 100 };
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'acct-1') }, { $set: cardStateSet });
      await svcRef.setTeams(W, 'acct-1', [{ id: 'tcancel', name: 'Cancel', army: entries }]);
      const mv = await svcRef.startMarch(W, 'acct-1', baseX, baseY, target.x, target.y, 'occupy', 1, 'tcancel');
      t = mv.arriveAt;
      expect(await svcRef.processDueArrivals()).toBeGreaterThanOrEqual(1);
      expect(await svcRef.getOccupations(W, 'acct-1')).not.toHaveLength(0);

      const noWorld = await fetch(`${base}/world/team/tcancel/cancel-occupation`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
      expect(noWorld.status).toBe(400);
      const ok = await fetch(`${base}/world/team/tcancel/cancel-occupation`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(ok.status).toBe(200);
      expect(await svcRef.getOccupations(W, 'acct-1')).toHaveLength(0);
    });

    it('POST /world/team/:id/recall-stationed: missing worldId → 400; success recalls a parked team', async () => {
      const target = findCoord((tl) => tl.type === 'resource' || tl.type === 'neutral', baseX - 30, baseY - 10);
      const entries: TeamTemplate['army'] = [{ cardInstanceId: 'card-recall-1', col: 0, row: 1 }];
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'acct-1') },
        { $set: { 'cardState.card-recall-1': { currentTroops: 200 } } },
      );
      await svcRef.setTeams(W, 'acct-1', [{ id: 'trecall', name: 'Recall', army: entries }]);
      const mv = await svcRef.startMarch(W, 'acct-1', baseX, baseY, target.x, target.y, 'move', 1, 'trecall');
      t = mv.arriveAt;
      expect(await svcRef.processDueArrivals()).toBeGreaterThanOrEqual(1);
      expect((await svcRef.getStationed(W, 'acct-1')).some((s) => s.teamId === 'trecall')).toBe(true);

      const noWorld = await fetch(`${base}/world/team/trecall/recall-stationed`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
      expect(noWorld.status).toBe(400);
      const ok = await fetch(`${base}/world/team/trecall/recall-stationed`, { method: 'POST', headers: auth, body: JSON.stringify({ worldId: W }) });
      expect(ok.status).toBe(200);
      expect((await svcRef.getStationed(W, 'acct-1')).some((s) => s.teamId === 'trecall')).toBe(false);
    });
  });

  describe('actionRoutes.ts: sweep', () => {
    it('POST /world/sweep: success dispatches a sweep march against an NPC-garrisoned tile', async () => {
      const target = findCoord((tl) => (tl.type === 'resource' || tl.type === 'neutral') && tl.level <= 2, baseX + 10, baseY - 40);
      const proc = proceduralTile(W, target.x, target.y);
      const npc = npcGarrison(proc.level);
      await connect(svcRef, 'acct-1', target, new Set([`${baseX}:${baseY}`]));
      const r = await fetch(`${base}/world/sweep`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ worldId: W, fromX: baseX, fromY: baseY, toX: target.x, toY: target.y, troops: npc + 600 }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data.kind).toBe('sweep');
    });
  });

  describe('siegeRoutes.ts', () => {
    let siegeId: string;

    it('a real PvE occupy battle produces a replayable siege record (setup for the replay/list tests below)', async () => {
      const target = findCoord((tl) => (tl.type === 'resource' || tl.type === 'neutral') && tl.level <= 2, baseX + 40, baseY + 5);
      await connect(svcRef, 'acct-1', target, new Set([`${baseX}:${baseY}`]));
      const proc = proceduralTile(W, target.x, target.y);
      const npc = npcGarrison(proc.level);
      const mv = await svcRef.startMarch(W, 'acct-1', baseX, baseY, target.x, target.y, 'occupy', npc + 600);
      t = mv.arriveAt;
      expect(await svcRef.processDueArrivals()).toBeGreaterThanOrEqual(1);
      const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'acct-1' }, { sort: { ts: -1 } });
      expect(siege).toBeTruthy();
      siegeId = siege!._id;
    });

    it('GET /world/siege/:id/replay: missing worldId → 400; unknown siege → 404; success returns the replay + permission is enforced', async () => {
      const noWorld = await fetch(`${base}/world/siege/${siegeId}/replay`, { headers: auth });
      expect(noWorld.status).toBe(400);
      const notFound = await fetch(`${base}/world/siege/no-such-siege/replay?worldId=${W}`, { headers: auth });
      expect(notFound.status).toBe(404);
      const ok = await fetch(`${base}/world/siege/${siegeId}/replay?worldId=${W}`, { headers: auth });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.data.siegeId).toBe(siegeId);
      expect(typeof body.data.seed).toBe('number');

      // A third party (neither attacker nor defender — this was a PvE fight, so only the attacker qualifies) is rejected.
      const strangerToken = signToken('acct-stranger', { secret: SECRET });
      const denied = await fetch(`${base}/world/siege/${siegeId}/replay?worldId=${W}`, {
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      expect(denied.status).toBe(403);
    });

    it('GET /world/sieges: missing worldId → 400; success lists the recorded battle with a limit param', async () => {
      const noWorld = await fetch(`${base}/world/sieges`, { headers: auth });
      expect(noWorld.status).toBe(400);
      const ok = await fetch(`${base}/world/sieges?worldId=${W}&limit=5`, { headers: auth });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((s: { siegeId: string }) => s.siegeId === siegeId)).toBe(true);
    });
  });
});
