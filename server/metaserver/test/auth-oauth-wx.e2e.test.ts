// Wire-level coverage for POST /auth/wx, /auth/oauth, /auth/bind (SA-2) — backfilled 2026-08-10
// after the accounts.ts split (file-organization-conventions memory, "sixth pass") made it easy to
// grep each split-out function's real callers by name and notice these three routes had ZERO
// app.inject coverage anywhere in metaserver/test: accounts-race.e2e.test.ts calls
// resolveByOAuth/bindOAuth directly at the service layer (imported from ../dist/accounts.js), never
// through the actual HTTP route + auth.ts handler that a real client hits — same "method name in a
// test is not the same claim as the route being covered" lesson as the familyService.ts/
// friendService.ts httpApi splits (see claudedocs/server.md's "单文件 500 行收敛" section).
//
// Requires a real single-node Mongo replica set: provided in-process by
// metaserver/test/globalSetup.ts (mongodb-memory-server) — no Docker needed. Entire suite is
// skipped if Mongo is unreachable. Imports from build output dist; requires `tsc -b` before running.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_auth_oauth_wx_test';
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
  console.warn(`[auth-oauth-wx.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const ORIGINAL_GOOGLE_ID = process.env.NW_OAUTH_GOOGLE_CLIENT_ID;
const ORIGINAL_GOOGLE_SECRET = process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET;

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stub global.fetch for the two calls exchangeGoogle makes (token, then userinfo), keyed by URL. */
function mockGoogleFetch(sub: string, email = 'x@example.com') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return jsonResp({ access_token: 'fake-access-token' });
      }
      if (String(url).includes('googleapis.com/oauth2/v3/userinfo')) {
        return jsonResp({ sub, email });
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    }),
  );
}

describe.skipIf(!mongo)('metaserver auth oauth/wx/bind e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NW_OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET;
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env.NW_OAUTH_GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_ID;
    process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = ORIGINAL_GOOGLE_SECRET;
    await m.db.dropDatabase();
    await m.close();
  });

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  // ── POST /auth/wx ─────────────────────────────────────────────────────────

  describe('POST /auth/wx', () => {
    it('dev-mode code (no NW_WX_APPID/SECRET) resolves to a new NON-anonymous account (WeChat is a recoverable credential), then to the same account on repeat', async () => {
      const first = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wxcode-1' } });
      expect(first.statusCode).toBe(200);
      const d1 = body(first).data;
      expect(d1.token).toBeTruthy();
      expect(d1.isNew).toBe(true);
      expect(d1.isAnonymous).toBe(false);
      expect(d1.publicId).toMatch(/^\d{9}$/);

      const second = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wxcode-1' } });
      expect(second.statusCode).toBe(200);
      const d2 = body(second).data;
      expect(d2.accountId).toBe(d1.accountId);
      expect(d2.isNew).toBe(false);
    });

    it('different codes resolve to different accounts', async () => {
      const a = body(await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wxcode-a' } })).data;
      const b = body(await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wxcode-b' } })).data;
      expect(a.accountId).not.toBe(b.accountId);
    });
  });

  // ── POST /auth/oauth ─────────────────────────────────────────────────────

  describe('POST /auth/oauth', () => {
    it('unconfigured provider → 400 OAUTH_FAILED (no NW_OAUTH_GOOGLE_CLIENT_ID/SECRET set)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'authcode-1', redirectUri: 'https://example.com/cb' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('OAUTH_FAILED');
    });

    it('provider outside the openapi enum → 400 at the schema-validation layer (never reaches the oauth.supports() runtime check)', async () => {
      process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'id';
      process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
      const r = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'facebook', code: 'authcode-1', redirectUri: 'https://example.com/cb' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
    });

    it('configured Google provider: valid code resolves to a new non-anonymous account, then to the same account on repeat', async () => {
      process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'id';
      process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
      mockGoogleFetch('google-sub-1');

      const first = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'authcode-1', redirectUri: 'https://example.com/cb' },
      });
      expect(first.statusCode).toBe(200);
      const d1 = body(first).data;
      expect(d1.token).toBeTruthy();
      expect(d1.isNew).toBe(true);
      expect(d1.isAnonymous).toBe(false);

      const second = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'authcode-2', redirectUri: 'https://example.com/cb' },
      });
      expect(second.statusCode).toBe(200);
      const d2 = body(second).data;
      expect(d2.accountId).toBe(d1.accountId);
      expect(d2.isNew).toBe(false);
    });

    it('Google token exchange failure (invalid code) → 400 OAUTH_FAILED', async () => {
      process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'id';
      process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
      vi.stubGlobal('fetch', vi.fn(async () => jsonResp({ error: 'invalid_grant' }, 400)));

      const r = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'bad-code', redirectUri: 'https://example.com/cb' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('OAUTH_FAILED');
    });
  });

  // ── POST /auth/bind ──────────────────────────────────────────────────────

  describe('POST /auth/bind', () => {
    async function deviceLogin(deviceId: string): Promise<{ token: string; accountId: string }> {
      const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
      return body(r).data;
    }

    it('method=password: binds a password credential to an existing device account; that credential then logs in to the SAME account', async () => {
      const { token, accountId } = await deviceLogin('bind-device-1');
      const bind = await app.inject({
        method: 'POST',
        url: '/auth/bind',
        headers: { authorization: `Bearer ${token}` },
        payload: { method: 'password', loginId: 'bound-user-1', password: 'secret123' },
      });
      expect(bind.statusCode).toBe(200);
      expect(body(bind).data.isAnonymous).toBe(false);

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { loginId: 'bound-user-1', password: 'secret123' },
      });
      expect(login.statusCode).toBe(200);
      expect(body(login).data.accountId).toBe(accountId);
    });

    it('method=password: loginId already taken by another account → 409 LOGIN_ID_TAKEN', async () => {
      await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'taken-user', password: 'secret123' } });
      const { token } = await deviceLogin('bind-device-2');
      const bind = await app.inject({
        method: 'POST',
        url: '/auth/bind',
        headers: { authorization: `Bearer ${token}` },
        payload: { method: 'password', loginId: 'taken-user', password: 'other123' },
      });
      expect(bind.statusCode).toBe(409);
      expect(body(bind).error.code).toBe('LOGIN_ID_TAKEN');
    });

    it('method=oauth: binds a Google credential to an existing device account (config + fetch mocked)', async () => {
      process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'id';
      process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
      mockGoogleFetch('google-sub-bind-1');

      const { token, accountId } = await deviceLogin('bind-device-3');
      const bind = await app.inject({
        method: 'POST',
        url: '/auth/bind',
        headers: { authorization: `Bearer ${token}` },
        payload: { method: 'oauth', provider: 'google', code: 'authcode-1', redirectUri: 'https://example.com/cb' },
      });
      expect(bind.statusCode).toBe(200);
      expect(body(bind).data.isAnonymous).toBe(false);

      // The bound credential now logs a fresh (unauthenticated) OAuth attempt back into the SAME account.
      const oauthLogin = await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'authcode-2', redirectUri: 'https://example.com/cb' },
      });
      expect(oauthLogin.statusCode).toBe(200);
      expect(body(oauthLogin).data.accountId).toBe(accountId);
    });

    it('method=oauth: credential already bound to a DIFFERENT account → 409 ALREADY_BOUND', async () => {
      process.env.NW_OAUTH_GOOGLE_CLIENT_ID = 'id';
      process.env.NW_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
      mockGoogleFetch('google-sub-conflict');

      // First account claims the credential via a plain OAuth login.
      await app.inject({
        method: 'POST',
        url: '/auth/oauth',
        payload: { provider: 'google', code: 'authcode-1', redirectUri: 'https://example.com/cb' },
      });

      // A second, different account tries to bind the SAME credential.
      const { token } = await deviceLogin('bind-device-4');
      const bind = await app.inject({
        method: 'POST',
        url: '/auth/bind',
        headers: { authorization: `Bearer ${token}` },
        payload: { method: 'oauth', provider: 'google', code: 'authcode-2', redirectUri: 'https://example.com/cb' },
      });
      expect(bind.statusCode).toBe(409);
      expect(body(bind).error.code).toBe('ALREADY_BOUND');
    });

    it('unknown method → 400 BAD_REQUEST', async () => {
      const { token } = await deviceLogin('bind-device-5');
      const r = await app.inject({
        method: 'POST',
        url: '/auth/bind',
        headers: { authorization: `Bearer ${token}` },
        payload: { method: 'carrier-pigeon' },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
    });
  });
});
