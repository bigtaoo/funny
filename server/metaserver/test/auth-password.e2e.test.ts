// Password account end-to-end tests (SA-1 acceptance): register → login → change password → loginId taken / invalid credentials.
// Requires a real single-node Mongo replica set: `cd server && docker compose up -d`. Entire suite is skipped if Mongo is unreachable.
// Imports from build output dist; requires `tsc -b` before running.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import * as shared from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

// `@nw/shared`'s dist build is genuine ESM (non-configurable named exports), so vi.spyOn on the
// namespace object throws "Cannot redefine property" — wrap verifyPassword in a vi.fn via a module
// factory instead (accounts.ts's own `import { verifyPassword } from '@nw/shared'` resolves through
// this mock since it's applied at the module-resolution layer, before accounts.ts's import runs).
vi.mock('@nw/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nw/shared')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

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

  it('registration succeeds: returns token + isNew + isAnonymous=false + displayName', async () => {
    const r = await register('Alice@Example.com', 'secret123', 'Alice');
    expect(r.statusCode).toBe(200);
    const d = body(r).data;
    expect(d.token).toBeTruthy();
    expect(d.isNew).toBe(true);
    expect(d.isAnonymous).toBe(false);
    expect(d.displayName).toBe('Alice');
  });

  it('login restores displayName set at registration', async () => {
    await register('frank@example.com', 'secret123', 'Frank');
    const r = await login('FRANK@EXAMPLE.COM', 'secret123');
    expect(r.statusCode).toBe(200);
    expect(body(r).data.displayName).toBe('Frank');
  });

  it('loginId is case/whitespace insensitive, duplicate registration → 409 LOGIN_ID_TAKEN', async () => {
    await register('bob', 'secret123');
    const dup = await register('  BOB ', 'other123');
    expect(dup.statusCode).toBe(409);
    expect(body(dup).error.code).toBe('LOGIN_ID_TAKEN');
  });

  it('weak password → 400 WEAK_PASSWORD', async () => {
    const r = await register('carol', '123');
    expect(r.statusCode).toBe(400);
    expect(body(r).error.code).toBe('WEAK_PASSWORD');
  });

  it('login: correct password succeeds (same accountId), wrong password → 401 INVALID_CREDENTIALS', async () => {
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

  it('regression (2026-08-03 fix): a not-found loginId still pays the scrypt verify cost, closing the timing side-channel', async () => {
    // Root cause: loginWithPassword used to return immediately when the loginId didn't exist, but
    // awaited a full scrypt comparison when it existed with a wrong password — a measurable timing
    // difference that let an attacker distinguish "no such account" from "wrong password" even though
    // both return an identical INVALID_CREDENTIALS body. Fixed by always calling verifyPassword against
    // a fixed DUMMY_PASSWORD_HASH on the not-found path, so both branches pay the same scrypt cost.
    await register('henry', 'secret123');
    const spy = shared.verifyPassword as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const missing = await login('no-such-loginid-at-all', 'whatever123');
    expect(missing.statusCode).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(shared.DUMMY_PASSWORD_HASH);

    spy.mockClear();
    const wrongPassword = await login('henry', 'not-the-real-password');
    expect(wrongPassword.statusCode).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).not.toBe(shared.DUMMY_PASSWORD_HASH); // compared against the real stored hash
  });

  it('change password: after old password verified, new password can be used to login', async () => {
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

  it('change password requires login: no token → 401', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      payload: { oldPassword: 'x', newPassword: 'newpass1' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('device account isAnonymous=true', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device',
      payload: { deviceId: 'device-anon-1' },
    });
    expect(body(r).data.isAnonymous).toBe(true);
  });

  it('ban takes effect on the very next login (accountCache.ts invalidation, not a stale-allow window): admin ban -> immediate 403, admin unban -> immediate 200 again', async () => {
    const { accountId } = body(await register('gina', 'secret123')).data;
    const banHeaders = { 'x-internal-key': 'test-internal-key' };

    // rejectIfBanned's cache is populated by the registration call above (it also gates auth). A stale
    // cache would let this login through for up to BAN_STATUS_TTL_MS after the ban — asserting "immediate"
    // here is the point: it must be invalidated on write, not merely eventually consistent.
    const banRes = await app.inject({ method: 'POST', url: `/internal/accounts/${accountId}/ban`, headers: banHeaders });
    expect(banRes.statusCode).toBe(200);

    const bannedLogin = await login('gina', 'secret123');
    expect(bannedLogin.statusCode).toBe(403);
    expect(body(bannedLogin).error.code).toBe('ACCOUNT_BANNED');

    const unbanRes = await app.inject({ method: 'POST', url: `/internal/accounts/${accountId}/unban`, headers: banHeaders });
    expect(unbanRes.statusCode).toBe(200);

    const restoredLogin = await login('gina', 'secret123');
    expect(restoredLogin.statusCode).toBe(200);
  });
});
