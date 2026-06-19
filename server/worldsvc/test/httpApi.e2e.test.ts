// worldsvc 公网 REST 端到端（S8-0/S8-1）：真实 node:http 起服务 + 全局 fetch 打（curl 等价）。
//   • /health 无需鉴权；无 token → 401；
//   • GET /world/map、/world/me、/world/tile/{id}（程序化 + 玩家状态）；
//   • POST /world/join、/world/occupy（写库做实）；
//   • 未实现写端点 → 501；未知路由 → 404。
// service 需真实 Mongo（专属库）；Mongo 不可达整套 skip。
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
if (!mongo) console.warn(`[worldsvc.httpApi.e2e] Mongo 不可达（${URI}）— 跳过。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** 找一个资源格（远离主城）。 */
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

/** 找一个可占领空闲格（非中心、非主城(5,5)）。 */
function findFreeNear(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (x === 5 && y === 5) continue;
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

  it('GET /health 无需鉴权', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: 'worldsvc' });
  });

  it('无 token → 401', async () => {
    const r = await fetch(`${base}/world/map?worldId=${W}&cx=10&cy=10&r=2`);
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /world/map：程序化视区 + 中心唯一', async () => {
    const r = await fetch(`${base}/world/map?worldId=${W}&cx=${CENTER_X}&cy=${CENTER_Y}&r=2`, {
      headers: auth,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.data.tiles).toHaveLength(25);
    expect(body.data.tiles.filter((tl: { type: string }) => tl.type === 'center')).toHaveLength(1);
  });

  it('POST /world/join → /world/me joined, /world/tile base', async () => {
    const jr = await fetch(`${base}/world/join`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, x: 5, y: 5 }),
    });
    expect(jr.status).toBe(200);
    expect((await jr.json()).data).toMatchObject({ joined: true, mainBaseTile: `${W}:5:5` });

    const me = await fetch(`${base}/world/me?worldId=${W}`, { headers: auth });
    expect((await me.json()).data.joined).toBe(true);

    const tile = await fetch(`${base}/world/tile/${encodeURIComponent(`${W}:5:5`)}`, {
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

  it('POST /world/join 缺 worldId → 400', async () => {
    const r = await fetch(`${base}/world/join`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1, y: 1 }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /world/march → occupy 行军（marching）', async () => {
    // acct-1 已在 (5,5) 落城；向相邻空闲格发占领行军。
    const free = findFreeNear(6, 6);
    const r = await fetch(`${base}/world/march`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        worldId: W,
        fromX: 5,
        fromY: 5,
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

  it('POST /world/march 缺坐标 → 400', async () => {
    const r = await fetch(`${base}/world/march`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, kind: 'occupy', troops: 500 }),
    });
    expect(r.status).toBe(400);
  });

  it('防守 config（C3）：PUT 主城防守 → GET 取回；缺 worldId → 400；未知路由 → 404', async () => {
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

  it('扫荡端点（S8-3）：缺坐标 → 400', async () => {
    const sweep = await fetch(`${base}/world/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: W, troops: 500 }),
    });
    expect(sweep.status).toBe(400);
  });
});
