// Password account end-to-end tests (SA-1 acceptance): register → login → change password → loginId taken / invalid credentials.
// Requires a real single-node Mongo replica set: `cd server && docker compose up -d`. Entire suite is skipped if Mongo is unreachable.
// Imports from build output dist; requires `tsc -b` before running.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_auth_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[auth-password.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

describe.skipIf(!mongo)('metaserver auth password e2e', () => {
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

  function register(loginId: string, password: string, displayName?: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { loginId, password, ...(displayName ? { displayName } : {}) },
    });
  }
  function login(loginId: string, password: string) {
    return app.inject({ method: 'POST', url: '/auth/login', payload: { loginId, password } });
  }

  it('注册成功：返回 token + isNew + isAnonymous=false + displayName', async () => {
    const r = await register('Alice@Example.com', 'secret123', 'Alice');
    expect(r.statusCode).toBe(200);
    const d = body(r).data;
    expect(d.token).toBeTruthy();
    expect(d.isNew).toBe(true);
    expect(d.isAnonymous).toBe(false);
    expect(d.displayName).toBe('Alice');
  });

  it('登录恢复注册时填的 displayName', async () => {
    await register('frank@example.com', 'secret123', 'Frank');
    const r = await login('FRANK@EXAMPLE.COM', 'secret123');
    expect(r.statusCode).toBe(200);
    expect(body(r).data.displayName).toBe('Frank');
  });

  it('loginId 大小写/空格不敏感，重复注册 → 409 LOGIN_ID_TAKEN', async () => {
    await register('bob', 'secret123');
    const dup = await register('  BOB ', 'other123');
    expect(dup.statusCode).toBe(409);
    expect(body(dup).error.code).toBe('LOGIN_ID_TAKEN');
  });

  it('弱密码 → 400 WEAK_PASSWORD', async () => {
    const r = await register('carol', '123');
    expect(r.statusCode).toBe(400);
    expect(body(r).error.code).toBe('WEAK_PASSWORD');
  });

  it('登录：正确密码成功（同 accountId），错误密码 → 401 INVALID_CREDENTIALS', async () => {
    const reg = body(await register('dave', 'secret123')).data;
    const okLogin = await login('DAVE', 'secret123');
    expect(okLogin.statusCode).toBe(200);
    expect(body(okLogin).data.accountId).toBe(reg.accountId);

    const bad = await login('dave', 'wrongpass');
    expect(bad.statusCode).toBe(401);
    expect(body(bad).error.code).toBe('INVALID_CREDENTIALS');

    const missing = await login('nobody', 'secret123');
    expect(missing.statusCode).toBe(401);
    expect(body(missing).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('改密：旧密码校验通过后可用新密码登录', async () => {
    const { token } = body(await register('erin', 'oldpass1')).data;
    const auth = { authorization: `Bearer ${token}` };

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: auth,
      payload: { oldPassword: 'wrong', newPassword: 'newpass1' },
    });
    expect(bad.statusCode).toBe(401);

    const okChange = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: auth,
      payload: { oldPassword: 'oldpass1', newPassword: 'newpass1' },
    });
    expect(okChange.statusCode).toBe(200);

    expect((await login('erin', 'oldpass1')).statusCode).toBe(401);
    expect((await login('erin', 'newpass1')).statusCode).toBe(200);
  });

  it('改密需登录：无 token → 401', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      payload: { oldPassword: 'x', newPassword: 'newpass1' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('device 账号 isAnonymous=true', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device',
      payload: { deviceId: 'device-anon-1' },
    });
    expect(body(r).data.isAnonymous).toBe(true);
  });
});
