// Branch-coverage backfill for internal/{mailRoutes,accountRoutes,ladderRoutes}.ts — the shapes the
// existing internal-mail / internal-accounts / internal-ladder suites never send. Three families:
//   (a) absent-field fallbacks in the system-mail body (`b.body ?? ''`, `b.attachments ?? []`,
//       `b.expireDays ?? 0`) and in the preview target (`'publicId' in b.target ? … : ''`),
//   (b) the fan-out edges an ops "send to everyone" actually hits: an empty player table (flush's
//       early return) and more than one MAIL_FANOUT_BATCH of recipients,
//   (c) degraded/failing dependencies: socialsvc unreachable on both mail paths, and the storage
//       failures behind the two ladder endpoints' catch blocks — plus the missing-parameter 400s on
//       the elo / player-search / friends lookups.
// Registers the route modules from ../src (never ../dist — v8 coverage cannot attribute dist/*.js to src/*.ts).
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { makeNewSave, INITIAL_ELO, type Collections, type SaveData, type LadderSeasonDoc } from '@nw/shared';
import { registerMailRoutes } from '../src/internal/mailRoutes.js';
import { registerAccountRoutes } from '../src/internal/accountRoutes.js';
import { registerLadderRoutes } from '../src/internal/ladderRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, FakeSocialsvc, ThrowingSocialsvc } from './helpers/fakeClients.js';
import { AccountCache } from '../src/accountCache.js';

interface AccountDoc { _id: string; publicId?: string; displayName?: string; flags?: { banned?: boolean } }
interface SaveDocRow { _id: string; save: SaveData; rev: number }

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function saveRow(id: string, extra: Partial<SaveData> = {}): SaveDocRow {
  const s = { ...makeNewSave(id, 1000), ...extra };
  return { _id: id, save: s, rev: s.rev };
}

/** Every read on this collection fails — models Mongo being unreachable behind a route's try/catch. */
class BrokenCollection<T extends { _id: string }> extends FakeCollection<T> {
  override async findOne(): Promise<T | null> {
    throw new Error('topology destroyed');
  }
  override async findOneAndUpdate(): Promise<T | null> {
    throw new Error('topology destroyed');
  }
}

// ── mail ────────────────────────────────────────────────────────────────────────────────────────────
function buildMail(opts: { accounts?: AccountDoc[]; socialsvcDown?: boolean } = {}) {
  const accounts = new FakeCollection<AccountDoc>().seed(...(opts.accounts ?? []));
  const socialsvc = opts.socialsvcDown ? new ThrowingSocialsvc() : new FakeSocialsvc();
  const gateway = fakeGateway() as ReturnType<typeof fakeGateway> & { pushed: { accountId: string; payload: unknown }[] };
  const ctx: InternalCtx = {
    cols: { accounts } as unknown as Collections,
    now: () => 1000,
    gateway,
    commercial: fakeCommercial(),
    socialsvc,
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerMailRoutes(app, ctx);
  return { app, accounts, socialsvc, gateway };
}

describe('POST /internal/mail/system/preview — absent target', () => {
  // `b.target && 'publicId' in b.target ? b.target.publicId : ''`: an ops console that has not picked a
  // recipient yet posts no target at all. The preview must answer 0 recipients, not resolve `undefined`.
  it.each([
    ['no target key', {}],
    ['target null', { target: null }],
    ['target without publicId', { target: { accountId: 'a' } }],
  ])('%s → recipientCount 0', async (_label, payload) => {
    const { app } = buildMail({ accounts: [{ _id: 'a', publicId: '123456789' }] });
    const res = await app.inject({ method: 'POST', url: '/internal/mail/system/preview', headers: authHeaders, payload });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 0 });
  });
});

describe('POST /internal/mail/system/send — absent content fields', () => {
  // body/attachments/expireDays are all `?? <default>`. A compensation ticket sent with only a subject
  // must deliver an empty-body, attachment-free mail — and the mail_new push must say hasAttachment
  // false, since a false positive lights the client's "claim your reward" affordance on nothing.
  it('only dispatchKey + subject → body "", no attachments, expireDays 0, push says hasAttachment:false', async () => {
    const { app, socialsvc, gateway } = buildMail({ accounts: [{ _id: 'a', publicId: '123456789' }] });
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'bare.1', subject: 'Notice', target: { publicId: '123456789' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 1 });
    const mail = (socialsvc as FakeSocialsvc).mail.get('bare.1:a')!;
    expect(mail.body).toBe('');
    expect(mail.attachments).toEqual([]);
    expect(gateway.pushed).toHaveLength(1);
    expect(gateway.pushed[0]).toMatchObject({ payload: { kind: 'mail_new', hasAttachment: false } });
  });
});

describe('POST /internal/mail/system/send — global fan-out edges', () => {
  // flush()'s `if (batch.length === 0) return`: the trailing flush after the cursor drains always sees an
  // empty batch when the account count is an exact multiple of the batch size — and on an empty table
  // it is the only flush. Reporting ok:true/0 (rather than erroring) is what an ops console shows.
  it('no accounts at all → ok:true with recipientCount 0 and no mail written', async () => {
    const { app, socialsvc } = buildMail();
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'global.empty', subject: 'Hi', scope: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 0 });
    expect((socialsvc as FakeSocialsvc).mail.size).toBe(0);
  });

  // `if (batch.length >= MAIL_FANOUT_BATCH) await flush()` — the mid-cursor flush. Every existing test
  // seeds a handful of accounts, so a real server-wide send (the only reason this batching exists) had
  // never actually crossed a batch boundary here.
  it('501 accounts → batched fan-out still reaches every recipient exactly once', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ _id: `acct${i}` }));
    const { app, socialsvc } = buildMail({ accounts: many });
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'global.big', subject: 'Maintenance', scope: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 501 });
    expect((socialsvc as FakeSocialsvc).mail.size).toBe(501);
    expect((socialsvc as FakeSocialsvc).mail.has('global.big:acct500')).toBe(true);
  });

  // Fan-out failure: reported as HTTP 200 with ok:false (the ops console reads the flag, not the status)
  // and carries the underlying reason plus how many recipients were already reached before the failure.
  it('socialsvc unreachable → ok:false with the error message, not a 5xx', async () => {
    const { app } = buildMail({ accounts: [{ _id: 'a' }, { _id: 'b' }], socialsvcDown: true });
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'global.fail', subject: 'Hi', scope: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, recipientCount: 0, error: 'socialsvc not configured' });
  });

});

describe('POST /internal/mail/system/send — single-recipient failure', () => {
  // The write-fails-loudly half of the degraded-socialsvc design: the operator must not be told the
  // compensation mail was delivered, and no mail_new may be pushed for a mail that does not exist.
  it('socialsvc unreachable → ok:false, recipientCount 0, no push', async () => {
    const { app, gateway } = buildMail({ accounts: [{ _id: 'a', publicId: '123456789' }], socialsvcDown: true });
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'single.fail', subject: 'Sorry', target: { publicId: '123456789' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, recipientCount: 0, error: 'socialsvc not configured' });
    expect(gateway.pushed).toHaveLength(0);
  });

  it('non-string accountId falls back to publicId resolution rather than being sent as the recipient', async () => {
    const { app, socialsvc } = buildMail({ accounts: [{ _id: 'a', publicId: '123456789' }] });
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'coerce.1', subject: 'Hi', accountId: 12345, target: { publicId: '123456789' } },
    });
    expect(res.statusCode).toBe(200);
    expect((socialsvc as FakeSocialsvc).mail.has('coerce.1:a')).toBe(true);
  });

  it('missing subject with a dispatchKey present → 400 (both halves of the guard)', async () => {
    const { app } = buildMail();
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: { dispatchKey: 'no.subject' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'dispatchKey + subject required' });
  });
});

// ── accounts ────────────────────────────────────────────────────────────────────────────────────────
function buildAccounts(accountsSeed: AccountDoc[] = [], savesSeed: SaveDocRow[] = []) {
  const accounts = new FakeCollection<AccountDoc>().seed(...accountsSeed);
  const saves = new FakeCollection<SaveDocRow>().seed(...savesSeed);
  const ctx: InternalCtx = {
    cols: { accounts, saves } as unknown as Collections,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerAccountRoutes(app, ctx);
  return { app, accounts, saves };
}

describe('accountRoutes — missing required query parameters', () => {
  // Each of these is the gateway/admin backend calling with an empty field. A 400 naming the parameter
  // is the difference between an operator fixing their request and reading an empty result as "no such
  // player"; /internal/elo in particular would otherwise answer INITIAL_ELO for the *absent* account.
  it.each([
    ['/internal/elo', '/internal/elo'],
    ['/internal/elo with empty accountId', '/internal/elo?accountId='],
    ['/internal/social/friends', '/internal/social/friends'],
  ])('%s → 400 "accountId required"', async (_label, url) => {
    const { app } = buildAccounts();
    const res = await app.inject({ method: 'GET', url, headers: authHeaders });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'accountId required' });
  });

  it('/internal/players/search without q → 400 "q required"', async () => {
    const { app } = buildAccounts();
    for (const url of ['/internal/players/search', '/internal/players/search?q=', '/internal/players/search?limit=10']) {
      const res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'q required' });
    }
  });

  it('/internal/elo with an accountId but no save → INITIAL_ELO, seasonPeakElo mirrors it', async () => {
    const { app } = buildAccounts();
    const res = await app.inject({ method: 'GET', url: '/internal/elo?accountId=ghost', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ elo: INITIAL_ELO, seasonPeakElo: INITIAL_ELO });
  });
});

describe('GET /internal/player — cosmetic fields present', () => {
  // `...(profile.avatarId ? … : {})` and `...(profile.equippedSkins?.length ? … : {})`: no existing test
  // equips an avatar or a character skin, so the *present* side of both spreads was never taken — i.e.
  // the admin Player Lookup panel's avatar/skin columns were never shown to be populated at all.
  it('equipped avatar + character skins are surfaced in the lookup payload', async () => {
    const row = saveRow('a');
    row.save.equipped = { ...row.save.equipped, avatar: 'avatar_7', 'skin:archer': 'skin_e1', 'skin:mage': 'skin_m2' };
    const { app } = buildAccounts([{ _id: 'a', publicId: '123456789', displayName: 'Alice' }], [row]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.avatarId).toBe('avatar_7');
    expect(body.equippedSkins).toEqual(['skin_e1', 'skin_m2']);
  });

  it('no avatar and no skin slots → both keys are omitted rather than sent as null/[]', async () => {
    const { app } = buildAccounts([{ _id: 'a', publicId: '123456789', displayName: 'Alice' }], [saveRow('a')]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789', headers: authHeaders });
    const body = JSON.parse(res.payload);
    expect(body).not.toHaveProperty('avatarId');
    expect(body).not.toHaveProperty('equippedSkins');
  });
});

// ── ladder ──────────────────────────────────────────────────────────────────────────────────────────
function buildLadder(opts: { saves?: SaveDocRow[]; seasonsBroken?: boolean; savesBroken?: boolean; season?: LadderSeasonDoc } = {}) {
  const saves = (opts.savesBroken ? new BrokenCollection<SaveDocRow>() : new FakeCollection<SaveDocRow>())
    .seed(...(opts.saves ?? []));
  const ladderSeasons = opts.seasonsBroken
    ? new BrokenCollection<LadderSeasonDoc & { _id: string }>()
    : new FakeCollection<LadderSeasonDoc & { _id: string }>();
  if (opts.season) ladderSeasons.seed(opts.season);
  const cols = {
    saves,
    accounts: new FakeCollection<AccountDoc>(),
    ladderSeasons,
    ladderSeasonSnapshots: new FakeCollection<{ _id: string }>(),
  } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 5000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new FakeSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerLadderRoutes(app, ctx);
  return { app, saves };
}

describe('ladderRoutes — dependency failures behind the catch blocks', () => {
  // Season roll is the one irreversible ops action on this router. When the season store is unreachable
  // the operator must see a 500 "roll failed" — never a 200 that would make them believe the season
  // advanced (and stop them from retrying once storage recovers).
  it('POST /admin/ladder/season/roll with the season store unreachable → 500 "roll failed"', async () => {
    const { app } = buildLadder({ seasonsBroken: true });
    const res = await app.inject({ method: 'POST', url: '/admin/ladder/season/roll', headers: authHeaders });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'roll failed' });
  });

  // Title grant is called from worldsvc's own season settlement, which retries on non-2xx: a 500 here
  // (rather than a swallowed ok:true) is what makes that retry happen at all.
  it('POST /internal/title/grant with the save store unreachable → 500 "grant failed"', async () => {
    const { app } = buildLadder({ savesBroken: true });
    const res = await app.inject({
      method: 'POST', url: '/internal/title/grant', headers: authHeaders,
      payload: { accountId: 'a', titleId: 'slg.s1.champion' },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'grant failed' });
  });

  it.each([
    ['accountId only', { accountId: 'a' }],
    ['titleId only', { titleId: 'slg.s1.champion' }],
    ['empty strings', { accountId: '', titleId: '' }],
  ])('POST /internal/title/grant with %s → 400', async (_label, payload) => {
    const { app } = buildLadder();
    const res = await app.inject({ method: 'POST', url: '/internal/title/grant', headers: authHeaders, payload });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'accountId + titleId required' });
  });
});
