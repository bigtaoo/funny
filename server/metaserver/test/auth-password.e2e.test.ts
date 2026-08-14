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
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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

  it('C5-b: deletedAt AND flags.banned both set on the same account → rejectIfBanned reports deleted (410), not banned (403)', async () => {
    const { accountId, token } = body(await register('iris', 'secret123')).data;
    const auth = { authorization: `Bearer ${token}` };

    // Soft-delete first (deleteAccount doesn't itself check rejectIfBanned), then also ban the same
    // account via the internal admin endpoint — real production code paths for setting each flag,
    // landing both on one account doc.
    const delRes = await app.inject({ method: 'DELETE', url: '/account', headers: auth });
    expect(delRes.statusCode).toBe(200);

    const banRes = await app.inject({
      method: 'POST',
      url: `/internal/accounts/${accountId}/ban`,
      headers: { 'x-internal-key': 'test-internal-key' },
    });
    expect(banRes.statusCode).toBe(200);

    // Probe via /pve/clear (still holding the pre-deletion token), not login: login now runs
    // restoreIfWithinGrace *before* rejectIfBanned (2026-08-10 fix), which would clear deletedAt here
    // and turn this into a pure ban-only check — /pve/clear only calls rejectIfBanned, never restores,
    // so it still exercises the "both flags set" ordering this test is actually about.
    const probe = await app.inject({
      method: 'POST', url: '/pve/clear', headers: auth,
      payload: { levelId: 'ch1_lv1', stars: 1 },
    });
    // rejectIfBanned (service/base.ts) checks status.deletedAt before status.banned — with both flags
    // set, the response must be 410 ACCOUNT_DELETED, never 403 ACCOUNT_BANNED.
    expect(probe.statusCode).toBe(410);
    expect(body(probe).error.code).toBe('ACCOUNT_DELETED');
  });

  it('C5-b (2026-08-10 fix): logging back in within the 7-day grace period restores a soft-deleted account instead of 410ing forever', async () => {
    const { accountId } = body(await register('juno', 'secret123')).data;
    const delRes = await app.inject({
      method: 'DELETE', url: '/account',
      headers: { authorization: `Bearer ${body(await login('juno', 'secret123')).data.token}` },
    });
    expect(delRes.statusCode).toBe(200);

    // Immediately after deletion, login used to 410 forever (rejectIfBanned ran before signToken, and
    // the only undo — POST /account/cancel-deletion — itself requires a bearer token, which a deleted
    // account can never obtain). It must now succeed and hand back a working token.
    const restoredLogin = await login('juno', 'secret123');
    expect(restoredLogin.statusCode).toBe(200);
    const { token: restoredToken, accountId: restoredId } = body(restoredLogin).data;
    expect(restoredId).toBe(accountId);
    expect(typeof restoredToken).toBe('string');

    // deletedAt/deletionConfirmToken are actually cleared, not just bypassed for this one request.
    const doc = await m.collections.accounts.findOne({ _id: accountId });
    expect(doc?.deletedAt).toBeUndefined();
    expect(doc?.deletionConfirmToken).toBeUndefined();

    // And the restored token works for a normal authenticated call.
    const saveRes = await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${restoredToken}` } });
    expect(saveRes.statusCode).toBe(200);
  });

  it('C5-b (2026-08-10 fix): login past the 7-day grace period still 410s — restore is grace-window-only', async () => {
    const { accountId } = body(await register('kara', 'secret123')).data;
    const loginToken = body(await login('kara', 'secret123')).data.token;
    const delRes = await app.inject({
      method: 'DELETE', url: '/account', headers: { authorization: `Bearer ${loginToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    // Back-date deletedAt past the grace window directly (fast-forwarding real wall-clock time isn't
    // practical in an e2e test) — same technique as account-deletion.test.ts's expired-grace case.
    const graceMs = 7 * 24 * 60 * 60 * 1000;
    await m.collections.accounts.updateOne(
      { _id: accountId },
      { $set: { deletedAt: Date.now() - graceMs - 1000 } },
    );

    const expiredLogin = await login('kara', 'secret123');
    expect(expiredLogin.statusCode).toBe(410);
    expect(body(expiredLogin).error.code).toBe('ACCOUNT_DELETED');
  });
});
