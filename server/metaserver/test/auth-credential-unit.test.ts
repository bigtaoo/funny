// Unit coverage for src/service/auth/{credential,helpers,profile,support}.ts + (bonus) accountLifecycle.ts,
// backfilled 2026-08-13 after the vitest v8 coverage rollout showed these files at 0~10% despite being
// exercised by test/auth-oauth-wx.e2e.test.ts / test/auth-password.e2e.test.ts — those two import
// `buildApp` from '../dist/app.js' (compiled output), so v8's source-map attribution never lands on
// src/*.ts (see 2026-08-13 baseline note in claudedocs/server.md). This file imports `buildApp` from
// '../src/app.js' instead, backed entirely by FakeCollection (no Mongo), so the SAME business logic
// branches are executed under vitest's own transform and get attributed to src correctly.
//
// Deliberately re-derives a few scenarios auth-password.e2e.test.ts already covers (banned/soft-delete/
// grace-restore) — those don't count toward src coverage at all today — but the emphasis here is on
// branches that e2e suite never touched: authRateLimit>0 429s, the loginId/displayName business-
// validation branches that sit BEHIND an identical-bound openapi schema check (only reachable via a
// trim-collapsing whitespace payload), censorChat hits on register/rename, feedback rate limiting, and
// the accountLifecycle handlers (deleteAccount/cancelAccountDeletion/recordGdprConsent).
import { describe, it, expect } from 'vitest';
import { makeNewSave, signToken, type Collections, type SaveData, type CommercialClient } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOpts } from '../src/app.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, fakeGateway } from './helpers/fakeClients.js';
import { restoreIfWithinGrace, maybeGrantStarterCards, ACCOUNT_DELETE_GRACE_MS } from '../src/service/auth/helpers.js';
import type { ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';

const jwt = { secret: 'test-secret' };
const FIXED_TS = 1_700_000_000_000;

interface AccountSeed {
  _id: string;
  createdAt?: number;
  deviceId?: string;
  openid?: string;
  displayName?: string;
  nameChosen?: boolean;
  password?: { loginId: string; hash: string };
  oauth?: { provider: string; sub: string }[];
  publicId?: string;
  deletedAt?: number;
  deletionConfirmToken?: string;
  flags?: { banned?: boolean; bannedUntil?: number; mutedUntil?: number; gdprConsent?: boolean; reputationScore?: number };
}

/**
 * FakeCollection's updateOne mis-keys an upsert-inserted doc when the upsert filter has no `_id` field
 * (the map key becomes the literal `undefined` value) — exactly the shape every accounts.ts resolveBy*
 * (device/openid/oauth) + registerWithPassword upsert uses (they match on deviceId/openid/oauth/
 * loginId, not `_id`). That mis-keying is invisible to any *multi-key* lookup (updateOne/find's slow
 * path scans by field value, not map key) but breaks the *single-key* `findOne({_id})` fast path that
 * ensurePublicId/rejectIfBanned/restoreIfWithinGrace all rely on for that same account on every
 * subsequent call — and registerWithPassword's own `if (!res.upsertedId) return {kind:'taken'}` check,
 * since the fake never populates `upsertedId` at all (unlike the real Mongo driver). Both are corrected
 * here, scoped to this test file's `accounts` collection only — fakeCollection.ts itself is untouched.
 */
class AccountsFakeCollection extends FakeCollection<AccountSeed & { _id: string }> {
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number; upsertedId?: string }> {
    const res = await super.updateOne(filter, update, opts);
    if (res.upsertedCount === 1) {
      for (const [key, doc] of [...this.docs.entries()]) {
        if (key !== doc._id) {
          this.docs.delete(key);
          this.docs.set(doc._id, doc);
          return { ...res, upsertedId: doc._id };
        }
      }
    }
    return res;
  }
}

/** insertOne always rejects with a caller-supplied error — used to drive submitAppealHandler's E11000
 *  unique-index-race catch branch (and its non-11000 rethrow) without any real concurrency. */
class ThrowingInsertCollection<T extends { _id: string }> extends FakeCollection<T> {
  constructor(private readonly toThrow: unknown) {
    super();
  }
  async insertOne(_doc: T): Promise<{ insertedId: string }> {
    throw this.toThrow;
  }
}

function fakeCols(opts: { accounts?: AccountSeed[]; saves?: { _id: string; save: SaveData; rev: number }[] } = {}): Collections {
  const accounts = new AccountsFakeCollection();
  if (opts.accounts) accounts.seed(...opts.accounts);
  const saves = new FakeCollection<{ _id: string; save: SaveData; rev: number }>();
  if (opts.saves) saves.seed(...opts.saves);
  const cardInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  const appeals = new FakeCollection<{ _id: string; accountId: string; status: string; [k: string]: unknown }>();
  const feedback = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  return { accounts, saves, cardInstances, appeals, feedback } as unknown as Collections;
}

async function makeApp(cols: Collections, extra: Partial<BuildAppOpts> = {}): Promise<FastifyInstance> {
  return buildApp({
    cols,
    jwt,
    internalKey: 'k',
    commercial: fakeCommercial(),
    gateway: fakeGateway(),
    authRateLimit: 0,
    now: () => FIXED_TS,
    ...extra,
  });
}

function body(r: { payload: string }): { ok: boolean; data?: never; error?: { code: string; message: string } } & Record<string, unknown> {
  return JSON.parse(r.payload);
}

function authHeader(accountId: string): { authorization: string } {
  return { authorization: `Bearer ${signToken(accountId, jwt)}` };
}

// ── POST /auth/wx ────────────────────────────────────────────────────────────────────────────
describe('POST /auth/wx (authWxHandler)', () => {
  it('dev-mode code resolves to a new non-anonymous account; repeat code → same account, isNew=false', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const first = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-1' } });
    expect(first.statusCode).toBe(200);
    const d1 = (body(first) as { data: Record<string, unknown> }).data;
    expect(d1.isNew).toBe(true);
    expect(d1.isAnonymous).toBe(false);
    expect(d1.publicId).toMatch(/^\d{9}$/);
    expect(d1.displayName).toBeUndefined();

    const second = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-1' } });
    const d2 = (body(second) as { data: Record<string, unknown> }).data;
    expect(d2.accountId).toBe(d1.accountId);
    expect(d2.isNew).toBe(false);
    await app.close();
  });

  it('new account grants starter cards (maybeGrantStarterCards executed via the handler)', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-starter' } });
    expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(3);
    await app.close();
  });

  it('existing account with a displayName → included in the response', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'acc-wx-1', openid: 'dev-openid:wx-named', displayName: 'Wei' }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-named' } });
    expect((body(r) as { data: Record<string, unknown> }).data.displayName).toBe('Wei');
    await app.close();
  });

  it('banned account → 403 ACCOUNT_BANNED (rejectIfBanned branch)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'acc-wx-banned', openid: 'dev-openid:wx-banned', flags: { banned: true } }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-banned' } });
    expect(r.statusCode).toBe(403);
    expect(body(r).error?.code).toBe('ACCOUNT_BANNED');
    await app.close();
  });

  it('soft-deleted within grace → restored (restoreIfWithinGrace clears deletedAt) and login succeeds', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'acc-wx-grace', openid: 'dev-openid:wx-grace', deletedAt: FIXED_TS - 1000, deletionConfirmToken: 'tok' }],
    });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-grace' } });
    expect(r.statusCode).toBe(200);
    const doc = await cols.accounts.findOne({ _id: 'acc-wx-grace' });
    expect(doc?.deletedAt).toBeUndefined();
    expect(doc?.deletionConfirmToken).toBeUndefined();
    await app.close();
  });

  it('soft-deleted past grace window → 410 ACCOUNT_DELETED', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'acc-wx-expired', openid: 'dev-openid:wx-expired', deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1000 }],
    });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/wx', payload: { code: 'wx-expired' } });
    expect(r.statusCode).toBe(410);
    expect(body(r).error?.code).toBe('ACCOUNT_DELETED');
    await app.close();
  });
});

// ── POST /auth/device ────────────────────────────────────────────────────────────────────────
describe('POST /auth/device (authDeviceHandler)', () => {
  it('brand-new device account → isAnonymous=true', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-001' } });
    expect(r.statusCode).toBe(200);
    expect((body(r) as { data: Record<string, unknown> }).data.isAnonymous).toBe(true);
    await app.close();
  });

  it('device already carrying a bound password credential → isAnonymous=false', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'acc-dev-1', deviceId: 'device-002', password: { loginId: 'x', hash: 'y' } }],
    });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-002' } });
    expect((body(r) as { data: Record<string, unknown> }).data.isAnonymous).toBe(false);
    await app.close();
  });

  it('device account carrying a displayName (e.g. set post-registration) → included in the response', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'acc-dev-named', deviceId: 'device-004', displayName: 'Dev' }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-004' } });
    expect((body(r) as { data: Record<string, unknown> }).data.displayName).toBe('Dev');
    await app.close();
  });

  it('banned device account → 403', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'acc-dev-banned', deviceId: 'device-003', flags: { banned: true } }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'device-003' } });
    expect(r.statusCode).toBe(403);
    await app.close();
  });
});

// ── POST /auth/register ──────────────────────────────────────────────────────────────────────
describe('POST /auth/register (authRegisterHandler)', () => {
  it('rate-limited: authRateLimit=1 allows exactly one attempt per IP within the window', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols, { authRateLimit: 1 });
    const ok = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'ratelimit-1', password: 'secret123' } });
    expect(ok.statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'ratelimit-2', password: 'secret123' } });
    expect(blocked.statusCode).toBe(429);
    expect(body(blocked).error?.code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('loginId that is only whitespace-padded to pass the openapi minLength but collapses under trim → 400 BAD_REQUEST (business validateLoginId branch, distinct from the schema gate)', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: '  a  ', password: 'secret123' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('weak password (< 6 chars) → 400 WEAK_PASSWORD', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'weakpw-user', password: '123' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('WEAK_PASSWORD');
    await app.close();
  });

  it('displayName too long (no schema length cap on this field) → 400 BAD_REQUEST from validateDisplayName', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { loginId: 'longname-user', password: 'secret123', displayName: 'x'.repeat(25) },
    });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('displayName hits the content filter (CM5) → 400 BAD_REQUEST, distinct message', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { loginId: 'censored-user', password: 'secret123', displayName: 'i fuck now' },
    });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    expect(body(r).error?.message).toContain('disallowed words');
    await app.close();
  });

  it('loginId already taken → 409 LOGIN_ID_TAKEN', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'dup-user', password: 'secret123' } });
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'dup-user', password: 'other123' } });
    expect(r.statusCode).toBe(409);
    expect(body(r).error?.code).toBe('LOGIN_ID_TAKEN');
    await app.close();
  });

  it('success: valid displayName is echoed and passes the content filter untouched', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { loginId: 'clean-user', password: 'secret123', displayName: 'CleanName' },
    });
    expect(r.statusCode).toBe(200);
    const d = (body(r) as { data: Record<string, unknown> }).data;
    expect(d.displayName).toBe('CleanName');
    expect(d.isNew).toBe(true);
    expect(d.isAnonymous).toBe(false);
    await app.close();
  });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────────────────────
describe('POST /auth/login (authLoginHandler)', () => {
  it('rate-limited: a failed attempt still consumes the budget', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols, { authRateLimit: 1 });
    const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'nobody', password: 'whatever1' } });
    expect(first.statusCode).toBe(401);
    const second = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'nobody', password: 'whatever1' } });
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it('banned account login → 403', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'ban-login-user', password: 'secret123' } });
    const doc = await cols.accounts.findOne({ 'password.loginId': 'ban-login-user' } as Record<string, unknown>);
    await cols.accounts.updateOne({ _id: doc!._id }, { $set: { 'flags.banned': true } });
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'ban-login-user', password: 'secret123' } });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it('soft-deleted within grace → login restores the account (200), deletedAt actually cleared', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'grace-login-user', password: 'secret123' } });
    const doc = await cols.accounts.findOne({ 'password.loginId': 'grace-login-user' } as Record<string, unknown>);
    await cols.accounts.updateOne({ _id: doc!._id }, { $set: { deletedAt: FIXED_TS - 1000 } });
    const restored = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'grace-login-user', password: 'secret123' } });
    expect(restored.statusCode).toBe(200);
    expect((await cols.accounts.findOne({ _id: doc!._id }))?.deletedAt).toBeUndefined();
    await app.close();
  });

  it('soft-deleted past the grace window → login still 410s (restore is grace-window-only)', async () => {
    // Fresh app/account (no prior rejectIfBanned call for this account) so the in-process ban-status
    // cache starts cold — a direct-to-collection mutation like the one below never itself invalidates it.
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'grace-login-expired-user', password: 'secret123' } });
    const doc = await cols.accounts.findOne({ 'password.loginId': 'grace-login-expired-user' } as Record<string, unknown>);
    await cols.accounts.updateOne({ _id: doc!._id }, { $set: { deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1000 } });
    const expired = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'grace-login-expired-user', password: 'secret123' } });
    expect(expired.statusCode).toBe(410);
    await app.close();
  });

  it('success: displayName set at registration comes back on login', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'named-login-user', password: 'secret123', displayName: 'Nate' } });
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'named-login-user', password: 'secret123' } });
    expect(r.statusCode).toBe(200);
    expect((body(r) as { data: Record<string, unknown> }).data.displayName).toBe('Nate');
    await app.close();
  });
});

// ── POST /auth/password/change ───────────────────────────────────────────────────────────────
describe('POST /auth/password/change (authPasswordChangeHandler)', () => {
  async function registerAndAuth(app: FastifyInstance, loginId: string, password: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId, password } });
    const { token } = (body(r) as { data: { token: string } }).data;
    return { authorization: `Bearer ${token}` };
  }

  it('weak new password → 400 WEAK_PASSWORD', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const auth = await registerAndAuth(app, 'pwchange-1', 'oldpass1');
    const r = await app.inject({ method: 'POST', url: '/auth/password/change', headers: auth, payload: { oldPassword: 'oldpass1', newPassword: '123' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('WEAK_PASSWORD');
    await app.close();
  });

  it('account has no password credential (device account) → 400 BAD_REQUEST', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const deviceRes = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pwchange-device-1' } });
    const { token } = (body(deviceRes) as { data: { token: string } }).data;
    const r = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'x', newPassword: 'newpass1' },
    });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('old password mismatch → 401 INVALID_CREDENTIALS', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const auth = await registerAndAuth(app, 'pwchange-2', 'oldpass1');
    const r = await app.inject({ method: 'POST', url: '/auth/password/change', headers: auth, payload: { oldPassword: 'wrong', newPassword: 'newpass1' } });
    expect(r.statusCode).toBe(401);
    expect(body(r).error?.code).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('success: new password can be used to log back in, old password no longer works', async () => {
    const cols = fakeCols();
    const app = await makeApp(cols);
    const auth = await registerAndAuth(app, 'pwchange-3', 'oldpass1');
    const okChange = await app.inject({ method: 'POST', url: '/auth/password/change', headers: auth, payload: { oldPassword: 'oldpass1', newPassword: 'newpass1' } });
    expect(okChange.statusCode).toBe(200);
    const oldLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'pwchange-3', password: 'oldpass1' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: 'pwchange-3', password: 'newpass1' } });
    expect(newLogin.statusCode).toBe(200);
    await app.close();
  });
});

// ── auth/helpers.ts (restoreIfWithinGrace / maybeGrantStarterCards) direct unit calls ──────────
describe('helpers.ts direct unit coverage', () => {
  function makeDeps(cols: Collections): ServiceDeps {
    return {
      cols,
      jwt,
      now: () => FIXED_TS,
      commercial: fakeCommercial() as unknown as CommercialClient,
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

  describe('restoreIfWithinGrace', () => {
    it('no deletedAt → no-op', async () => {
      const cols = fakeCols({ accounts: [{ _id: 'a1' }] });
      await restoreIfWithinGrace(makeDeps(cols), 'a1');
      const doc = await cols.accounts.findOne({ _id: 'a1' });
      expect(doc?.deletedAt).toBeUndefined();
    });

    it('within grace → clears deletedAt/deletionConfirmToken and invalidates the ban cache', async () => {
      const cols = fakeCols({ accounts: [{ _id: 'a2', deletedAt: FIXED_TS - 1000, deletionConfirmToken: 'tok' }] });
      const deps = makeDeps(cols);
      // Prime the ban-status cache so we can observe invalidateBanStatus actually clearing it.
      await deps.accountCache.getBanStatus(cols, 'a2');
      await restoreIfWithinGrace(deps, 'a2');
      const doc = await cols.accounts.findOne({ _id: 'a2' });
      expect(doc?.deletedAt).toBeUndefined();
      expect(doc?.deletionConfirmToken).toBeUndefined();
    });

    it('past grace window → no-op (deletedAt left untouched)', async () => {
      const cols = fakeCols({ accounts: [{ _id: 'a3', deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1 }] });
      await restoreIfWithinGrace(makeDeps(cols), 'a3');
      const doc = await cols.accounts.findOne({ _id: 'a3' });
      expect(doc?.deletedAt).toBe(FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1);
    });
  });

  describe('maybeGrantStarterCards', () => {
    it('isNew=false → no-op, no cards granted', async () => {
      const cols = fakeCols();
      await maybeGrantStarterCards(makeDeps(cols), 'b1', false);
      expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(0);
    });

    it('isNew=true, brand-new save → grants exactly 3 starter cards', async () => {
      const cols = fakeCols();
      await maybeGrantStarterCards(makeDeps(cols), 'b2', true);
      expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(3);
      const saveDoc = await cols.saves.findOne({ _id: 'b2' });
      expect(saveDoc?.save.cardInvCount).toBe(3);
    });

    it('isNew=true but save already has cards (re-entrant call) → no-op', async () => {
      const cols = fakeCols();
      const seededSave = makeNewSave('b3', FIXED_TS);
      seededSave.cardInvCount = 5;
      (cols.saves as unknown as FakeCollection<{ _id: string; save: SaveData; rev: number }>).seed({ _id: 'b3', save: seededSave, rev: seededSave.rev });
      await maybeGrantStarterCards(makeDeps(cols), 'b3', true);
      expect((cols as unknown as { cardInstances: FakeCollection<{ _id: string }> }).cardInstances.docs.size).toBe(0);
    });
  });
});

// ── POST /profile/rename (profileRenameHandler) ──────────────────────────────────────────────
describe('POST /profile/rename (profileRenameHandler)', () => {
  function seedNamelessAccount(id: string) {
    return fakeCols({ accounts: [{ _id: id }], saves: [{ _id: id, save: makeNewSave(id, FIXED_TS), rev: 1 }] });
  }

  it('displayName collapses to empty under trim (passes the openapi minLength but not validateDisplayName) → 400 BAD_REQUEST', async () => {
    const cols = seedNamelessAccount('rename-1');
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-1'), payload: { displayName: ' ' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('displayName hits the content filter → 400 BAD_REQUEST, rejected outright (not masked)', async () => {
    const cols = seedNamelessAccount('rename-2');
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-2'), payload: { displayName: 'you fuck' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.message).toContain('disallowed words');
    await app.close();
  });

  it('first rename is free (nameChosen not yet set) → 200, save reflects the new name', async () => {
    const cols = seedNamelessAccount('rename-3');
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-3'), payload: { displayName: 'FreeName' } });
    expect(r.statusCode).toBe(200);
    const d = (body(r) as { data: Record<string, unknown> }).data;
    expect(d.displayName).toBe('FreeName');
    await app.close();
  });

  it('second rename is paid: commercial unavailable → 503', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'rename-4', nameChosen: true }],
      saves: [{ _id: 'rename-4', save: makeNewSave('rename-4', FIXED_TS), rev: 1 }],
    });
    const app = await makeApp(cols, { commercial: fakeCommercial(false) });
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-4'), payload: { displayName: 'PaidName' } });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  it('second rename is paid: insufficient funds → 402 INSUFFICIENT_FUNDS', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'rename-5', nameChosen: true }],
      saves: [{ _id: 'rename-5', save: makeNewSave('rename-5', FIXED_TS), rev: 1 }],
    });
    const commercial = {
      available: true,
      spend: async () => ({ ok: false as const, error: 'INSUFFICIENT_FUNDS' }),
    } as unknown as CommercialClient;
    const app = await makeApp(cols, { commercial });
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-5'), payload: { displayName: 'PaidName' } });
    expect(r.statusCode).toBe(402);
    expect(body(r).error?.code).toBe('INSUFFICIENT_FUNDS');
    await app.close();
  });

  it('second rename is paid: some other commercial error → 400 BAD_REQUEST with the raw error code', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'rename-6', nameChosen: true }],
      saves: [{ _id: 'rename-6', save: makeNewSave('rename-6', FIXED_TS), rev: 1 }],
    });
    const commercial = {
      available: true,
      spend: async () => ({ ok: false as const, error: 'SOME_OTHER_ERROR' }),
    } as unknown as CommercialClient;
    const app = await makeApp(cols, { commercial });
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-6'), payload: { displayName: 'PaidName' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.message).toBe('SOME_OTHER_ERROR');
    await app.close();
  });

  it('second rename is paid: success → coins mirrored back into save', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'rename-7', nameChosen: true }],
      saves: [{ _id: 'rename-7', save: makeNewSave('rename-7', FIXED_TS), rev: 1 }],
    });
    const commercial = {
      available: true,
      spend: async () => ({ ok: true as const, coinsAfter: 4500 }),
    } as unknown as CommercialClient;
    const app = await makeApp(cols, { commercial });
    const r = await app.inject({ method: 'POST', url: '/profile/rename', headers: authHeader('rename-7'), payload: { displayName: 'PaidName2' } });
    expect(r.statusCode).toBe(200);
    const d = (body(r) as { data: Record<string, unknown> }).data;
    expect(d.displayName).toBe('PaidName2');
    expect((d.save as SaveData).wallet.coins).toBe(4500);
    await app.close();
  });
});

// ── POST /account/appeal (submitAppealHandler) ───────────────────────────────────────────────
describe('POST /account/appeal (submitAppealHandler)', () => {
  it('empty reason after trim → 400 BAD_REQUEST', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-0', flags: { banned: true } }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-0'), payload: { reason: '   ' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('active mute (mutedUntil in the future) also qualifies; snapshot captures mutedUntil + reputationScore', async () => {
    const cols = fakeCols({
      accounts: [{ _id: 'appeal-7', flags: { mutedUntil: FIXED_TS + 60_000, reputationScore: 42 } }],
    });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-7'), payload: { reason: 'muted unfairly' } });
    expect(r.statusCode).toBe(200);
    const doc = await (cols as unknown as { appeals: FakeCollection<{ accountId: string; enforcementSnapshot: Record<string, unknown> }> }).appeals.findOne({ accountId: 'appeal-7' });
    expect(doc?.enforcementSnapshot.mutedUntil).toBe(FIXED_TS + 60_000);
    expect(doc?.enforcementSnapshot.reputationScore).toBe(42);
    expect(doc?.enforcementSnapshot.banned).toBeUndefined();
    await app.close();
  });

  it('no active enforcement → 400 BAD_REQUEST', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-1' }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-1'), payload: { reason: 'I was wrongly muted' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('active ban → appeal accepted, enforcementSnapshot captures banned=true', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-2', flags: { banned: true } }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-2'), payload: { reason: 'please review' } });
    expect(r.statusCode).toBe(200);
    const doc = await (cols as unknown as { appeals: FakeCollection<{ accountId: string; status: string; enforcementSnapshot: Record<string, unknown> }> }).appeals.findOne({ accountId: 'appeal-2' });
    expect(doc?.status).toBe('open');
    expect(doc?.enforcementSnapshot.banned).toBe(true);
    await app.close();
  });

  it('active temp-ban (bannedUntil in the future) also qualifies', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-3', flags: { bannedUntil: FIXED_TS + 60_000 } }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-3'), payload: { reason: 'please review' } });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it('second appeal while one is already open → 409 ALREADY_REQUESTED', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-4', flags: { banned: true } }] });
    const app = await makeApp(cols);
    await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-4'), payload: { reason: 'first' } });
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-4'), payload: { reason: 'second' } });
    expect(r.statusCode).toBe(409);
    expect(body(r).error?.code).toBe('ALREADY_REQUESTED');
    await app.close();
  });

  it('unique-index race (E11000) on insertOne (both submits passed the findOne pre-check) → 409 ALREADY_REQUESTED, not a 500', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-5', flags: { banned: true } }] }) as unknown as Record<string, unknown>;
    const raced = { ...cols, appeals: new ThrowingInsertCollection(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })) };
    const app = await makeApp(raced as unknown as Collections);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-5'), payload: { reason: 'racing submit' } });
    expect(r.statusCode).toBe(409);
    expect(body(r).error?.code).toBe('ALREADY_REQUESTED');
    await app.close();
  });

  it('a non-duplicate-key insertOne failure is rethrown (surfaces as 500), not swallowed as ALREADY_REQUESTED', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'appeal-6', flags: { banned: true } }] }) as unknown as Record<string, unknown>;
    const broken = { ...cols, appeals: new ThrowingInsertCollection(new Error('disk full')) };
    const app = await makeApp(broken as unknown as Collections);
    const r = await app.inject({ method: 'POST', url: '/account/appeal', headers: authHeader('appeal-6'), payload: { reason: 'whatever' } });
    expect(r.statusCode).toBe(500);
    await app.close();
  });
});

// ── POST /feedback (submitFeedbackHandler) ───────────────────────────────────────────────────
describe('POST /feedback (submitFeedbackHandler)', () => {
  it('empty text after trim → 400 BAD_REQUEST', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'fb-1' }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/feedback', headers: authHeader('fb-1'), payload: { text: '   ' } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('per-account daily rate limit (FEEDBACK_RATE_LIMIT_PER_DAY=5): 6th submission same day → 429', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'fb-2' }] });
    const app = await makeApp(cols);
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/feedback', headers: authHeader('fb-2'), payload: { text: `report ${i}` } });
      expect(r.statusCode).toBe(200);
    }
    const over = await app.inject({ method: 'POST', url: '/feedback', headers: authHeader('fb-2'), payload: { text: 'one too many' } });
    expect(over.statusCode).toBe(429);
    expect(body(over).error?.code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('rate limit is per-account, not global: a different account is unaffected', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'fb-3' }, { _id: 'fb-4' }] });
    const app = await makeApp(cols);
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/feedback', headers: authHeader('fb-3'), payload: { text: `x${i}` } });
    const other = await app.inject({ method: 'POST', url: '/feedback', headers: authHeader('fb-4'), payload: { text: 'still fine' } });
    expect(other.statusCode).toBe(200);
    await app.close();
  });
});

// ── Bonus: accountLifecycle.ts (deleteAccount / cancelAccountDeletion / recordGdprConsent) ──────
describe('accountLifecycle.ts (bonus, deleteAccount / cancelAccountDeletion / recordGdprConsent)', () => {
  it('DELETE /account sets deletedAt + confirmToken; cancel-deletion without pending deletion → 400', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'life-1' }] });
    const app = await makeApp(cols);
    const notPending = await app.inject({ method: 'POST', url: '/account/cancel-deletion', headers: authHeader('life-1'), payload: { confirmToken: 'anything' } });
    expect(notPending.statusCode).toBe(400);
    expect(body(notPending).error?.code).toBe('ACCOUNT_NOT_DELETED');

    const del = await app.inject({ method: 'DELETE', url: '/account', headers: authHeader('life-1') });
    expect(del.statusCode).toBe(200);
    const { confirmToken } = (body(del) as { data: { confirmToken: string } }).data;
    expect(confirmToken).toBeTruthy();
    await app.close();
  });

  it('cancel-deletion: wrong token → 400 DELETION_TOKEN_INVALID; correct token within grace → 200 and restores', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'life-2' }] });
    const app = await makeApp(cols);
    const del = await app.inject({ method: 'DELETE', url: '/account', headers: authHeader('life-2') });
    const { confirmToken } = (body(del) as { data: { confirmToken: string } }).data;

    const wrong = await app.inject({ method: 'POST', url: '/account/cancel-deletion', headers: authHeader('life-2'), payload: { confirmToken: 'nope' } });
    expect(wrong.statusCode).toBe(400);
    expect(body(wrong).error?.code).toBe('DELETION_TOKEN_INVALID');

    const okCancel = await app.inject({ method: 'POST', url: '/account/cancel-deletion', headers: authHeader('life-2'), payload: { confirmToken } });
    expect(okCancel.statusCode).toBe(200);
    const doc = await cols.accounts.findOne({ _id: 'life-2' });
    expect(doc?.deletedAt).toBeUndefined();
    await app.close();
  });

  it('cancel-deletion past the grace window → 400 DELETION_TOKEN_INVALID even with the right token', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'life-3', deletedAt: FIXED_TS - ACCOUNT_DELETE_GRACE_MS - 1, deletionConfirmToken: 'tok-3' }] });
    const app = await makeApp(cols);
    const r = await app.inject({ method: 'POST', url: '/account/cancel-deletion', headers: authHeader('life-3'), payload: { confirmToken: 'tok-3' } });
    expect(r.statusCode).toBe(400);
    expect(body(r).error?.code).toBe('DELETION_TOKEN_INVALID');
    await app.close();
  });

  it('recordGdprConsent writes flags.gdprConsent (true then false)', async () => {
    const cols = fakeCols({ accounts: [{ _id: 'life-4' }] });
    const app = await makeApp(cols);
    const on = await app.inject({ method: 'POST', url: '/account/gdpr-consent', headers: authHeader('life-4'), payload: { consent: true } });
    expect(on.statusCode).toBe(200);
    expect((await cols.accounts.findOne({ _id: 'life-4' }))?.flags?.gdprConsent).toBe(true);

    const off = await app.inject({ method: 'POST', url: '/account/gdpr-consent', headers: authHeader('life-4'), payload: { consent: false } });
    expect(off.statusCode).toBe(200);
    expect((await cols.accounts.findOne({ _id: 'life-4' }))?.flags?.gdprConsent).toBe(false);
    await app.close();
  });
});
