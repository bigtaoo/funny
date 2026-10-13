// Unit coverage for AccountDoc.signupPlatform (auth/helpers.ts recordSignupPlatform): every auth handler
// stamps a brand-new account with its allow-listed X-NW-Platform header so the consent-free retention
// report (retentionReport.ts) can split cohorts by acquisition channel (CrazyGames portal test vs web /
// wechat). Same FakeCollection + buildApp('../src/app.js') setup as auth-credential-unit.test.ts, and the
// CrazyGames handler is called directly with a verify() double as in auth-crazygames-unit.test.ts.
import { describe, it, expect } from 'vitest';
import { signToken, type AccountDoc, type Collections, type SaveData } from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.js';
import { authCrazyGamesHandler, type CrazyGamesCtx } from '../src/service/auth/crazygames.js';
import { recordSignupPlatform } from '../src/service/auth/helpers.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import type { CrazyGamesTokenPayload } from '../src/crazygamesAuth.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const FIXED_TS = 1_700_000_000_000;

function fakeCols(accounts: Partial<AccountDoc>[] = []): Collections & { accounts: FakeCollection<AccountDoc> } {
  const acc = new FakeCollection<AccountDoc>();
  if (accounts.length) acc.seed(...(accounts as AccountDoc[]));
  const saves = new FakeCollection<{ _id: string; save: SaveData; rev: number }>();
  const cardInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  return { accounts: acc, saves, cardInstances } as unknown as Collections & { accounts: FakeCollection<AccountDoc> };
}

function makeDeps(cols: Collections): ServiceDeps {
  return {
    cols, jwt, now: () => FIXED_TS, commercial: fakeCommercial(), gatewayPublicUrl: null, gateway: fakeGateway(),
    authRateLimit: 0, flags: null, wordlists: null, region: null, lokiPushUrl: null, socialsvc: null, redis: null,
    accountCache: new AccountCache(),
  };
}

const platformOf = (cols: { accounts: FakeCollection<AccountDoc> }, id: string) => cols.accounts.docs.get(id)?.signupPlatform;

async function deviceLogin(cols: Collections, deviceId: string, platform?: string) {
  const app = await buildApp({
    cols, jwt, internalKey: 'k', commercial: fakeCommercial(), gateway: fakeGateway(), authRateLimit: 0, now: () => FIXED_TS,
  });
  try {
    const r = await app.inject({
      method: 'POST', url: '/auth/device', payload: { deviceId }, headers: platform ? { 'x-nw-platform': platform } : {},
    });
    expect(r.statusCode).toBe(200);
    return (JSON.parse(r.payload) as { data: { accountId: string; isNew: boolean } }).data;
  } finally {
    await app.close();
  }
}

describe('signupPlatform on POST /auth/device', () => {
  it('a new account created with x-nw-platform: crazygames records it', async () => {
    const cols = fakeCols();
    const d = await deviceLogin(cols, 'dev-cg-1', 'crazygames');
    expect(d.isNew).toBe(true);
    expect(platformOf(cols, d.accountId)).toBe('crazygames');
  });

  it('an existing account is never stamped or overwritten by a later login', async () => {
    const cols = fakeCols([{ _id: 'old-1', createdAt: 1, deviceId: 'dev-old-1' }, { _id: 'old-2', createdAt: 1, deviceId: 'dev-old-2', signupPlatform: 'web' }]);
    expect((await deviceLogin(cols, 'dev-old-1', 'crazygames')).isNew).toBe(false);
    expect(platformOf(cols, 'old-1')).toBeUndefined();
    await deviceLogin(cols, 'dev-old-2', 'wechat');
    expect(platformOf(cols, 'old-2')).toBe('web');
  });

  it('an unknown or missing header stores nothing', async () => {
    const cols = fakeCols();
    const a = await deviceLogin(cols, 'dev-bogus', 'steam');
    const b = await deviceLogin(cols, 'dev-none');
    expect(a.isNew && b.isNew).toBe(true);
    expect(platformOf(cols, a.accountId)).toBeUndefined();
    expect(platformOf(cols, b.accountId)).toBeUndefined();
  });
});

describe('recordSignupPlatform', () => {
  it('is best-effort: a failing write never throws into the login', async () => {
    const cols = fakeCols([{ _id: 'acc', createdAt: 1 }]);
    cols.accounts.updateOne = (async () => { throw new Error('mongo down'); }) as never;
    await expect(recordSignupPlatform(makeDeps(cols), 'acc', true, 'web')).resolves.toBeUndefined();
  });

  it('does not overwrite a value already set (racing second "new" login)', async () => {
    const cols = fakeCols([{ _id: 'acc', createdAt: 1, signupPlatform: 'ios' }]);
    await recordSignupPlatform(makeDeps(cols), 'acc', true, 'android');
    expect(platformOf(cols, 'acc')).toBe('ios');
  });
});

describe('signupPlatform on the CrazyGames handler', () => {
  const verify = (userId: string): CrazyGamesCtx['verify'] => async () => ({ userId, gameId: 'g' }) as CrazyGamesTokenPayload;
  const ctxFor = (cols: Collections, userId: string): CrazyGamesCtx => ({
    core: new MetaCore(makeDeps(cols)), config: { gameId: 'g' }, verify: verify(userId), allowAuthAttempt: async () => true,
  });
  const req = (body: unknown) => ({ body, headers: {} }) as unknown as FastifyRequest;
  const reply = () => ({ code() { return this; }, send(b: unknown) { return b; } }) as unknown as FastifyReply;

  it('a new portal account records crazygames even without an X-NW-Platform header', async () => {
    const cols = fakeCols();
    const r = (await authCrazyGamesHandler(ctxFor(cols, 'cg-u1'), req({ token: 't' }), reply())) as { data: { accountId: string; isNew: boolean } };
    expect(r.data.isNew).toBe(true);
    expect(platformOf(cols, r.data.accountId)).toBe('crazygames');
  });

  it('a guest linked to the portal identity keeps the platform it signed up on', async () => {
    const cols = fakeCols([{ _id: 'guest-1', createdAt: 1, deviceId: 'dev-g1', signupPlatform: 'web' }]);
    const guestToken = signToken('guest-1', jwt);
    const r = (await authCrazyGamesHandler(ctxFor(cols, 'cg-u2'), req({ token: 't', guestToken }), reply())) as { data: { accountId: string; isNew: boolean } };
    expect(r.data).toMatchObject({ accountId: 'guest-1', isNew: false });
    expect(platformOf(cols, 'guest-1')).toBe('web');
  });
});
