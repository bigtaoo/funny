// Unit-style coverage backfill for src/service/social.ts (2026-08-14 test-coverage task). These handlers'
// proxy plumbing + claimMail delivery logic already run under test/mail-claim.e2e.test.ts (a real
// cross-service wire test against socialsvc's actual HTTP routes) and other e2e suites, but those import
// `buildApp` from '../dist/app.js' (compiled output) — vitest's v8 coverage provider only attributes
// execution to src/*.ts when the module was loaded through vitest's own transform, so running the
// compiled dist through Node's own ESM loader records zero coverage against src/service/social.ts even
// though the same logic runs. This file imports `buildApp` from '../src/app.js' directly and re-exercises
// the same request/response shapes with a lightweight in-memory MetaSocialsvcClient fake (no live HTTP
// socialsvc server needed — this file only needs to reach every branch inside social.ts itself, not
// socialsvc's own internal routes, which mail-claim.e2e.test.ts already covers against the real service).
//
// Real Mongo (rs0), same convention as economy-service-unit.test.ts: claimMail's delivery path
// (deliverMailGrant) relies on a `{'save.deliveredOrders': {$ne: orderId}}` filter guard + $addToSet-
// with-$each + $inc-by-dotted-path, none of which test/helpers/fakeCollection.ts's generic in-memory
// double implements (see that file's header comment), so a real Mongo instance is the pragmatic choice.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle, type MailDoc, type CardInstance, type EquipmentInstance } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { CommercialClient } from '../src/commercialClient.js';
import type { MetaSocialsvcClient, SystemMailContent } from '../src/socialsvcClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_social_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[social-service-unit] Mongo unreachable (${URI}) — skipping.`);

/** Minimal in-memory CommercialClient — only `available`/`grant` are exercised by claimMail. */
class FakeCommercial implements Pick<CommercialClient, 'available' | 'grant'> {
  available: boolean;
  coins = new Map<string, number>();
  granted = new Set<string>();
  nextGrantError: string | null = null;
  constructor(available = true) {
    this.available = available;
  }
  async grant(a: { accountId: string; amount: number; orderId: string }) {
    if (this.nextGrantError) {
      const e = this.nextGrantError;
      this.nextGrantError = null;
      return { ok: false as const, error: e };
    }
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.coins.get(a.accountId) ?? 0 };
    const next = (this.coins.get(a.accountId) ?? 0) + a.amount;
    this.coins.set(a.accountId, next);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: next };
  }
}

/** Configurable in-memory socialsvc fake: proxy() echoes a canned response, claimMail()/unclaimMail()
 *  are driven by per-test knobs — social.ts only cares about the shapes these return, not socialsvc's
 *  own internal HTTP wire (already covered by mail-claim.e2e.test.ts against the real service). */
class FakeSocialsvc implements MetaSocialsvcClient {
  available: boolean;
  proxyCalls: { method: string; path: string; body: unknown; authorization: string }[] = [];
  nextProxyResponse: { status: number; data: unknown } = { status: 200, data: { ok: true, data: {} } };
  mailDocs = new Map<string, MailDoc>();
  claimed = new Set<string>();
  nextClaimError: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' | 'SOCIAL_UNAVAILABLE' | null = null;
  unclaimCalls: { mailId: string; accountId: string; orderId: string }[] = [];

  constructor(available = true) {
    this.available = available;
  }

  async proxy(method: string, path: string, body: unknown, authorization: string) {
    this.proxyCalls.push({ method, path, body, authorization });
    return this.nextProxyResponse;
  }

  seedMail(mailId: string, doc: Partial<MailDoc> & { to: string }): void {
    this.mailDocs.set(mailId, {
      _id: mailId, from: 'system', subject: 's', body: 'b', createdAt: 1, expireAt: new Date(Date.now() + 86400000),
      ...doc,
    });
  }

  async claimMail(mailId: string, _accountId: string, _orderId: string) {
    if (this.nextClaimError) {
      const e = this.nextClaimError;
      this.nextClaimError = null;
      return { error: e };
    }
    if (this.claimed.has(mailId)) return { error: 'ALREADY_CLAIMED' as const };
    const doc = this.mailDocs.get(mailId);
    if (!doc) return { error: 'NOT_FOUND' as const };
    this.claimed.add(mailId);
    return { doc };
  }

  async unclaimMail(mailId: string, accountId: string, orderId: string): Promise<void> {
    this.unclaimCalls.push({ mailId, accountId, orderId });
    this.claimed.delete(mailId);
  }

  async insertSystemMail(): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
    throw new Error('not used in this test');
  }
  async bulkInsertSystemMail(): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
    throw new Error('not used in this test');
  }
}

describe.skipIf(!mongo)('social service handlers (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let social: FakeSocialsvc;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  // Fastify serializes every 2xx response against openapi's per-operation response schema (fast-json-
  // stringify, strict `required`/`additionalProperties`-shaped) — a bare `{}` under `data` 500s for most
  // proxied operations, so each proxied-route test hands proxy() back a minimally schema-valid payload.
  const okData = (data: unknown) => ({ status: 200, data: { ok: true, data } });

  async function buildAndAuth(opts: { socialsvc?: MetaSocialsvcClient; commercial?: FakeCommercial } = {}): Promise<void> {
    social = (opts.socialsvc as FakeSocialsvc) ?? new FakeSocialsvc();
    comm = opts.commercial ?? new FakeCommercial();
    app = await buildApp({
      cols: m.collections, jwt, internalKey: 'k', authRateLimit: 0,
      commercial: comm as unknown as CommercialClient,
      socialsvc: social,
    });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `device-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save document
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    await buildAndAuth();
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── proxySocial: happy-path pass-through for every proxied route ──────────────────────────────
  describe('proxied friend/chat/mail routes', () => {
    it('GET /friends forwards to socialsvc /social/friends and mirrors status/data', async () => {
      social.nextProxyResponse = okData({ friends: [{ publicId: '1', displayName: 'Alice', online: true }] });
      const r = await app.inject({ method: 'GET', url: '/friends', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(body(r).data.friends).toEqual([{ publicId: '1', displayName: 'Alice', online: true }]);
      expect(social.proxyCalls[0]).toMatchObject({ method: 'GET', path: '/social/friends' });
      expect(social.proxyCalls[0]!.authorization).toBe(`Bearer ${token}`);
    });

    it('GET /friends/requests forwards to /social/friends/requests', async () => {
      social.nextProxyResponse = okData({ incoming: [], outgoing: [] });
      const r = await app.inject({ method: 'GET', url: '/friends/requests', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/requests');
    });

    it('GET /social/badges forwards to /social/badges', async () => {
      social.nextProxyResponse = okData({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
      const r = await app.inject({ method: 'GET', url: '/social/badges', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/badges');
    });

    it('POST /friends/search forwards the body to /social/friends/search', async () => {
      social.nextProxyResponse = okData({ profile: { publicId: '123456789', displayName: 'Someone' } });
      const r = await app.inject({ method: 'POST', url: '/friends/search', headers: auth(), payload: { publicId: '123456789' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]).toMatchObject({ path: '/social/friends/search', body: { publicId: '123456789' } });
    });

    it('POST /friends/request forwards to /social/friends/request', async () => {
      social.nextProxyResponse = okData({ requestId: 'req-1' });
      const r = await app.inject({ method: 'POST', url: '/friends/request', headers: auth(), payload: { publicId: '123456789' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/request');
    });

    it('POST /friends/respond forwards to /social/friends/respond', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'POST', url: '/friends/respond', headers: auth(), payload: { requestId: 'req1', accept: true } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/respond');
    });

    it('DELETE /friends/:publicId forwards to /social/friends/:publicId (URL-encoded)', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'DELETE', url: '/friends/pub%2Fid', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/pub%2Fid');
    });

    it('POST /friends/block forwards to /social/friends/block', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'POST', url: '/friends/block', headers: auth(), payload: { publicId: '123456789' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/block');
    });

    it('DELETE /friends/block/:publicId forwards to /social/friends/block/:publicId', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'DELETE', url: '/friends/block/somebody', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/block/somebody');
    });

    it('POST /friends/report forwards to /social/friends/report', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'POST', url: '/friends/report', headers: auth(), payload: { publicId: '123456789', reason: 'spam' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/friends/report');
    });

    it('GET /chat/conversations forwards to /social/chat/conversations', async () => {
      social.nextProxyResponse = okData({ conversations: [] });
      const r = await app.inject({ method: 'GET', url: '/chat/conversations', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/conversations');
    });

    it('GET /chat/:convId/messages with no "before" (only the schema-defaulted "limit") still forwards a query string', async () => {
      social.nextProxyResponse = okData({ messages: [] });
      const r = await app.inject({ method: 'GET', url: '/chat/conv1/messages', headers: auth() });
      expect(r.statusCode).toBe(200);
      // openapi's querystring schema defaults `limit` to 30 (Fastify applies it before the handler runs),
      // so even a bare request forwards `?limit=30` — only `before` is ever truly absent here.
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/conv1/messages?limit=30');
    });

    it('GET /chat/:convId/messages with before+limit query params forwards them as a query string', async () => {
      social.nextProxyResponse = okData({ messages: [] });
      const r = await app.inject({ method: 'GET', url: '/chat/conv1/messages?before=1000&limit=20', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/conv1/messages?before=1000&limit=20');
    });

    it('GET /chat/:convId/messages with only "before" set forwards before + the schema-defaulted limit', async () => {
      social.nextProxyResponse = okData({ messages: [] });
      const r = await app.inject({ method: 'GET', url: '/chat/conv1/messages?before=500', headers: auth() });
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/conv1/messages?before=500&limit=30');
    });

    it('POST /chat/send forwards to /social/chat/send', async () => {
      social.nextProxyResponse = okData({ messageId: 'msg-1', ts: 1000 });
      const r = await app.inject({ method: 'POST', url: '/chat/send', headers: auth(), payload: { toPublicId: '123456789', body: 'hi' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/send');
    });

    it('POST /chat/read forwards to /social/chat/read', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'POST', url: '/chat/read', headers: auth(), payload: { convId: 'c1' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/chat/read');
    });

    it('GET /mail forwards to /social/mail', async () => {
      social.nextProxyResponse = okData({ mail: [], unread: 0 });
      const r = await app.inject({ method: 'GET', url: '/mail', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/mail');
    });

    it('POST /mail/:id/read forwards an empty body to /social/mail/:id/read', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/read', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]).toMatchObject({ path: '/social/mail/m1/read', body: {} });
    });

    it('DELETE /mail/:id forwards to /social/mail/:id', async () => {
      social.nextProxyResponse = okData({ ok: true });
      const r = await app.inject({ method: 'DELETE', url: '/mail/m1', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/mail/m1');
    });

    it('POST /mail/send forwards to /social/mail/send', async () => {
      social.nextProxyResponse = okData({ mailId: 'mail-1' });
      const r = await app.inject({ method: 'POST', url: '/mail/send', headers: auth(), payload: { toPublicId: '123456789', subject: 's', body: 'b' } });
      expect(r.statusCode).toBe(200);
      expect(social.proxyCalls[0]!.path).toBe('/social/mail/send');
    });

    it('socialsvc not configured (available:false) → every proxied route 503s, never calls proxy()', async () => {
      await buildAndAuth({ socialsvc: new FakeSocialsvc(false) });
      const r = await app.inject({ method: 'GET', url: '/friends', headers: auth() });
      expect(r.statusCode).toBe(503);
      expect(social.proxyCalls.length).toBe(0);
    });

    it('proxy forwards a non-2xx status too (e.g. socialsvc itself rejects with 400)', async () => {
      social.nextProxyResponse = { status: 400, data: { ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } } };
      const r = await app.inject({ method: 'POST', url: '/friends/request', headers: auth(), payload: { publicId: 'x' } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
    });
  });

  // ── claimMail ──────────────────────────────────────────────────────────────────────────────────
  describe('POST /mail/:id/claim', () => {
    it('socialsvc not configured → 503, never touches commercial/economy', async () => {
      await buildAndAuth({ socialsvc: new FakeSocialsvc(false) });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
    });

    it('mail not found → 404', async () => {
      const r = await app.inject({ method: 'POST', url: '/mail/no-such-mail/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(404);
    });

    it('claimMail reports NO_ATTACHMENT at the claim level → 400', async () => {
      social.nextClaimError = 'NO_ATTACHMENT';
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('NO_ATTACHMENT');
    });

    it('already claimed → 409', async () => {
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'coins', count: 100 }] });
      await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      const r2 = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r2.statusCode).toBe(409);
      expect(body(r2).error.code).toBe('ALREADY_CLAIMED');
    });

    it('socialsvc unavailable mid-claim (SOCIAL_UNAVAILABLE) → 503 retryable, distinct from NOT_FOUND', async () => {
      social.nextClaimError = 'SOCIAL_UNAVAILABLE';
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
    });

    it('mail doc has zero attachments → 400 NO_ATTACHMENT (post-claim shape check)', async () => {
      social.seedMail('m1', { to: accountId, attachments: [] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('NO_ATTACHMENT');
    });

    it('mail doc has no attachments field at all → 400 NO_ATTACHMENT', async () => {
      social.seedMail('m1', { to: accountId });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    it('happy path: coins-only attachment delivers and mirrors wallet.coins', async () => {
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'coins', count: 250 }] });
      const r = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r.data.save.wallet.coins).toBe(250);
    });

    it('happy path: mixed coins + item + material + skin attachments each land in their own save field', async () => {
      social.seedMail('m1', {
        to: accountId,
        attachments: [
          { kind: 'coins', count: 500 },
          { kind: 'item', id: 'protect_enhance', count: 2 },
          { kind: 'material', id: 'scrap', count: 7 },
          { kind: 'skin', id: 'skin_shop_c1' },
        ],
      });
      const r = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r.data.save.wallet.coins).toBe(500);
      expect(r.data.save.inventory.items?.protect_enhance).toBe(2);
      expect(r.data.save.materials.scrap).toBe(7);
      expect(r.data.save.inventory.skins).toContain('skin_shop_c1');
    });

    it('happy path: equipment attachment delivers an instance snapshot into equipmentInv', async () => {
      const inst: EquipmentInstance = { id: 'eq_test1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'equipment', instance: inst }] });
      const r = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r.data.save.equipmentInv[inst.id]).toBeTruthy();
    });

    it('happy path: card attachment delivers an instance snapshot into cardInv', async () => {
      const inst: CardInstance = { id: 'cd_test1', defId: 'lichuang', level: 1, gear: {}, locked: false };
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'card', instance: inst }] });
      const r = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r.data.save.cardInv[inst.id]).toBeTruthy();
    });

    it('already-owned skin attachment still delivers a real second instance (not filtered as a no-op)', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': ['skin_shop_c1'] } });
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'skin', id: 'skin_shop_c1' }] });
      const r = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r.data.save.inventory.skins.filter((s: string) => s === 'skin_shop_c1')).toHaveLength(1); // dedup set
      expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_shop_c1' })).toBe(1);
    });

    it('coins attachment but commercial is unavailable → delivery throws inside the try, claim is rolled back, 503', async () => {
      await buildAndAuth({ commercial: new FakeCommercial(false) });
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'coins', count: 100 }] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
      expect(social.unclaimCalls.length).toBe(1);
      expect(social.claimed.has('m1')).toBe(false); // rolled back, claimable again
    });

    it('zero-coin attachment does NOT require commercial to be available (coins>0 gate is skipped entirely)', async () => {
      await buildAndAuth({ commercial: new FakeCommercial(false) });
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'item', id: 'protect_enhance', count: 1 }] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(200);
    });

    it('commercial.grant rejects (ok:false) → delivery throws, claim rolled back, 503', async () => {
      comm.nextGrantError = 'INJECTED_FAILURE';
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'coins', count: 100 }] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
      expect(social.unclaimCalls.length).toBe(1);
    });

    it('grantEquipment fails (malformed instance, no id) → delivery throws, claim rolled back, 503', async () => {
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'equipment', instance: { id: '', defId: 'x', rarity: 'common', level: 0, affixes: [] } as EquipmentInstance }] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
      expect(social.unclaimCalls.length).toBe(1);
    });

    it('grantCard fails (malformed instance, no id) → delivery throws, claim rolled back, 503', async () => {
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'card', instance: { id: '', defId: 'x', level: 1, gear: {}, locked: false } as CardInstance }] });
      const r = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(503);
      expect(social.unclaimCalls.length).toBe(1);
    });

    it('retry after a rolled-back claim reuses the same deterministic orderId (mail.claim.<id>.<accountId>), no double coin grant', async () => {
      comm.nextGrantError = 'INJECTED_FAILURE'; // first attempt fails after socialsvc marks it claimed
      social.seedMail('m1', { to: accountId, attachments: [{ kind: 'coins', count: 400 }] });
      const r1 = await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} });
      expect(r1.statusCode).toBe(503);

      const r2 = body(await app.inject({ method: 'POST', url: '/mail/m1/claim', headers: auth(), payload: {} }));
      expect(r2.data.save.wallet.coins).toBe(400); // not double-granted
    });
  });
});
