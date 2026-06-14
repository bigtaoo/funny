// save-service 端到端（S0-7 验收）：auth → JWT → GET/PUT save → 乐观锁 409 → 并发 → 硬墙。
// 需真实 Mongo 单节点副本集：`cd server && docker compose up -d`。
// Mongo 不可达时整套 skip（不阻塞无 DB 环境的 CI），并打印提示。
// 导入构建产物 dist（NodeNext 的 .js 扩展名在 vitest 源解析下不便），跑前需 `tsc -b`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_test';
const jwt: JwtConfig = { secret: 'test-secret' };

// 短超时探测：不可达就 skip 整套。
async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[save.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('metaserver save-service e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  async function authDevice(deviceId: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return body(r).data as { token: string; accountId: string; isNew: boolean };
  }

  it('auth/device：首次 isNew，同 deviceId 稳定返回同 accountId', async () => {
    const a1 = await authDevice('device-1');
    expect(a1.token).toBeTruthy();
    expect(a1.isNew).toBe(true);
    const a2 = await authDevice('device-1');
    expect(a2.accountId).toBe(a1.accountId);
    expect(a2.isNew).toBe(false);
  });

  it('GET /save 无 token → 401 UNAUTHENTICATED', async () => {
    const r = await app.inject({ method: 'GET', url: '/save' });
    expect(r.statusCode).toBe(401);
    expect(body(r).error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /save 带 token → 自动建新档 rev 0，coins 0', async () => {
    const { token, accountId } = await authDevice('device-2');
    const r = await app.inject({
      method: 'GET',
      url: '/save',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const save = body(r).data.save;
    expect(save.rev).toBe(0);
    expect(save.accountId).toBe(accountId);
    expect(save.wallet.coins).toBe(0);
  });

  it('PUT /save 乐观锁：If-Match 命中写入 rev+1，过期 rev → 409 + 当前云端值', async () => {
    const { token } = await authDevice('device-3');
    const auth = { authorization: `Bearer ${token}` };

    const ok = await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '0' },
      payload: { save: { flags: { seenIntro: true }, materials: { wood: 5 } } },
    });
    expect(ok.statusCode).toBe(200);
    const saved = body(ok).data.save;
    expect(saved.rev).toBe(1);
    expect(saved.flags.seenIntro).toBe(true);
    expect(saved.materials.wood).toBe(5);

    const stale = await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '0' },
      payload: { save: { flags: { x: true } } },
    });
    expect(stale.statusCode).toBe(409);
    const c = body(stale);
    expect(c.error.code).toBe('REV_CONFLICT');
    expect(c.save.rev).toBe(1);
  });

  it('并发两个同 rev PUT → 恰一个 200、一个 409', async () => {
    const { token } = await authDevice('device-4');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '0' },
      payload: { save: { flags: { init: true } } },
    });
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/save',
        headers: { ...auth, 'if-match': '1' },
        payload: { save: { flags: { a: true } } },
      }),
      app.inject({
        method: 'PUT',
        url: '/save',
        headers: { ...auth, 'if-match': '1' },
        payload: { save: { flags: { b: true } } },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('硬墙：PUT 携带权威段（wallet）被忽略，coins 仍 0', async () => {
    const { token } = await authDevice('device-5');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '0' },
      // SyncPatch 不含 wallet 字段 → 即便客户端塞入也不落库
      payload: { save: { flags: { c: true }, wallet: { coins: 999999 } } },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/save',
      headers: auth,
    });
    expect(body(r).data.save.wallet.coins).toBe(0);
  });
});
