// Route-level tests for internal/mailRoutes.ts: /internal/mail/system/{preview,send} (S6-3, OPS_DESIGN §3.3).
// Uses Fastify inject + in-memory fake cols/socialsvc (no Mongo) — same style as internal.test.ts.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Collections } from '@nw/shared';
import { registerMailRoutes } from '../src/internal/mailRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

interface AccountDoc { _id: string; publicId?: string }

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function build(seedAccounts: AccountDoc[] = []) {
  const accounts = new FakeCollection<AccountDoc>().seed(...seedAccounts);
  const cols = { accounts } as unknown as Collections;
  const socialsvc = new FakeSocialsvc();
  const gateway = fakeGateway() as ReturnType<typeof fakeGateway> & { pushed: { accountId: string; payload: unknown }[] };
  const ctx: InternalCtx = {
    cols,
    now: () => 1000,
    gateway,
    commercial: fakeCommercial(),
    socialsvc,
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerMailRoutes(app, ctx);
  return { app, accounts, socialsvc, gateway };
}

const mailBody = (extra: Record<string, unknown> = {}) => ({
  dispatchKey: 'comp.ticket.1',
  subject: 'Sorry for the trouble',
  body: 'Here is a make-good gift.',
  attachments: [{ kind: 'coins', count: 500 }],
  expireDays: 7,
  ...extra,
});

describe('POST /internal/mail/system/preview', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/mail/system/preview', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('scope=global → recipientCount = total accounts', async () => {
    const { app } = build([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/preview', headers: authHeaders,
      payload: { scope: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 3 });
  });

  it('single target found by publicId → recipientCount 1', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789' }]);
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/preview', headers: authHeaders,
      payload: { target: { publicId: '123456789' } },
    });
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 1 });
  });

  it('single target not found → recipientCount 0', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/preview', headers: authHeaders,
      payload: { target: { publicId: '000000000' } },
    });
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 0 });
  });
});

describe('POST /internal/mail/system/send', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/mail/system/send', payload: mailBody() });
    expect(res.statusCode).toBe(401);
  });

  it('missing dispatchKey/subject → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/mail/system/send', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('single target by publicId → inserts mail + pushes mail_new', async () => {
    const { app, socialsvc, gateway } = build([{ _id: 'a', publicId: '123456789' }]);
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: mailBody({ target: { publicId: '123456789' } }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({ ok: true, recipientCount: 1 });
    expect(socialsvc.mail.size).toBe(1);
    expect(gateway.pushed).toHaveLength(1);
    expect(gateway.pushed[0]).toMatchObject({ accountId: 'a', payload: { kind: 'mail_new' } });
  });

  it('single target not found → ok:false, recipientCount 0, no push', async () => {
    const { app, gateway } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: mailBody({ target: { publicId: '000000000' } }),
    });
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(false);
    expect(body.recipientCount).toBe(0);
    expect(gateway.pushed).toHaveLength(0);
  });

  it('direct accountId delivery (§17.5 internal callers like worldsvc) bypasses publicId resolution', async () => {
    const { app, socialsvc } = build(); // no accounts seeded — direct accountId path must not need one
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: mailBody({ accountId: 'worldsvc-acct', dispatchKey: 'season.reward.1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 1 });
    expect(socialsvc.mail.has('season.reward.1:worldsvc-acct')).toBe(true);
  });

  it('idempotent dispatchKey: resending the same single mail does not duplicate (inserted:false → no second push)', async () => {
    const { app, socialsvc, gateway } = build([{ _id: 'a', publicId: '123456789' }]);
    const payload = mailBody({ target: { publicId: '123456789' } });
    await app.inject({ method: 'POST', url: '/internal/mail/system/send', headers: authHeaders, payload });
    await app.inject({ method: 'POST', url: '/internal/mail/system/send', headers: authHeaders, payload });
    expect(socialsvc.mail.size).toBe(1);
    expect(gateway.pushed).toHaveLength(1); // second send was a no-op insert → no duplicate push
  });

  it('scope=global fans out to every account and pushes nothing itself (socialsvc pushes on insert)', async () => {
    const { app, socialsvc } = build([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
    const res = await app.inject({
      method: 'POST', url: '/internal/mail/system/send', headers: authHeaders,
      payload: mailBody({ scope: 'global', dispatchKey: 'event.season1.reward' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, recipientCount: 3 });
    expect(socialsvc.mail.size).toBe(3);
  });

  it('scope=global is idempotent per dispatchKey (resend does not duplicate mail)', async () => {
    const { app, socialsvc } = build([{ _id: 'a' }, { _id: 'b' }]);
    const payload = mailBody({ scope: 'global', dispatchKey: 'event.season1.reward' });
    await app.inject({ method: 'POST', url: '/internal/mail/system/send', headers: authHeaders, payload });
    await app.inject({ method: 'POST', url: '/internal/mail/system/send', headers: authHeaders, payload });
    expect(socialsvc.mail.size).toBe(2);
  });
});
