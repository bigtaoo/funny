// worldsvc public REST end-to-end (S8-0/S8-1): real node:http server + global fetch calls (curl equivalent).
//   • /health requires no authentication; missing token → 401;
//   • GET /world/map, /world/me, /world/tile/{id} (procedural + player state);
//   • POST /world/join, /world/occupy (real database writes);
//   • unimplemented write endpoints → 501; unknown routes → 404.
// Service requires real Mongo (dedicated database); entire suite skipped if Mongo is unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, proceduralTile, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
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
    server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET }, svc);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  it('POST /world/occupy → territory mine', async () => {
    const res = findResource();
    const r = await fetch(`${base}/world/occupy`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, x: res.x, y: res.y }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ type: 'territory', mine: true });
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
    // the base footprint (not 4-directionally adjacent) — border it first via /world/occupy (test-only instant
    // occupy, ADR-037) so the march clears the new gate. Try all 4 neighbors; skip obstacle/center/inside-footprint.
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = free.x + dx, ny = free.y + dy;
      if (Math.abs(nx - baseX) <= 1 && Math.abs(ny - baseY) <= 1) continue; // inside the 3×3 base footprint
      const t = proceduralTile(W, nx, ny).type;
      if (t !== 'resource' && t !== 'neutral') continue;
      const cr = await fetch(`${base}/world/occupy`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: W, x: nx, y: ny }),
      });
      if (cr.status === 200) break;
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

  it('sweep endpoint (S8-3): missing coordinates → 400', async () => {
    const sweep = await fetch(`${base}/world/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, troops: 500 }),
    });
    expect(sweep.status).toBe(400);
  });
});
