// socialsvc mail HTTP route e2e (real node:http server + real Mongo, mirrors worldsvc's httpApi.e2e.test.ts).
// Covers the wire-level behavior the service-level mail.e2e.test.ts can't: actual status codes +
// error-code JSON body for DELETE /mail/{id}, in particular the 16.07.2026 unclaimed-attachment guard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken } from '@nw/shared';
import { createSocialMongo, type SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { FakeMeta, FakeGateway } from './harness';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_mail_http_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';

async function tryConnect(): Promise<SocialMongo | null> {
  try {
    const m = await createSocialMongo(URI, DB);
    await m.collections.mails.estimatedDocumentCount();
    return m;
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[socialsvc.mailHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc mail HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let gateway: FakeGateway;
  const token = signToken('a', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}` };
  const bAuth = { authorization: `Bearer ${signToken('b', { secret: SECRET })}` };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.mails.deleteMany({});
    const meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob');
    gateway = new FakeGateway();
    const familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.collections.mails.deleteMany({});
    // Note: does NOT close `m` — the second describe block below (internal mail routes) reuses the
    // same shared `mongo` connection; only its own afterAll closes it.
  });

  it('no token → 401', async () => {
    const r = await fetch(`${base}/social/mail/whatever`, { method: 'DELETE' });
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('DELETE /mail/{id}: unclaimed attachment → 409 MAIL_HAS_UNCLAIMED_ATTACHMENT, mail survives', async () => {
    await m.collections.mails.insertOne({
      _id: 'gift:a', to: 'a', from: 'system', fromName: 'System',
      subject: 'Loot', body: 'grab it', attachments: [{ kind: 'coins', count: 100 }],
      createdAt: t, expireAt: new Date(t + 999_999_999),
    });

    const r = await fetch(`${base}/social/mail/gift:a`, { method: 'DELETE', headers: auth });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('MAIL_HAS_UNCLAIMED_ATTACHMENT');
    expect(await m.collections.mails.countDocuments({ _id: 'gift:a' })).toBe(1);
  });

  it('DELETE /mail/{id}: claiming first, then deleting → 200 ok, mail removed', async () => {
    // Attachment delivery is a metaserver-orchestrated flow; there's no public /mail/{id}/claim
    // route in socialsvc itself — go through the internal endpoint metaserver calls directly.
    const claimRes = await fetch(`${base}/internal/mail/gift:a/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify({ accountId: 'a', orderId: 'order-1' }),
    });
    expect(claimRes.status).toBe(200);

    const r = await fetch(`${base}/social/mail/gift:a`, { method: 'DELETE', headers: auth });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ ok: true });
    expect(await m.collections.mails.countDocuments({ _id: 'gift:a' })).toBe(0);
  });

  it('DELETE /mail/{id}: mail without an attachment deletes normally', async () => {
    await m.collections.mails.insertOne({
      _id: 'plain:a', to: 'a', from: 'system', fromName: 'System',
      subject: 'Hello', body: 'hi', createdAt: t, expireAt: new Date(t + 999_999_999),
    });
    const r = await fetch(`${base}/social/mail/plain:a`, { method: 'DELETE', headers: auth });
    expect(r.status).toBe(200);
    expect(await m.collections.mails.countDocuments({ _id: 'plain:a' })).toBe(0);
  });

  it('GET /social/mail: lists the caller\'s mail', async () => {
    await m.collections.mails.insertOne({
      _id: 'list:a', to: 'a', from: 'system', fromName: 'System',
      subject: 'Listed', body: 'hi', createdAt: t, expireAt: new Date(t + 999_999_999),
    });
    const r = await fetch(`${base}/social/mail`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect((body.data.mail as Array<{ mailId: string }>).some((mm) => mm.mailId === 'list:a')).toBe(true);
  });

  it('POST /social/mail/{id}/read: marks read; unknown id -> 404 NOT_FOUND', async () => {
    await m.collections.mails.insertOne({
      _id: 'read:a', to: 'a', from: 'system', fromName: 'System',
      subject: 'ReadMe', body: 'hi', createdAt: t, expireAt: new Date(t + 999_999_999),
    });
    const ok = await fetch(`${base}/social/mail/read:a/read`, { method: 'POST', headers: auth });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual({ ok: true });

    const missing = await fetch(`${base}/social/mail/does-not-exist/read`, { method: 'POST', headers: auth });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  describe('POST /social/mail/send', () => {
    it('missing toPublicId/subject -> 400', async () => {
      const noTarget = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 's' }),
      });
      expect(noTarget.status).toBe(400);
      const noSubject = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ toPublicId: 'P-B' }),
      });
      expect(noSubject.status).toBe(400);
    });

    it('target publicId not found -> 404 NOT_FOUND', async () => {
      const r = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ toPublicId: 'no-such-public-id', subject: 's' }),
      });
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('NOT_FOUND');
    });

    it('not friends with the target -> 403 NOT_FRIEND', async () => {
      const r = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ toPublicId: 'P-B', subject: 's' }),
      });
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe('NOT_FRIEND');
    });

    it('friends -> sends successfully, recipient can read it', async () => {
      await m.collections.friendEdges.insertOne({ _id: 'a:b', owner: 'a', friend: 'b', since: t });
      const r = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ toPublicId: 'P-B', subject: 'Hi Bob', body: 'How are you?' }),
      });
      expect(r.status).toBe(200);
      const mailId = (await r.json()).data.mailId as string;
      expect(typeof mailId).toBe('string');

      const inbox = await (await fetch(`${base}/social/mail`, { headers: bAuth })).json();
      expect((inbox.data.mail as Array<{ subject: string }>).some((mm) => mm.subject === 'Hi Bob')).toBe(true);
    });
  });
});

describe.skipIf(!mongo)('socialsvc internal mail HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let gateway: FakeGateway;
  let t2 = 5_000_000;

  beforeAll(async () => {
    await m.collections.mails.deleteMany({});
    const meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob');
    gateway = new FakeGateway();
    const familySvc = new FamilyService({ cols: m.collections, now: () => t2, gateway, meta });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t2 });
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t2 });
    server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY }, familySvc, friendSvc, mailSvc, gateway, meta);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await m.collections.mails.deleteMany({});
    await m.close();
  });

  const internalAuth = { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY };

  it('POST /internal/mail/:id/claim: missing accountId/orderId -> 400', async () => {
    const r = await fetch(`${base}/internal/mail/whatever/claim`, { method: 'POST', headers: internalAuth, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  it('POST /internal/mail/:id/claim: unknown mail -> 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/internal/mail/no-such-mail/claim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o1' }),
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe('NOT_FOUND');
  });

  it('POST /internal/mail/:id/claim: mail with no attachment -> NO_ATTACHMENT', async () => {
    await m.collections.mails.insertOne({
      _id: 'noatt:a', to: 'a', from: 'system', fromName: 'System', subject: 'x', body: 'y', createdAt: t2, expireAt: new Date(t2 + 999_999_999),
    });
    const r = await fetch(`${base}/internal/mail/noatt:a/claim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o1' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('NO_ATTACHMENT');
  });

  it('POST /internal/mail/:id/claim: already claimed -> ALREADY_CLAIMED', async () => {
    await m.collections.mails.insertOne({
      _id: 'gift:double', to: 'a', from: 'system', fromName: 'System', subject: 'x', body: 'y',
      attachments: [{ kind: 'coins', count: 10 }], createdAt: t2, expireAt: new Date(t2 + 999_999_999),
    });
    const first = await fetch(`${base}/internal/mail/gift:double/claim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o1' }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/internal/mail/gift:double/claim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o2' }),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('ALREADY_CLAIMED');
  });

  it('POST /internal/mail/:id/unclaim: missing accountId/orderId -> 400; success rolls the claim back', async () => {
    await m.collections.mails.insertOne({
      _id: 'gift:unclaim', to: 'a', from: 'system', fromName: 'System', subject: 'x', body: 'y',
      attachments: [{ kind: 'coins', count: 10 }], createdAt: t2, expireAt: new Date(t2 + 999_999_999),
    });
    await fetch(`${base}/internal/mail/gift:unclaim/claim`, { method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o1' }) });

    const bad = await fetch(`${base}/internal/mail/gift:unclaim/unclaim`, { method: 'POST', headers: internalAuth, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/internal/mail/gift:unclaim/unclaim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o1' }),
    });
    expect(ok.status).toBe(200);

    // Rolled back -> claimable again.
    const reclaim = await fetch(`${base}/internal/mail/gift:unclaim/claim`, {
      method: 'POST', headers: internalAuth, body: JSON.stringify({ accountId: 'a', orderId: 'o2' }),
    });
    expect(reclaim.status).toBe(200);
  });

  it('POST /internal/mail/system: missing fields -> 400; success inserts a single system mail', async () => {
    const bad = await fetch(`${base}/internal/mail/system`, { method: 'POST', headers: internalAuth, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/internal/mail/system`, {
      method: 'POST', headers: internalAuth,
      body: JSON.stringify({ dispatchKey: 'dk-1', to: 'a', content: { subject: 'Gift', body: 'Enjoy!', expireDays: 30 } }),
    });
    expect(ok.status).toBe(200);
    const inbox = await (await fetch(`${base}/social/mail`, { headers: { authorization: `Bearer ${signToken('a', { secret: SECRET })}` } })).json();
    expect((inbox.data.mail as Array<{ subject: string }>).some((mm) => mm.subject === 'Gift')).toBe(true);
  });

  it('POST /internal/mail/system/bulk: missing fields -> 400; success fans out + pushes mail_new to each recipient', async () => {
    const bad = await fetch(`${base}/internal/mail/system/bulk`, { method: 'POST', headers: internalAuth, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/internal/mail/system/bulk`, {
      method: 'POST', headers: internalAuth,
      body: JSON.stringify({ dispatchKey: 'dk-bulk-1', accountIds: ['a', 'b'], content: { subject: 'Bulk Gift', body: 'Enjoy!', expireDays: 30 } }),
    });
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // the push itself is fire-and-forget (void gateway.pushBatch(...))
    expect(gateway.ofKind('mail_new').length).toBeGreaterThanOrEqual(2);
  });
});
