// Social mail end-to-end (S6-3): real Mongo + injected fake gateway (mail_new push) + fake commercial (grant coins).
//   System mail write (internal endpoint + dispatchKey idempotency) → inbox → claim coins/skin attachments
//   (commercial grant + inventory + claimOrderId idempotency) → duplicate claim → ALREADY_CLAIMED → mark read → player-to-player mail (friendship gate).
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../dist/gatewayClient.js';
import type { CommercialClient } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_mail_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[social-mail.e2e] Mongo unreachable (${URI}) — skipping.`);

class FakeGateway implements GatewayClient {
  available = true;
  pushes: { accountId: string; msg: SocialPushMsg }[] = [];
  async judge(): Promise<JudgeRes> {
    return { ok: false };
  }
  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    this.pushes.push({ accountId, msg });
  }
  async presence(ids: string[]): Promise<Record<string, boolean>> {
    return Object.fromEntries(ids.map((id) => [id, false]));
  }
  async invalidateFriends(): Promise<void> {}
}

/** Implements only grant + getWallet needed for mail claim; remaining interface methods are stubs (mail does not reach them). */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  bal(id: string): number {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {} };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async shopCharge() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async gachaDraw() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async spend() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async orderDelivered() { return { ok: true as const }; }
  async undeliveredOrders() { return []; }
  async rechargeVerify() { return { ok: false as const, error: 'INVALID_RECEIPT' }; }
  async adsCredit() { return { ok: true as const, coinsAfter: 0 }; }
  async victoryCredit() { return { ok: true as const, coinsAfter: 0, credited: 0, capped: false }; }
}

describe.skipIf(!mongo)('social mail e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  let comm: FakeCommercial;
  const b = (r: { payload: string }) => JSON.parse(r.payload);

  async function newAccount(deviceId: string): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    return { token: r.data.token, accountId: r.data.accountId, publicId: r.data.publicId };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(token), payload });
  const internal = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'x-internal-key': 'k' }, payload });

  async function befriend(a: { token: string }, c: { token: string; publicId: string }) {
    const req = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: req.data.requestId, accept: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    comm = new FakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway, commercial: comm });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (mongo) await mongo.close();
  });

  it('system mail: send (idempotent dispatchKey) → inbox → claim coins (credits wallet, idempotent)', async () => {
    const a = await newAccount('mail-aaaa');
    await get(a.token, '/save'); // ensure save exists

    const sendReq = {
      dispatchKey: 'comp-001',
      scope: 'single',
      target: { publicId: a.publicId },
      subject: '补偿',
      body: '抱歉给您带来不便',
      attachments: [{ kind: 'coins', count: 500 }],
      expireDays: 7,
    };
    const s1 = b(await internal('/internal/mail/system/send', sendReq));
    expect(s1.ok).toBe(true);
    expect(s1.recipientCount).toBe(1);
    // mail_new push to recipient
    expect(gateway.pushes.some((p) => p.accountId === a.accountId && p.msg.kind === 'mail_new')).toBe(true);

    // dispatchKey idempotent: resend → still 1 mail, no duplicate
    gateway.pushes = [];
    await internal('/internal/mail/system/send', sendReq);

    const inbox = b(await get(a.token, '/mail'));
    expect(inbox.data.mail).toHaveLength(1);
    expect(inbox.data.unread).toBe(1);
    const mail = inbox.data.mail[0];
    expect(mail.from).toBe('system');
    expect(mail.attachments[0]).toMatchObject({ kind: 'coins', count: 500 });
    expect(mail.claimed).toBe(false);

    // claim → wallet +500, claimed flag set
    const claim = b(await post(a.token, `/mail/${mail.mailId}/claim`, {}));
    expect(claim.ok).toBe(true);
    expect(claim.data.save.wallet.coins).toBe(500);

    // re-claim → ALREADY_CLAIMED, no double credit
    const reclaim = await post(a.token, `/mail/${mail.mailId}/claim`, {});
    expect(reclaim.statusCode).toBe(409);
    expect(b(reclaim).error.code).toBe('ALREADY_CLAIMED');
    expect(comm.bal(a.accountId)).toBe(500);
  });

  it('system mail: 内部 accountId 直投（worldsvc 结算路径，§17.5）→ 收件箱 + 材料领进养成统一池', async () => {
    const a = await newAccount('mail-acct');
    await get(a.token, '/save');
    // No publicId / no target, only accountId — internal callers such as worldsvc use this path.
    // Season reward materials use kind:'material' (SLG8): on claim they land in SaveData.materials (the unified progression pool
    // shared by PvE / equipment / auction), not the generic inventory.items bucket.
    const s = b(await internal('/internal/mail/system/send', {
      dispatchKey: 'slg-settle:s5-ops:s5',
      accountId: a.accountId,
      subject: 'slg.settle.subject',
      body: 'slg.settle.body|rank=1|tier=champion',
      attachments: [{ kind: 'material', id: 'scrap', count: 1000 }],
      expireDays: 30,
    }));
    expect(s.ok).toBe(true);
    expect(s.recipientCount).toBe(1);
    const inbox = b(await get(a.token, '/mail'));
    expect(inbox.data.mail).toHaveLength(1);
    expect(inbox.data.mail[0].attachments[0]).toMatchObject({ kind: 'material', id: 'scrap', count: 1000 });

    // Claim → material goes into the save.materials unified pool (not the orphan inventory.items bucket).
    const claim = b(await post(a.token, `/mail/${inbox.data.mail[0].mailId}/claim`, {}));
    expect(claim.data.save.materials.scrap).toBe(1000);
    expect(claim.data.save.inventory.items.scrap ?? 0).toBe(0);
  });

  it('claims a skin attachment into inventory', async () => {
    const a = await newAccount('mail-aaaa');
    await get(a.token, '/save');
    await internal('/internal/mail/system/send', {
      dispatchKey: 'skin-001',
      scope: 'single',
      target: { publicId: a.publicId },
      subject: '皮肤奖励',
      body: '',
      attachments: [{ kind: 'skin', id: 'skin_gift' }],
      expireDays: 30,
    });
    const mail = b(await get(a.token, '/mail')).data.mail[0];
    const claim = b(await post(a.token, `/mail/${mail.mailId}/claim`, {}));
    expect(claim.data.save.inventory.skins).toContain('skin_gift');
  });

  it('claim mail without attachment → NO_ATTACHMENT', async () => {
    const a = await newAccount('mail-aaaa');
    const c = await newAccount('mail-bbbb');
    await get(c.token, '/save');
    await befriend(a, c);
    const sent = b(await post(a.token, '/mail/send', { toPublicId: c.publicId, subject: '约局', body: '来打一把' }));
    const r = await post(c.token, `/mail/${sent.data.mailId}/claim`, {});
    expect(r.statusCode).toBe(400);
    expect(b(r).error.code).toBe('NO_ATTACHMENT');
  });

  it('player mail is gated on friendship + read marks read', async () => {
    const a = await newAccount('mail-aaaa');
    const c = await newAccount('mail-bbbb');
    await get(c.token, '/save');
    // not friends → 403
    const denied = await post(a.token, '/mail/send', { toPublicId: c.publicId, subject: 'hi', body: 'x' });
    expect(denied.statusCode).toBe(403);

    await befriend(a, c);
    gateway.pushes = [];
    const sent = b(await post(a.token, '/mail/send', { toPublicId: c.publicId, subject: 'gg', body: 'wp' }));
    expect(sent.ok).toBe(true);
    expect(gateway.pushes.some((p) => p.accountId === c.accountId && p.msg.kind === 'mail_new')).toBe(true);

    const mail = b(await get(c.token, '/mail')).data.mail[0];
    expect(mail.from).toBe(a.publicId);
    expect(mail.read).toBe(false);
    await post(c.token, `/mail/${mail.mailId}/read`, {});
    const after = b(await get(c.token, '/mail'));
    expect(after.data.mail[0].read).toBe(true);
    expect(after.data.unread).toBe(0);
  });

  it('global system mail fans out to all accounts', async () => {
    const a = await newAccount('mail-aaaa');
    const c = await newAccount('mail-bbbb');
    await get(a.token, '/save');
    await get(c.token, '/save');
    const preview = b(await internal('/internal/mail/system/preview', { scope: 'global', target: { filter: { kind: 'all' } } }));
    expect(preview.recipientCount).toBe(2);
    const send = b(await internal('/internal/mail/system/send', {
      dispatchKey: 'global-001',
      scope: 'global',
      target: { filter: { kind: 'all' } },
      subject: '全服福利',
      body: '登录领取',
      attachments: [{ kind: 'coins', count: 100 }],
      expireDays: 3,
    }));
    expect(send.recipientCount).toBe(2);
    expect(b(await get(a.token, '/mail')).data.mail).toHaveLength(1);
    expect(b(await get(c.token, '/mail')).data.mail).toHaveLength(1);
  });

  it('global fan-out is batched: idempotent resend pushes only newly-added accounts', async () => {
    const accts = [];
    for (let i = 0; i < 5; i++) accts.push(await newAccount(`fan-acct-${i}`));

    const sendReq = {
      dispatchKey: 'fan-001',
      scope: 'global',
      target: { filter: { kind: 'all' } },
      subject: '全服公告',
      body: '维护补偿',
      attachments: [{ kind: 'coins', count: 50 }],
      expireDays: 5,
    };

    // Initial send: all 5 receive the mail + each gets one mail_new push.
    const first = b(await internal('/internal/mail/system/send', sendReq));
    expect(first.recipientCount).toBe(5);
    expect(gateway.pushes.filter((p) => p.msg.kind === 'mail_new')).toHaveLength(5);
    for (const ac of accts) {
      expect(b(await get(ac.token, '/mail')).data.mail).toHaveLength(1);
    }

    // Resend with the same dispatchKey + 1 new account: bulkWrite upsert is idempotent, only the new account is inserted → only it receives a push.
    gateway.pushes = [];
    const late = await newAccount('fan-late-acct');
    const second = b(await internal('/internal/mail/system/send', sendReq));
    expect(second.recipientCount).toBe(6); // 全员仍计入收件人数
    const newPushes = gateway.pushes.filter((p) => p.msg.kind === 'mail_new');
    expect(newPushes).toHaveLength(1);
    expect(newPushes[0].accountId).toBe(late.accountId);

    // Original 5 still have only 1 mail each (no duplicates); the new account also receives exactly 1 mail.
    expect(b(await get(accts[0].token, '/mail')).data.mail).toHaveLength(1);
    expect(b(await get(late.token, '/mail')).data.mail).toHaveLength(1);
  });
});
