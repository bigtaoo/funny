// Unit coverage for src/service/auth/crazygames.ts (authCrazyGamesHandler), same shape/rationale as
// auth-oauthbind-unit.test.ts's header: calls the handler function directly with a hand-built
// `verify` double (no RSA keypair, no network) so every outcome — unconfigured / rate-limited / bad
// token / success / repeat login / banned / soft-deleted — is driven deterministically.
import { describe, it, expect } from 'vitest';
import type { Collections, SaveData } from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authCrazyGamesHandler, type CrazyGamesCtx } from '../src/service/auth/crazygames.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { CrazyGamesAuthError, type CrazyGamesAuthConfig, type CrazyGamesTokenPayload } from '../src/crazygamesAuth.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const FIXED_TS = 1_700_000_000_000;
const ACCOUNT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const CFG: CrazyGamesAuthConfig = { gameId: 'nw-crazygames-prod' };

interface AccountSeed {
  _id: string;
  createdAt?: number;
  oauth?: { provider: string; sub: string }[];
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

/** Hand-built verify() double: fully controlled by the test, no RSA keypair, no network — mirrors
 *  auth-oauthbind-unit.test.ts's fakeOauth(). */
function fakeVerify(opts: { userId?: string; throwError?: unknown } = {}): CrazyGamesCtx['verify'] {
  return async () => {
    if (opts.throwError) throw opts.throwError;
    return { userId: opts.userId ?? 'cg-user-default', gameId: CFG.gameId } as CrazyGamesTokenPayload;
  };
}

function req(body: unknown): FastifyRequest {
  return { body, headers: {} } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { _code: number; _body: unknown } {
  const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
  r.code = ((c: number) => { r._code = c; return r; }) as never;
  r.send = ((b: unknown) => { r._body = b; return r; }) as never;
  return r;
}

function ctxFor(
  cols: Collections,
  verify: CrazyGamesCtx['verify'],
  opts: { config?: CrazyGamesAuthConfig | undefined; allow?: boolean } = {},
): CrazyGamesCtx {
  return {
    core: new MetaCore(makeDeps(cols)),
    config: 'config' in opts ? opts.config : CFG,
    verify,
    allowAuthAttempt: async () => opts.allow ?? true,
  };
}

describe('authCrazyGamesHandler', () => {
  it('rate-limited (allowAuthAttempt=false) → 429 RATE_LIMITED', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeVerify(), { allow: false });
    const rep = reply();
    await authCrazyGamesHandler(ctx, req({ token: 't' }), rep);
    expect(rep._code).toBe(429);
    expect((rep._body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('unconfigured (no NW_CRAZYGAMES_GAME_ID) → 400 OAUTH_FAILED, verify() never called', async () => {
    const cols = fakeCols();
    let called = false;
    const verify: CrazyGamesCtx['verify'] = async () => { called = true; return { userId: 'x', gameId: CFG.gameId }; };
    const ctx = ctxFor(cols, verify, { config: undefined });
    const rep = reply();
    await authCrazyGamesHandler(ctx, req({ token: 't' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { code: string } }).error.code).toBe('OAUTH_FAILED');
    expect(called).toBe(false);
  });

  it('verify() throws CrazyGamesAuthError → 400 OAUTH_FAILED, message forwarded verbatim', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeVerify({ throwError: new CrazyGamesAuthError('invalid or expired CrazyGames token') }));
    const rep = reply();
    await authCrazyGamesHandler(ctx, req({ token: 'bad' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { message: string } }).error.message).toBe('invalid or expired CrazyGames token');
  });

  it('verify() throws a generic (non-CrazyGamesAuthError) Error → 400 OAUTH_FAILED, generic fallback message', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeVerify({ throwError: new Error('unexpected') }));
    const rep = reply();
    await authCrazyGamesHandler(ctx, req({ token: 'bad' }), rep);
    expect(rep._code).toBe(400);
    expect((rep._body as { error: { message: string } }).error.message).toBe('CrazyGames token verification failed');
  });

  it('success: new userId → new non-anonymous account, starter cards granted; repeat userId → same account, isNew=false', async () => {
    const cols = fakeCols();
    const ctx = ctxFor(cols, fakeVerify({ userId: 'cg-user-1' }));
    const first = await authCrazyGamesHandler(ctx, req({ token: 't1' }), reply()) as { data: Record<string, unknown> };
    expect(first.data.isNew).toBe(true);
    expect(first.data.isAnonymous).toBe(false);
    expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(3);

    const second = await authCrazyGamesHandler(ctx, req({ token: 't2' }), reply()) as { data: Record<string, unknown> };
    expect(second.data.accountId).toBe(first.data.accountId);
    expect(second.data.isNew).toBe(false);
  });

  it('existing account with a displayName → included in the response', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-1', oauth: [{ provider: 'crazygames', sub: 'cg-user-named' }], displayName: 'Ola' }] });
    const ctx = ctxFor(cols, fakeVerify({ userId: 'cg-user-named' }));
    const r = await authCrazyGamesHandler(ctx, req({ token: 't' }), reply()) as { data: Record<string, unknown> };
    expect(r.data.displayName).toBe('Ola');
  });

  it('banned account → 403 ACCOUNT_BANNED (rejectIfBanned)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-2', oauth: [{ provider: 'crazygames', sub: 'cg-user-banned' }], flags: { banned: true } }] });
    const ctx = ctxFor(cols, fakeVerify({ userId: 'cg-user-banned' }));
    const rep = reply();
    const result = await authCrazyGamesHandler(ctx, req({ token: 't' }), rep);
    expect(result).toBeUndefined(); // handler returns early after reply.send(), no ok() payload
    expect(rep._code).toBe(403);
  });

  it('soft-deleted within grace → restored, login proceeds; past grace → 410 ACCOUNT_DELETED', async () => {
    const colsGrace = fakeCols({ accounts: [{ _id: 'cg-3', oauth: [{ provider: 'crazygames', sub: 'cg-user-grace' }], deletedAt: FIXED_TS - 1000 }] });
    const ctxGrace = ctxFor(colsGrace, fakeVerify({ userId: 'cg-user-grace' }));
    const grace = await authCrazyGamesHandler(ctxGrace, req({ token: 't' }), reply());
    expect((grace as { data: Record<string, unknown> }).data.accountId).toBe('cg-3');
    expect((await colsGrace.accounts.findOne({ _id: 'cg-3' }))?.deletedAt).toBeUndefined();

    const colsExpired = fakeCols({ accounts: [{ _id: 'cg-4', oauth: [{ provider: 'crazygames', sub: 'cg-user-expired' }], deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1 }] });
    const ctxExpired = ctxFor(colsExpired, fakeVerify({ userId: 'cg-user-expired' }));
    const rep = reply();
    await authCrazyGamesHandler(ctxExpired, req({ token: 't' }), rep);
    expect(rep._code).toBe(410);
    expect((rep._body as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETED');
  });
});
