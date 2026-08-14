// Unit coverage for src/service/auth/oauthBind.ts (authOAuthHandler/authBindHandler), backfilled
// 2026-08-13 (same vitest-v8-coverage-attribution rationale as auth-credential-unit.test.ts's header).
//
// Calls the handler functions DIRECTLY (not via buildApp + app.inject) — two reasons:
//  1. AuthService builds its own OAuthService from process env in its constructor
//     (`private readonly oauth = createOAuthService()`, see src/service/auth.ts) with no injection
//     point through BuildAppOpts, so exercising a real network exchange from the HTTP layer means
//     mocking global fetch + toggling env vars — already done thoroughly by
//     test/auth-oauth-wx.e2e.test.ts (dist-only, doesn't count toward src coverage, but the scenarios
//     don't need reinventing). Building `ctx.oauth` by hand instead lets every exchangeCode outcome
//     (unsupported provider / OAuthError / a generic thrown Error / success) be driven directly, with
//     no network and no env var juggling.
//  2. The openapi schema for POST /auth/bind restricts `method` to the enum ["oauth","password"] —
//     so authBindHandler's own `unknown bind method` 400 branch (the function's last line) is
//     UNREACHABLE from the HTTP surface: an out-of-enum method is rejected by Fastify's AJV validation
//     before the handler ever runs (confirmed by reading routes.gen.ts's authBind body schema).
//     A direct call bypasses that schema entirely, so this branch can actually execute.
import { describe, it, expect } from 'vitest';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authOAuthHandler, authBindHandler, type OAuthCtx } from '../src/service/auth/oauthBind.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { OAuthError, type OAuthService } from '../src/oauth.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const FIXED_TS = 1_700_000_000_000;
const ACCOUNT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

interface AccountSeed {
  _id: string;
  createdAt?: number;
  oauth?: { provider: string; sub: string }[];
  password?: { loginId: string; hash: string };
  displayName?: string;
  deletedAt?: number;
  deletionConfirmToken?: string;
  flags?: { banned?: boolean; bannedUntil?: number };
}

function fakeCols(opts: { accounts?: AccountSeed[] } = {}): Collections {
  const accounts = new FakeCollection<AccountSeed & { _id: string }>();
  if (opts.accounts) accounts.seed(...opts.accounts);
  const saves = new FakeCollection<{ _id: string; save: SaveData; rev: number }>();
  const cardInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  return { accounts, saves, cardInstances } as unknown as Collections;
}

function makeDeps(cols: Collections): ServiceDeps {
  return {
    cols,
    jwt,
    now: () => FIXED_TS,
    commercial: fakeCommercial(),
    gatewayPublicUrl: null,
    gateway: fakeGateway(),
    authRateLimit: 0,
    flags: null,
    wordlists: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: null,
    redis: null,
    accountCache: new AccountCache(),
  };
}

/** Hand-built OAuthService double: supports()/exchangeCode() behavior fully controlled by the test, no network. */
function fakeOauth(opts: { supports?: boolean; sub?: string; throwError?: unknown } = {}): OAuthService {
  return {
    supports: () => opts.supports ?? true,
    exchangeCode: async () => {
      if (opts.throwError) throw opts.throwError;
      return { sub: opts.sub ?? 'sub-default' };
    },
  } as unknown as OAuthService;
}

function req(body: unknown, accountId?: string): FastifyRequest {
  return { body, headers: {}, accountId } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { _code: number; _body: unknown } {
  const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
  r.code = ((c: number) => { r._code = c; return r; }) as never;
  r.send = ((b: unknown) => { r._body = b; return r; }) as never;
  return r;
}

function ctxFor(cols: Collections, oauth: OAuthService, allow = true): OAuthCtx {
  return { core: new MetaCore(makeDeps(cols)), oauth, allowAuthAttempt: async () => allow };
}

// ── authOAuthHandler ─────────────────────────────────────────────────────────────────────────
describe('authOAuthHandler', () => {
  it('rate-limited (allowAuthAttempt=false) → 429 RATE_LIMITED', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeOauth(), false);
    const rep = reply();
    await authOAuthHandler(ctx, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), rep);
    expect(rep._code).toBe(429);
    expect((rep._body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('unsupported/unconfigured provider (oauth.supports()===false) → 400 OAUTH_FAILED', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeOauth({ supports: false }));
    const rep = reply();
    await authOAuthHandler(ctx, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { code: string } }).error.code).toBe('OAUTH_FAILED');
  });

  it('exchangeCode throws OAuthError → 400 OAUTH_FAILED, message forwarded verbatim', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeOauth({ throwError: new OAuthError('token exchange failed') }));
    const rep = reply();
    await authOAuthHandler(ctx, req({ provider: 'google', code: 'bad', redirectUri: 'https://x' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { code: string; message: string } }).error.message).toBe('token exchange failed');
  });

  it('exchangeCode throws a generic (non-OAuthError) Error → 400 OAUTH_FAILED, generic fallback message', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeOauth({ throwError: new Error('network blip') }));
    const rep = reply();
    await authOAuthHandler(ctx, req({ provider: 'google', code: 'bad', redirectUri: 'https://x' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { message: string } }).error.message).toBe('OAuth exchange failed');
  });

  it('success: new sub → new non-anonymous account, starter cards granted; repeat sub → same account, isNew=false', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeOauth({ sub: 'google-sub-1' }));
    const first = await authOAuthHandler(ctx, req({ provider: 'google', code: 'c1', redirectUri: 'https://x' }), reply()) as { data: Record<string, unknown> };
    expect(first.data.isNew).toBe(true);
    expect(first.data.isAnonymous).toBe(false);
    expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(3);

    const second = await authOAuthHandler(ctx, req({ provider: 'google', code: 'c2', redirectUri: 'https://x' }), reply()) as { data: Record<string, unknown> };
    expect(second.data.accountId).toBe(first.data.accountId);
    expect(second.data.isNew).toBe(false);
  });

  it('existing account with a displayName → included in the response', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'oa-1', oauth: [{ provider: 'google', sub: 'sub-named' }], displayName: 'Ola' }] });
    const ctx = ctxFor(cols, fakeOauth({ sub: 'sub-named' }));
    const r = await authOAuthHandler(ctx, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), reply()) as { data: Record<string, unknown> };
    expect(r.data.displayName).toBe('Ola');
  });

  it('banned account → 403 ACCOUNT_BANNED (rejectIfBanned)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'oa-2', oauth: [{ provider: 'google', sub: 'sub-banned' }], flags: { banned: true } }] });
    const ctx = ctxFor(cols, fakeOauth({ sub: 'sub-banned' }));
    const rep = reply();
    const result = await authOAuthHandler(ctx, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), rep);
    expect(result).toBeUndefined(); // handler returns early after reply.send(), no `ok()` payload
    expect(rep._code).toBe(403);
  });

  it('soft-deleted within grace → restored, login proceeds; past grace → 410 ACCOUNT_DELETED', async () => {
    const colsGrace = fakeCols({ accounts: [{ _id: 'oa-3', oauth: [{ provider: 'google', sub: 'sub-grace' }], deletedAt: FIXED_TS - 1000 }] });
    const ctxGrace = ctxFor(colsGrace, fakeOauth({ sub: 'sub-grace' }));
    const grace = await authOAuthHandler(ctxGrace, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), reply());
    expect((grace as { data: Record<string, unknown> }).data.accountId).toBe('oa-3');
    expect((await colsGrace.accounts.findOne({ _id: 'oa-3' }))?.deletedAt).toBeUndefined();

    const colsExpired = fakeCols({ accounts: [{ _id: 'oa-4', oauth: [{ provider: 'google', sub: 'sub-expired' }], deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1 }] });
    const ctxExpired = ctxFor(colsExpired, fakeOauth({ sub: 'sub-expired' }));
    const rep = reply();
    await authOAuthHandler(ctxExpired, req({ provider: 'google', code: 'c', redirectUri: 'https://x' }), rep);
    expect(rep._code).toBe(410);
    expect((rep._body as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
  });
});

// ── authBindHandler ──────────────────────────────────────────────────────────────────────────
describe('authBindHandler', () => {
  function seedAccount(id: string, extra: Partial<AccountSeed> = {}) {
    return fakeCols({ accounts: [{ _id: id, ...extra }] });
  }

  describe('method=oauth', () => {
    it('missing provider/code/redirectUri → 400 BAD_REQUEST', async () => {
      const cols = seedAccount('bind-1');
      const ctx = ctxFor(cols, fakeOauth());
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'oauth' }, 'bind-1'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    });

    it('unsupported provider → 400 OAUTH_FAILED', async () => {
      const cols = seedAccount('bind-2');
      const ctx = ctxFor(cols, fakeOauth({ supports: false }));
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'oauth', provider: 'google', code: 'c', redirectUri: 'https://x' }, 'bind-2'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { code: string } }).error.code).toBe('OAUTH_FAILED');
    });

    it('exchangeCode throws OAuthError → 400 OAUTH_FAILED with the OAuthError message', async () => {
      const cols = seedAccount('bind-3');
      const ctx = ctxFor(cols, fakeOauth({ throwError: new OAuthError('bad code') }));
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'oauth', provider: 'google', code: 'c', redirectUri: 'https://x' }, 'bind-3'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { message: string } }).error.message).toBe('bad code');
    });

    it('exchangeCode throws a generic Error → 400 OAUTH_FAILED with the generic fallback message', async () => {
      const cols = seedAccount('bind-4');
      const ctx = ctxFor(cols, fakeOauth({ throwError: new Error('boom') }));
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'oauth', provider: 'google', code: 'c', redirectUri: 'https://x' }, 'bind-4'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { message: string } }).error.message).toBe('OAuth exchange failed');
    });

    it('success: binds the credential, isAnonymous=false, account doc updated', async () => {
      const cols = seedAccount('bind-5');
      const ctx = ctxFor(cols, fakeOauth({ sub: 'sub-bind-5' }));
      const r = await authBindHandler(ctx, req({ method: 'oauth', provider: 'google', code: 'c', redirectUri: 'https://x' }, 'bind-5'), reply()) as { data: Record<string, unknown> };
      expect(r.data).toEqual({ ok: true, isAnonymous: false });
      const doc = await cols.accounts.findOne({ _id: 'bind-5' });
      expect(doc?.oauth).toEqual([{ provider: 'google', sub: 'sub-bind-5' }]);
    });

    it('credential already bound to a DIFFERENT account → 409 ALREADY_BOUND', async () => {
      const cols = fakeCols({
        accounts: [
          { _id: 'bind-owner', oauth: [{ provider: 'google', sub: 'sub-taken' }] },
          { _id: 'bind-6' },
        ],
      });
      const ctx = ctxFor(cols, fakeOauth({ sub: 'sub-taken' }));
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'oauth', provider: 'google', code: 'c', redirectUri: 'https://x' }, 'bind-6'), rep);
      expect(rep._code).toBe(409);
      expect((rep._body as { error: { code: string } }).error.code).toBe('ALREADY_BOUND');
    });
  });

  describe('method=password', () => {
    it('missing loginId/password → 400 BAD_REQUEST', async () => {
      const cols = seedAccount('bind-7');
      const ctx = ctxFor(cols, fakeOauth());
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'password' }, 'bind-7'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    });

    it('loginId too short (unreachable via HTTP: authBind\'s schema has no length bound on loginId, so this exercises validateLoginId directly) → 400 BAD_REQUEST', async () => {
      const cols = seedAccount('bind-8');
      const ctx = ctxFor(cols, fakeOauth());
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'password', loginId: 'ab', password: 'secret123' }, 'bind-8'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    });

    it('weak password → 400 WEAK_PASSWORD', async () => {
      const cols = seedAccount('bind-9');
      const ctx = ctxFor(cols, fakeOauth());
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'password', loginId: 'bind-user-9', password: '123' }, 'bind-9'), rep);
      expect(rep._code).toBe(400);
      expect((rep._body as { error: { code: string } }).error.code).toBe('WEAK_PASSWORD');
    });

    it('success: binds the password credential, account doc updated', async () => {
      const cols = seedAccount('bind-10');
      const ctx = ctxFor(cols, fakeOauth());
      const r = await authBindHandler(ctx, req({ method: 'password', loginId: 'bind-user-10', password: 'secret123' }, 'bind-10'), reply()) as { data: Record<string, unknown> };
      expect(r.data).toEqual({ ok: true, isAnonymous: false });
      const doc = await cols.accounts.findOne({ _id: 'bind-10' });
      expect(doc?.password?.loginId).toBe('bind-user-10');
    });

    it('already has a password → idempotent ok, does not overwrite', async () => {
      const cols = seedAccount('bind-11', { password: { loginId: 'existing-login', hash: 'existing-hash' } });
      const ctx = ctxFor(cols, fakeOauth());
      const r = await authBindHandler(ctx, req({ method: 'password', loginId: 'new-login', password: 'secret123' }, 'bind-11'), reply()) as { data: Record<string, unknown> };
      expect(r.data).toEqual({ ok: true, isAnonymous: false });
      const doc = await cols.accounts.findOne({ _id: 'bind-11' });
      expect(doc?.password?.loginId).toBe('existing-login'); // unchanged
    });

    it('loginId already taken by a different account → 409 LOGIN_ID_TAKEN', async () => {
      const cols = fakeCols({
        accounts: [
          { _id: 'bind-owner-2', password: { loginId: 'taken-login', hash: 'h' } },
          { _id: 'bind-12' },
        ],
      });
      const ctx = ctxFor(cols, fakeOauth());
      const rep = reply();
      await authBindHandler(ctx, req({ method: 'password', loginId: 'taken-login', password: 'secret123' }, 'bind-12'), rep);
      expect(rep._code).toBe(409);
      expect((rep._body as { error: { code: string } }).error.code).toBe('LOGIN_ID_TAKEN');
    });
  });

  it('unknown method (BAD_REQUEST branch unreachable from HTTP: openapi restricts `method` to the oauth/password enum) → 400 BAD_REQUEST', async () => {
    const cols = seedAccount('bind-13');
    const ctx = ctxFor(cols, fakeOauth());
    const rep = reply();
    await authBindHandler(ctx, req({ method: 'carrier-pigeon' }, 'bind-13'), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { code: string; message: string } }).error.message).toContain('unknown bind method');
  });
});
