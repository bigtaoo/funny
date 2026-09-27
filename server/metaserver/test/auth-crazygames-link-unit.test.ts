// CrazyGames account integration (CRAZYGAMES_LAUNCH.md §4.1), on top of the same harness shape as
// auth-crazygames-unit.test.ts: a device guest who signs into CrazyGames keeps their account (the portal
// identity is bound to it), the portal username/picture are synced on every login, the synced name is
// locked against renames, and the picture outranks the equipped avatar in what other players receive.
import { describe, it, expect } from 'vitest';
import type { Collections, SaveData } from '@nw/shared';
import { signToken } from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authCrazyGamesHandler, type CrazyGamesCtx } from '../src/service/auth/crazygames.js';
import { profileRenameHandler } from '../src/service/auth/profile.js';
import { getProfile, getPortalProfile } from '../src/accounts.js';
import { profileOf } from '../src/social.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import type { CrazyGamesAuthConfig, CrazyGamesTokenPayload } from '../src/crazygamesAuth.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const FIXED_TS = 1_700_000_000_000;
const CFG: CrazyGamesAuthConfig = { gameId: 'nw-crazygames-prod' };
const PIC = 'https://images.crazygames.com/userportal/avatars/7.png';

interface AccountSeed {
  _id: string;
  createdAt?: number;
  deviceId?: string;
  password?: { loginId: string; hash: string };
  oauth?: { provider: string; sub: string }[];
  displayName?: string;
  publicId?: string;
  nameChosen?: boolean;
  nameLockedBy?: string;
  platformAvatarUrl?: string;
}

type SaveSeed = { _id: string; save: SaveData; rev: number };

function fakeCols(opts: { accounts?: AccountSeed[]; saves?: SaveSeed[] } = {}): Collections {
  const accounts = new FakeCollection<AccountSeed & { _id: string }>();
  if (opts.accounts) accounts.seed(...opts.accounts);
  const saves = new FakeCollection<SaveSeed>();
  if (opts.saves) saves.seed(...opts.saves);
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

function fakeVerify(opts: { userId: string; username?: string; picture?: string }): CrazyGamesCtx['verify'] {
  return async () => ({
    userId: opts.userId,
    gameId: CFG.gameId,
    ...(opts.username !== undefined ? { username: opts.username } : {}),
    ...(opts.picture !== undefined ? { profilePictureUrl: opts.picture } : {}),
  }) as CrazyGamesTokenPayload;
}

function reply(): FastifyReply & { _code: number; _body: unknown } {
  const r = { _code: 200, _body: undefined as unknown } as FastifyReply & { _code: number; _body: unknown };
  r.code = ((c: number) => { r._code = c; return r; }) as never;
  r.send = ((b: unknown) => { r._body = b; return r; }) as never;
  return r;
}

type AuthData = { accountId: string; isNew: boolean; isAnonymous: boolean; displayName?: string };

async function login(cols: Collections, verify: CrazyGamesCtx['verify'], body: Record<string, unknown> = {}) {
  const ctx: CrazyGamesCtx = { core: new MetaCore(makeDeps(cols)), config: CFG, verify, allowAuthAttempt: async () => true };
  const rep = reply();
  const req = { body: { token: 'cg-token', ...body }, headers: {} } as unknown as FastifyRequest;
  const out = (await authCrazyGamesHandler(ctx, req, rep)) as { data: AuthData } | undefined;
  return { rep, data: out?.data };
}

const save = (avatar: string): SaveData => ({ pvp: { elo: 1000 }, equipped: { avatar } }) as unknown as SaveData;

describe('authCrazyGamesHandler — a guest keeps their account when signing into CrazyGames', () => {
  it('binds a new CrazyGames user to the device guest behind guestToken', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'guest-1', deviceId: 'dev-1', createdAt: 1 }] });
    const { data } = await login(cols, fakeVerify({ userId: 'cg-1' }), { guestToken: signToken('guest-1', jwt) });
    expect(data).toMatchObject({ accountId: 'guest-1', isNew: false, isAnonymous: false });
    expect((await cols.accounts.findOne({ _id: 'guest-1' }))?.oauth).toEqual([{ provider: 'crazygames', sub: 'cg-1' }]);
    // The next launch carries no guest token at all and still lands on that same account.
    expect((await login(cols, fakeVerify({ userId: 'cg-1' }))).data?.accountId).toBe('guest-1');
  });

  it('a returning CrazyGames user gets their own account back; the guest is left untouched', async () => {
    const cols = fakeCols({ accounts: [
      { _id: 'guest-1', deviceId: 'dev-1', createdAt: 1 },
      { _id: 'cg-acct', createdAt: 1, oauth: [{ provider: 'crazygames', sub: 'cg-1' }] },
    ] });
    const { data } = await login(cols, fakeVerify({ userId: 'cg-1' }), { guestToken: signToken('guest-1', jwt) });
    expect(data?.accountId).toBe('cg-acct');
    expect((await cols.accounts.findOne({ _id: 'guest-1' }))?.oauth).toBeUndefined();
  });

  it('never binds onto an account that already has a recoverable credential', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'pw-1', createdAt: 1, password: { loginId: 'a@b.c', hash: 'x' } }] });
    const { data } = await login(cols, fakeVerify({ userId: 'cg-2' }), { guestToken: signToken('pw-1', jwt) });
    expect(data?.accountId).not.toBe('pw-1');
    expect(data?.isNew).toBe(true);
    expect((await cols.accounts.findOne({ _id: 'pw-1' }))?.oauth).toBeUndefined();
  });

  it('a guest token signed with another key is ignored (new account, no error)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'guest-1', deviceId: 'dev-1', createdAt: 1 }] });
    const forged = signToken('guest-1', { secret: 'someone-else' });
    const { rep, data } = await login(cols, fakeVerify({ userId: 'cg-3' }), { guestToken: forged });
    expect(rep._code).toBe(200);
    expect(data?.accountId).not.toBe('guest-1');
  });
});

describe('authCrazyGamesHandler — portal username and picture', () => {
  it('syncs the portal username and picture on login and locks the name', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-acct', createdAt: 1, oauth: [{ provider: 'crazygames', sub: 'cg-1' }], displayName: 'RandomName' }] });
    const { data } = await login(cols, fakeVerify({ userId: 'cg-1', username: 'InkWizard', picture: PIC }));
    expect(data?.displayName).toBe('InkWizard');
    expect(await cols.accounts.findOne({ _id: 'cg-acct' })).toMatchObject({
      displayName: 'InkWizard', nameChosen: true, nameLockedBy: 'crazygames', platformAvatarUrl: PIC,
    });
    expect(await getPortalProfile(cols, 'cg-acct')).toEqual({ nameLocked: true, platformAvatarId: `url:${PIC}` });
  });

  it('REGRESSION: a picture outside the host allowlist is never stored (it is loaded by other players)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-acct', createdAt: 1, oauth: [{ provider: 'crazygames', sub: 'cg-1' }], platformAvatarUrl: PIC }] });
    await login(cols, fakeVerify({ userId: 'cg-1', username: 'A', picture: 'https://evil.example/x.png' }));
    expect((await cols.accounts.findOne({ _id: 'cg-acct' }))?.platformAvatarUrl).toBeUndefined();
  });

  it('a token without a usable username keeps the existing name', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-acct', createdAt: 1, oauth: [{ provider: 'crazygames', sub: 'cg-1' }], displayName: 'Kept' }] });
    const { data } = await login(cols, fakeVerify({ userId: 'cg-1', username: '   ' }));
    expect(data?.displayName).toBe('Kept');
  });

  it('the portal picture outranks the equipped avatar in what other players receive', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'cg-acct', createdAt: 1, publicId: '123456789', displayName: 'A', platformAvatarUrl: PIC }],
      saves: [{ _id: 'cg-acct', save: save('preset:cat'), rev: 1 }],
    });
    expect((await getProfile(cols, 'cg-acct')).avatarId).toBe(`url:${PIC}`);
    expect((await profileOf(cols, 'cg-acct'))?.avatarId).toBe(`url:${PIC}`);
  });

  it('accounts without a portal picture are unchanged', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'web-1', createdAt: 1, publicId: '223456789', displayName: 'B' }],
      saves: [{ _id: 'web-1', save: save('preset:cat'), rev: 1 }],
    });
    expect((await getProfile(cols, 'web-1')).avatarId).toBe('preset:cat');
    expect((await profileOf(cols, 'web-1'))?.avatarId).toBe('preset:cat');
    expect(await getPortalProfile(cols, 'web-1')).toEqual({});
  });
});

describe('profileRename — portal-owned names', () => {
  it('refuses to rename a portal-locked name, and spends nothing', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'cg-acct', createdAt: 1, displayName: 'InkWizard', nameChosen: true, nameLockedBy: 'crazygames' }] });
    const rep = reply();
    const req = { body: { displayName: 'NewName' }, headers: {}, accountId: 'cg-acct' } as unknown as FastifyRequest;
    await profileRenameHandler(new MetaCore(makeDeps(cols)), req, rep);
    expect(rep._code).toBe(400);
    expect((await cols.accounts.findOne({ _id: 'cg-acct' }))?.displayName).toBe('InkWizard');
  });
});
