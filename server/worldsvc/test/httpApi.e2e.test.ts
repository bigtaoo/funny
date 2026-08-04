// worldsvc public REST end-to-end (S8-0/S8-1): real node:http server + global fetch calls (curl equivalent).
//   • /health requires no authentication; missing token → 401;
//   • GET /world/map, /world/me, /world/tile/{id} (procedural + player state);
//   • POST /world/join (real database writes; /world/occupy is intentionally NOT a public route — see below);
//   • unimplemented write endpoints → 501; unknown routes → 404.
// Service requires real Mongo (dedicated database); entire suite skipped if Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, proceduralTile, playerWorldId, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import { NationChannelService } from '../src/nationChannelService';
import { MapTemplateService } from '../src/mapTemplateService';
import { nullWorldGatewayClient } from '../src/gatewayClient';
import { nullWorldSocialsvcClient } from '../src/socialsvcClient';
import { startHttpApi } from '../src/httpApi';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_http_test';
const SECRET = 'test-jwt-secret';
const W = 's1-http';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.httpApi.e2e] Mongo unreachable (${URI}) — skipping.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Find a resource tile (far from the capital). */
function findResource(): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = 50 + dx;
        const y = 50 + dy;
        if (proceduralTile(W, x, y).type === 'resource') return { x, y };
      }
    }
  }
  throw new Error('no resource tile');
}

/** Find a free tile that can be occupied (not the center tile, not inside the 3×3 base footprint anchored at (exX,exY)).
 *  ADR-025: a capital occupies its anchor + 8 ring cells, so the whole footprint is off-limits as a march target. */
function findFreeNear(sx: number, sy: number, exX: number, exY: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (Math.abs(x - exX) <= 1 && Math.abs(y - exY) <= 1) continue; // inside the 3×3 base footprint
        const t = proceduralTile(W, x, y).type;
        if (t === 'neutral' || t === 'resource') return { x, y };
      }
    }
  }
  throw new Error('no free tile');
}

describe.skipIf(!mongo)('worldsvc httpApi e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  const token = signToken('acct-1', { secret: SECRET });
  let t = 1_000_000;
  let svcRef: WorldService;

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    const svc = new WorldService({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now: () => t,
    });
    const sectSvc = new SectService({ cols: m.collections, now: () => t });
    const nationChannelSvc = new NationChannelService({
      cols: m.collections,
      gateway: nullWorldGatewayClient as unknown as ConstructorParameters<typeof NationChannelService>[0]['gateway'],
      commercial: { available: true, async spend() { /* no-op: free in this suite */ }, async grant() { /* no-op */ } },
      now: () => t,
    });
    const mapTemplateSvc = new MapTemplateService({ cols: m.collections, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'test-internal-key' },
      svc,
      sectSvc,
      nationChannelSvc,
      nullWorldSocialsvcClient,
      mapTemplateSvc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    svcRef = svc;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const auth = { authorization: `Bearer ${token}` };
  // Auto-settle base (§3.4): landing position is chosen by the server; captured from the join response for use in subsequent march tests.
  let baseX = 0;
  let baseY = 0;

  it('GET /health requires no authentication', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: 'worldsvc' });
  });

  it('no token → 401', async () => {
    const r = await fetch(`${base}/world/map?worldId=${W}&cx=10&cy=10&r=2`);
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /world/map: procedural viewport + 9×9 world-center footprint (ADR-034)', async () => {
    // A ±2 (5×5) window around the exact map center sits entirely inside the 9×9 world-center footprint.
    const r = await fetch(`${base}/world/map?worldId=${W}&cx=${CENTER_X}&cy=${CENTER_Y}&r=2`, {
      headers: auth,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.data.tiles).toHaveLength(25);
    expect(body.data.tiles.filter((tl: { type: string }) => tl.type === 'center')).toHaveLength(25);
  });

  it('POST /world/join (server auto-places base, §3.4) → /world/me joined, /world/tile base', async () => {
    const jr = await fetch(`${base}/world/join`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W }), // no coordinates provided — server picks the landing spot automatically
    });
    expect(jr.status).toBe(200);
    const data = (await jr.json()).data as { joined: boolean; mainBaseTile: string };
    expect(data.joined).toBe(true);
    // Landing spot is server-determined: captured and asserted to be a valid base tile (not center, not obstacle, etc.).
    expect(data.mainBaseTile).toMatch(new RegExp(`^${W}:\\d+:\\d+$`));
    const parts = data.mainBaseTile.split(':');
    baseX = Number(parts[parts.length - 2]);
    baseY = Number(parts[parts.length - 1]);
    expect(baseX === CENTER_X && baseY === CENTER_Y).toBe(false);

    const me = await fetch(`${base}/world/me?worldId=${W}`, { headers: auth });
    expect((await me.json()).data.joined).toBe(true);

    const tile = await fetch(`${base}/world/tile/${encodeURIComponent(data.mainBaseTile)}`, {
      headers: auth,
    });
    expect((await tile.json()).data).toMatchObject({ type: 'base', mine: true });
  });

  it('occupyTile (internal/test-only, ADR-037 — not a public HTTP route) → territory mine', async () => {
    // occupyTile is deliberately NOT reachable over the public HTTP surface (see httpApi.ts) — it's an
    // instant, no-combat capture kept only for e2e test setup convenience, called directly on the service
    // like every other e2e test in this repo. The real client-facing occupy flow is POST /world/march
    // with kind:'occupy' (covered by the next test below).
    const res = findResource();
    const view = await svcRef.occupyTile(W, 'acct-1', res.x, res.y);
    expect(view).toMatchObject({ type: 'territory', mine: true });
    const r = await fetch(`${base}/world/occupy`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, x: res.x, y: res.y }),
    });
    expect(r.status).toBe(404); // confirms the route is genuinely gone from the public HTTP surface
  });

  it('POST /world/join missing worldId → 400', async () => {
    const r = await fetch(`${base}/world/join`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1, y: 1 }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /world/march → occupy march (marching)', async () => {
    // acct-1 has already auto-settled (baseX,baseY); sending an occupy march to a neighbouring free tile.
    const free = findFreeNear(baseX, baseY, baseX, baseY);
    // ADR-039 territory connectivity: findFreeNear's search order can land on a tile only diagonally touching
    // the base footprint (not 4-directionally adjacent) — border it first via occupyTile (internal/test-only
    // instant occupy, ADR-037, called directly on the service — see the test above) so the march clears the
    // new gate. Try all 4 neighbors; skip obstacle/center/inside-footprint.
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = free.x + dx, ny = free.y + dy;
      if (Math.abs(nx - baseX) <= 1 && Math.abs(ny - baseY) <= 1) continue; // inside the 3×3 base footprint
      const t = proceduralTile(W, nx, ny).type;
      if (t !== 'resource' && t !== 'neutral') continue;
      try {
        await svcRef.occupyTile(W, 'acct-1', nx, ny);
        break;
      } catch { /* try next neighbor */ }
    }
    const r = await fetch(`${base}/world/march`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        worldId: W,
        fromX: baseX,
        fromY: baseY,
        toX: free.x,
        toY: free.y,
        kind: 'occupy',
        troops: 500,
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ kind: 'occupy', status: 'marching' });
    expect(typeof body.data.marchId).toBe('string');
    // P1-3 (comm-audit-2026-07-27): the response carries `me` (troops/resources committed aren't
    // visible on the march itself) so the client can adopt it directly instead of a follow-up
    // GET /world/me — this was the whole point of the change, so lock it in.
    expect(body.data.me).toBeDefined();
    expect(typeof body.data.me.mainBaseTile === 'string' || body.data.me.mainBaseTile === undefined).toBe(true);
  });

  it('POST /world/march missing coordinates → 400', async () => {
    const r = await fetch(`${base}/world/march`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, kind: 'occupy', troops: 500 }),
    });
    expect(r.status).toBe(400);
  });

  it('defense config (C3): PUT home base defense → GET retrieves it; missing worldId → 400; unknown route → 404', async () => {
    const config = {
      garrison: [{ unitType: 'infantry', col: 3, row: 16 }],
      defenderBuildings: [{ buildingType: 'arrow_tower', col: 7 }],
      defenderBaseLevel: 2,
    };
    const put = await fetch(`${base}/world/defense`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, tileKey: 'base', defenseConfig: config }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${base}/world/defense?worldId=${W}&tileKey=base`, { headers: auth });
    expect(get.status).toBe(200);
    const body = await get.json() as { ok: boolean; data: typeof config };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(config);

    const bad = await fetch(`${base}/world/defense`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(400);

    const nf = await fetch(`${base}/world/nope`, { headers: auth });
    expect(nf.status).toBe(404);
  });

  it('POST /world/build/upgrade accepts P2 buildings (wall/academy, SLG_CITY_DESIGN P2 closed 2026-06-30)', async () => {
    // Separate accounts per key: the build queue only holds BUILD_QUEUE_SLOTS(1), so reusing
    // acct-1 across both upgrades in this single-queue-slot setup would 400 the second call regardless of the fix.
    for (const key of ['wall', 'academy']) {
      const acctId = `acct-p2-${key}`;
      const acctToken = signToken(acctId, { secret: SECRET });
      const acctAuth = { authorization: `Bearer ${acctToken}` };
      await fetch(`${base}/world/join`, {
        method: 'POST',
        headers: { ...acctAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W }),
      });
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, acctId) },
        { $set: { resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 } } },
      );
      const r = await fetch(`${base}/world/build/upgrade`, {
        method: 'POST',
        headers: { ...acctAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W, key }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.data.buildQueue.some((q: { key: string }) => q.key === key)).toBe(true);
    }
  });

  it('POST /world/build/upgrade rejects an unknown building key → 400', async () => {
    const r = await fetch(`${base}/world/build/upgrade`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, key: 'notARealBuilding' }),
    });
    expect(r.status).toBe(400);
  });

  it('sweep endpoint (S8-3): missing coordinates → 400', async () => {
    const sweep = await fetch(`${base}/world/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, troops: 500 }),
    });
    expect(sweep.status).toBe(400);
  });

  // Regression (2026-07-18, account tao1): GET /nation/channel returned a real HTTP 403 for an
  // account that had never settled a base in this world (no playerWorld record) — world chat is
  // a shard-scoped social channel, not gated on SLG-map settlement (see nation-channel.e2e.test.ts
  // for the service-level coverage of the same fix).
  describe('nation/world public channel (§6.4): no playerWorld record required', () => {
    const freshToken = signToken('acct-never-joined', { secret: SECRET });
    const freshAuth = { authorization: `Bearer ${freshToken}` };

    it('GET /nation/channel: 200 (not 403) for an account with no playerWorld record', async () => {
      const r = await fetch(`${base}/nation/channel?worldId=${W}`, { headers: freshAuth });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('POST /nation/message: 200 (not 403) for an account with no playerWorld record', async () => {
      const r = await fetch(`${base}/nation/message`, {
        method: 'POST',
        headers: { ...freshAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W, body: 'hi, never joined the SLG map' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.data.body).toBe('hi, never joined the SLG map');

      const history = await fetch(`${base}/nation/channel?worldId=${W}`, { headers: freshAuth });
      const historyBody = await history.json();
      expect(historyBody.data.some((msg: { body: string }) => msg.body === 'hi, never joined the SLG map')).toBe(true);
    });

    it('GET /nation/channel missing worldId → 400', async () => {
      const r = await fetch(`${base}/nation/channel`, { headers: freshAuth });
      expect(r.status).toBe(400);
    });
  });

  // Regression (2026-08-03 worldsvc code review, finding #1): GET /world/active-season is reachable with
  // zero credentials and had no try/catch — an uncaught rejection there would be an unhandled promise
  // rejection, which terminates the whole Node process on Node >=15 (not just this one request).
  describe('regression: GET /world/active-season never crashes the process on a service error', () => {
    it('a thrown error from the service is caught and answered with 500, not an unhandled rejection', async () => {
      const original = svcRef.getActiveSeasonNo;
      svcRef.getActiveSeasonNo = async () => { throw new Error('simulated transient failure'); };
      try {
        const r = await fetch(`${base}/world/active-season`);
        expect(r.status).toBe(500);
        const bodyJson = await r.json();
        expect(bodyJson.ok).toBe(false);
      } finally {
        svcRef.getActiveSeasonNo = original;
      }
      // The server process must still be alive and serving requests afterward — this is the actual point
      // of the fix (an unhandled rejection here would have brought down the whole process, not just
      // failed this one request).
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
    });
  });

  // Regression (2026-08-03 worldsvc code review, finding #6): readJson's 1MB cap only rejected the
  // promise but kept consuming incoming chunks — a caller could force unbounded memory growth by just
  // continuing to send data past the nominal cap. Fixed by req.destroy()-ing the connection on overflow.
  describe('regression: readJson enforces its 1MB payload cap by tearing down the connection', () => {
    it('an oversized POST body does not get processed, and the connection is torn down rather than accepted', async () => {
      const oversized = JSON.stringify({ worldId: W, junk: 'x'.repeat(2 * 1024 * 1024) }); // > 1MB
      // req.destroy() tears down the shared socket, so the client observes a network-level failure
      // (connection reset), not a clean HTTP response — that's the actual enforcement, not just a 4xx.
      await expect(fetch(`${base}/world/join`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: oversized,
      })).rejects.toThrow();

      // The server itself must stay healthy and keep serving other requests afterward.
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
    });
  });

  // Regression (2026-08-03 worldsvc code review, finding #16): /sect/message and /nation/message trusted
  // the client-supplied senderName verbatim whenever meta is unreachable (this suite's svc has no meta
  // configured, so every call here is in that degraded window) — a malicious client could put arbitrary
  // control characters / an overlong string into a name broadcast to a whole chat channel.
  describe('regression: senderName fallback is sanitized in degraded (meta-unavailable) mode', () => {
    it('POST /nation/message strips control characters and caps the client-supplied senderName length', async () => {
      const maliciousName = `Evil\x00\x1bName${'X'.repeat(100)}`;
      const r = await fetch(`${base}/nation/message`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W, body: 'sanitize-check', senderName: maliciousName }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      const sanitized = body.data.senderName as string;
      expect(sanitized).not.toContain('\x00');
      expect(sanitized).not.toContain('\x1b');
      expect(sanitized.length).toBeLessThanOrEqual(24); // MAX_DISPLAY_NAME_LEN
    });
  });
});
