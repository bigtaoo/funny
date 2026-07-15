// Regression test: claiming an auction-returned/sold mail attachment over the REAL cross-service wire
// (metaserver HttpMetaSocialsvcClient -> real socialsvc internal HTTP routes -> real MailService, real Mongo).
//
// Bug this guards against (found 2026-07-12 via live-stack repro): socialsvc's mailId is `${dispatchKey}:${to}`.
// For auction mail, dispatchKey embeds the full auctionId (`a:{sellerId-uuid}:{ts}:{n}`), so the final mailId
// routinely exceeds 100 characters once `:to` (another UUID) is appended. Fastify's router (find-my-way)
// silently refuses to match a `:id` param longer than its default maxParamLength (100) — POST /mail/:id/claim
// 404s as "Route not found" before claimMail's handler ever runs, surfacing to players as a generic "claim
// failed" toast with no indication anything is wrong with the mail itself. Fixed by raising maxParamLength to
// 200 in app.ts. This test uses a full-length, production-shaped mailId (not a short synthetic one) so it
// actually exercises that limit.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import {
  createMongo, type JwtConfig, type MongoHandle, type CardInstance, type EquipmentInstance,
  ErrorCode, ok, err, loadInternalAuth,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../dist/commercialClient.js';
import { HttpMetaSocialsvcClient } from '../dist/socialsvcClient.js';
import { buildApp } from '../dist/app.js';
import { MailService } from '../../socialsvc/dist/mailService.js';
import { createSocialMongo, type SocialMongo } from '../../socialsvc/dist/db.js';

function makeFakeCommercial(): CommercialClient {
  const coins = new Map<string, number>();
  const granted = new Set<string>();
  return {
    available: true,
    async getWallet(id: string) { return { coins: coins.get(id) ?? 0, pity: {} }; },
    async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
      if (granted.has(a.orderId)) return { ok: true as const, coinsAfter: coins.get(a.accountId) ?? 0 };
      const next = (coins.get(a.accountId) ?? 0) + a.amount;
      coins.set(a.accountId, next);
      granted.add(a.orderId);
      return { ok: true as const, coinsAfter: next };
    },
  } as unknown as CommercialClient;
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const META_DB = 'nw_meta_mail_claim_test';
const SOCIAL_DB = 'nw_social_mail_claim_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const IK = 'k';

async function tryConnectMeta(): Promise<MongoHandle | null> {
  try { return await createMongo(URI, META_DB, { serverSelectionTimeoutMS: 1500 }); } catch { return null; }
}
async function tryConnectSocial(): Promise<SocialMongo | null> {
  try { return await createSocialMongo(URI, SOCIAL_DB); } catch { return null; }
}
const meta = await tryConnectMeta();
const social = await tryConnectSocial();
if (!meta || !social) console.warn('[mail-claim.e2e] Mongo unreachable — skipping.');

/** Minimal socialsvc internal HTTP shim: only /internal/mail/:id/claim (mirrors httpApi.ts's real handler 1:1). */
function startMinimalSocialInternal(mailSvc: MailService, internalKey: string): Server {
  const internalAuth = loadInternalAuth(internalKey);
  return createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const url = new URL(req.url ?? '', 'http://social');
      const path = url.pathname;
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (!internalAuth.verify(req.headers).ok) return send(401, err(ErrorCode.UNAUTHENTICATED, 'no key'));
      const m = /^\/internal\/mail\/([^/]+)\/claim$/.exec(path);
      if (req.method === 'POST' && m) {
        const mailId = decodeURIComponent(m[1]!);
        const result = await mailSvc.claimMailAtomic(body.accountId, mailId, body.orderId);
        if ('error' in result) {
          const code = result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND
            : result.error === 'ALREADY_CLAIMED' ? ErrorCode.ALREADY_CLAIMED : ErrorCode.NO_ATTACHMENT;
          return send(200, err(code, result.error));
        }
        return send(200, ok({ doc: result.doc }));
      }
      send(404, err(ErrorCode.NOT_FOUND, 'no route'));
    })();
  });
}

describe.skipIf(!meta || !social)('mail claim: real cross-service wire (metaserver -> real socialsvc HTTP -> real MailService)', () => {
  const m = meta!;
  const s = social!;
  let app: FastifyInstance;
  let socialServer: Server;
  let socialPort: number;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await Promise.all([m.db.dropDatabase(), s.collections.mails.deleteMany({})]);
    await m.ensureIndexes();
    if (app) await app.close();
    if (socialServer) await new Promise((r) => socialServer.close(r));

    const mailSvc = new MailService({
      cols: s.collections,
      gateway: { available: false, push: async () => {}, pushMany: async () => {}, presence: async () => ({}), invalidateFriends: async () => {} },
      meta: { available: false, resolveByPublicId: async () => null, batchProfiles: async () => new Map() },
      now: () => Date.now(),
    });
    socialServer = startMinimalSocialInternal(mailSvc, IK);
    await new Promise<void>((resolve) => socialServer.listen(0, '127.0.0.1', resolve));
    socialPort = (socialServer.address() as { port: number }).port;

    app = await buildApp({
      cols: m.collections, jwt, internalKey: IK, commercial: makeFakeCommercial(),
      socialsvc: new HttpMetaSocialsvcClient(`http://127.0.0.1:${socialPort}`, IK),
    });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `mail-claim-dev-${Math.random()}` } }));
    token = r.data.token; accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); if (socialServer) socialServer.close(); });

  it('production-length auction-returned card mail (dispatchKey embeds a full auctionId) → claim succeeds, not a route 404', async () => {
    const cardInstance: CardInstance = { id: 'cd_cross1', defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false };
    // Real shape from auctionService.ts: auctionId = `a:{sellerId-uuid}:{timestamp}:{counter}`,
    // dispatchKey = `auction_cancel:${auctionId}` / `auction_expire:${auctionId}`.
    const auctionId = `a:${accountId}:${1783867933347}:1`;
    const dispatchKey = `auction_cancel:${auctionId}`;
    // Mirrors exactly what metaserver's /internal/mail/system/send route does (insertSystemMail),
    // i.e. what auctionsvc's deliverItem ultimately causes to be written into socialsvc's `mails` collection.
    const mailSvc = new MailService({
      cols: s.collections,
      gateway: { available: false, push: async () => {}, pushMany: async () => {}, presence: async () => ({}), invalidateFriends: async () => {} },
      meta: { available: false, resolveByPublicId: async () => null, batchProfiles: async () => new Map() },
      now: () => Date.now(),
    });
    await mailSvc.insertSystemMail(dispatchKey, accountId, {
      subject: 'auction.mail.returned.subject',
      body: 'auction.mail.returned.body',
      attachments: [{ kind: 'card', instance: cardInstance }],
      expireDays: 30,
    });

    const mailId = `${dispatchKey}:${accountId}`;
    expect(mailId.length).toBeGreaterThan(100); // sanity: this test only proves what it claims to if the id is actually long
    const res = await app.inject({ method: 'POST', url: `/mail/${encodeURIComponent(mailId)}/claim`, headers: auth(), payload: {} });
    expect(res.statusCode).not.toBe(404); // would 404 "Route not found" with the default 100-char maxParamLength
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.data.save.cardInv[cardInstance.id]).toBeTruthy();
  });

  it('production-length auction-expired equipment mail → claim succeeds, not a route 404', async () => {
    const equipInstance: EquipmentInstance = { id: 'eq_cross1', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [{ id: 'm_atk', value: 8 }] };
    const auctionId = `a:${accountId}:${1783867933347}:2`;
    const dispatchKey = `auction_expire:${auctionId}`;
    const mailSvc = new MailService({
      cols: s.collections,
      gateway: { available: false, push: async () => {}, pushMany: async () => {}, presence: async () => ({}), invalidateFriends: async () => {} },
      meta: { available: false, resolveByPublicId: async () => null, batchProfiles: async () => new Map() },
      now: () => Date.now(),
    });
    await mailSvc.insertSystemMail(dispatchKey, accountId, {
      subject: 'auction.mail.returned.subject',
      body: 'auction.mail.returned.body',
      attachments: [{ kind: 'equipment', instance: equipInstance }],
      expireDays: 30,
    });

    const mailId = `${dispatchKey}:${accountId}`;
    expect(mailId.length).toBeGreaterThan(100);
    const res = await app.inject({ method: 'POST', url: `/mail/${encodeURIComponent(mailId)}/claim`, headers: auth(), payload: {} });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.data.save.equipmentInv[equipInstance.id]).toBeTruthy();
  });

  it('mail with coins + item + material + skin attachments in one claim: each lands in its own save field, not all dumped into inventory.skins', async () => {
    const mailSvc = new MailService({
      cols: s.collections,
      gateway: { available: false, push: async () => {}, pushMany: async () => {}, presence: async () => ({}), invalidateFriends: async () => {} },
      meta: { available: false, resolveByPublicId: async () => null, batchProfiles: async () => new Map() },
      now: () => Date.now(),
    });
    const dispatchKey = `comp.mixed.${accountId}`;
    await mailSvc.insertSystemMail(dispatchKey, accountId, {
      subject: 'comp.mail.subject',
      body: 'comp.mail.body',
      attachments: [
        { kind: 'coins', count: 500 },
        { kind: 'item', id: 'protect_enhance', count: 2 },
        { kind: 'material', id: 'scrap', count: 7 },
        { kind: 'skin', id: 'skin_shop_c1' },
      ],
      expireDays: 30,
    });

    const mailId = `${dispatchKey}:${accountId}`;
    const res = await app.inject({ method: 'POST', url: `/mail/${encodeURIComponent(mailId)}/claim`, headers: auth(), payload: {} });
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.data.save.wallet.coins).toBe(500);
    expect(b.data.save.inventory.items?.protect_enhance).toBe(2);
    expect(b.data.save.materials.scrap).toBe(7);
    expect(b.data.save.inventory.skins).toContain('skin_shop_c1');
    // None of the non-skin attachments leaked into the skin set.
    expect(b.data.save.inventory.skins).not.toContain('protect_enhance');
    expect(b.data.save.inventory.skins).not.toContain('scrap');
  });
});
