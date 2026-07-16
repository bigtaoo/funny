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
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[socialsvc.mailHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc mail HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  const token = signToken('a', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}` };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.mails.deleteMany({});
    const meta = new FakeMeta().add('a', 'P-A', 'Alice');
    const gateway = new FakeGateway();
    const familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.collections.mails.deleteMany({});
    await m.close();
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
});
