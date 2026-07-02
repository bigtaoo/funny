// OPS compensation ticket ↔ meta system mail cross-process integration test (OPS_DESIGN §3.3 / §4.1, SOCIAL_DESIGN S6-3).
// This is the real integration test for the "contract wired but never actually run" backlog item: admin's **real HttpMailDispatcher / HttpPlayerClient**
// uses `fetch` against a **real listening meta process** (not fastify inject), which itself calls a **real listening socialsvc process** for system
// mail writes (P2: socialsvc is the sole mail-write authority — GET /mail proxies there too), exercising the full chain:
//   ticket initiated → approved → auto-executed (HttpMailDispatcher.send → meta /internal/mail/system/send →
//   socialsvc /internal/mail/system) → player has mail in inbox (meta GET /mail → proxy → socialsvc) →
//   claim attachment (commercial grant + inventory) → wallet credited.
// Coverage: single-player full chain / dispatchKey idempotency / global fan-out + preview / player.lookup / auth boundary (wrong key → failed)
//   / non-existent recipient → failed.
//
// Requires `cd server && docker compose up -d` + first run `npx tsc -b shared metaserver admin commercial socialsvc` (imports meta + socialsvc dist).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
// meta is an ESM package: import from compiled dist output (same convention as metaserver/test/*.e2e — requires tsc -b first).
import { buildApp } from '../../metaserver/dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../../metaserver/dist/gatewayClient.js';
import type { CommercialClient } from '../../metaserver/dist/commercialClient.js';
// socialsvc is the mail-write authority since P2; embed a real instance backed by the same test Mongo.
import { startHttpApi } from '../../socialsvc/dist/httpApi.js';
import { createSocialMongo, type SocialMongo } from '../../socialsvc/dist/db.js';
import { MailService } from '../../socialsvc/dist/mailService.js';
import { FamilyService } from '../../socialsvc/dist/familyService.js';
import { FriendService } from '../../socialsvc/dist/friendService.js';
import { nullSocialMetaClient } from '../../socialsvc/dist/metaClient.js';
import { nullSocialGatewayClient } from '../../socialsvc/dist/gatewayClient.js';
// Admin side uses the real HTTP clients + service (running from src, transpiled by vitest).
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, type Actor } from '../src/service';
import { HttpMailDispatcher, HttpPlayerClient, type StatsClient } from '../src/clients';
import { seedSuperAdmin } from '../src/seed';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const META_DB = 'nw_meta_comp_test';
const ADMIN_DB = 'nw_admin_comp_test';
const SOCIAL_DB = 'nw_social_comp_test';
const KEY = 'itest-internal-key';
const jwt: JwtConfig = { secret: 'comp-test-secret' };

async function tryMeta(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, META_DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
async function tryAdmin(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, ADMIN_DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
async function trySocial(): Promise<SocialMongo | null> {
  try {
    return await createSocialMongo(URI, SOCIAL_DB);
  } catch {
    return null;
  }
}

const metaMongo = await tryMeta();
const adminMongo = await tryAdmin();
const socialMongo = await trySocial();
if (!metaMongo || !adminMongo || !socialMongo) {
  console.warn(`[comp-mail.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

// —— Fake gateway (to verify mail_new push) + fake commercial (to credit coins on claim) ——
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

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0, gameLoad: 0 }),
};

let t = 1000;
const now = (): number => t++;

describe.skipIf(!metaMongo || !adminMongo || !socialMongo)('OPS comp ticket ↔ meta system mail (cross-process)', () => {
  const meta = metaMongo!;
  const admin = adminMongo!;
  const social = socialMongo!;
  let app: FastifyInstance; // real listening meta process
  let socialServer: Server; // real listening socialsvc process (mail write authority since P2)
  let baseUrl: string;
  let gateway: FakeGateway;
  let comm: FakeCommercial;
  let svc: AdminService;

  const bodyOf = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // Register a player via the real meta process (HTTP; inject is fine here — the subject under test is the admin→meta chain).
  async function newPlayer(deviceId: string): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = bodyOf(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    // Ensure the save document exists (claiming attachments requires writing the wallet mirror to save).
    await app.inject({ method: 'GET', url: '/save', headers: auth(r.data.token) });
    return { token: r.data.token, accountId: r.data.accountId, publicId: r.data.publicId };
  }
  const getMail = async (token: string) => bodyOf(await app.inject({ method: 'GET', url: '/mail', headers: auth(token) }));

  async function actorOf(username: string): Promise<Actor> {
    const doc = (await admin.collections.adminAccounts.findOne({ username }))!;
    return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
  }

  beforeAll(async () => {
    gateway = new FakeGateway();
    comm = new FakeCommercial();
    // socialsvc: real listening process, backed by its own test Mongo db (mail-write authority, meta proxies GET /mail there too).
    const mailSvc = new MailService({ cols: social.collections, gateway: nullSocialGatewayClient, meta: nullSocialMetaClient, now });
    const familySvc = new FamilyService({ cols: social.collections, gateway: nullSocialGatewayClient, meta: nullSocialMetaClient });
    const friendSvc = new FriendService({ cols: social.collections, gateway: nullSocialGatewayClient, meta: nullSocialMetaClient, now });
    socialServer = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: jwt.secret, internalKey: KEY }, familySvc, friendSvc, mailSvc, nullSocialGatewayClient);
    const socialAddr = await new Promise<AddressInfo>((resolve) => socialServer.once('listening', () => resolve(socialServer.address() as AddressInfo)));
    const socialsvcUrl = `http://127.0.0.1:${socialAddr.port}`;

    app = await buildApp({ cols: meta.collections, jwt, internalKey: KEY, gateway, commercial: comm, socialsvcUrl });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socialServer) await new Promise<void>((resolve) => socialServer.close(() => resolve()));
    await meta.db.dropDatabase().catch(() => {});
    await admin.db.dropDatabase().catch(() => {});
    await meta.close();
    await admin.close();
    await social.close();
  });

  beforeEach(async () => {
    await meta.db.dropDatabase();
    await meta.ensureIndexes();
    await admin.db.dropDatabase();
    await admin.ensureIndexes(3600);
    await social.ensureIndexes();
    gateway.pushes = [];
    comm.coins.clear();
    comm.granted.clear();
    // Real HTTP clients pointed at the listening meta process.
    const mail = new HttpMailDispatcher(baseUrl, KEY);
    const players = new HttpPlayerClient(baseUrl, KEY);
    svc = new AdminService({ cols: admin.collections, stats: stubStats, players, mail, now });
    await seedSuperAdmin(admin.collections, 'root', 'rootpass', now);
    const root = await actorOf('root');
    await svc.createAccount(root, { username: 'opsy', password: 'opspass', role: 'ops', displayName: 'Ops' });
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
  });

  it('full chain: csr initiates → ops approves → real HTTP dispatch → player has mail in inbox → claim credits wallet', async () => {
    const player = await newPlayer('comp-player-1');
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');

    const ticket = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: player.publicId },
      mail: { subject: 'Compensation', body: 'Sorry for the inconvenience', attachments: [{ kind: 'coins', count: 500 }], expireDays: 7 },
      reason: 'Order stuck compensation',
    });
    expect(ticket.status).toBe('pending');

    const executed = await svc.approveTicket(ops, ticket.id);
    expect(executed.status).toBe('executed');
    expect(executed.recipientCount).toBe(1);

    // meta side: the player actually received the system mail (written via the real HTTP chain).
    const inbox = await getMail(player.token);
    expect(inbox.data.mail).toHaveLength(1);
    const mail = inbox.data.mail[0];
    expect(mail.from).toBe('system');
    expect(mail.subject).toBe('Compensation');
    expect(mail.attachments[0]).toMatchObject({ kind: 'coins', count: 500 });
    // mail_new push was delivered to the recipient.
    expect(gateway.pushes.some((p) => p.accountId === player.accountId && p.msg.kind === 'mail_new')).toBe(true);

    // Claim attachment → wallet credited (admin never writes to the wallet directly; coins are credited via commercial only at claim time).
    const claim = bodyOf(await app.inject({ method: 'POST', url: `/mail/${mail.mailId}/claim`, headers: auth(player.token), payload: {} }));
    expect(claim.ok).toBe(true);
    expect(claim.data.save.wallet.coins).toBe(500);
    expect(comm.bal(player.accountId)).toBe(500);
  });

  it('dispatchKey idempotency: same key re-dispatched does not duplicate delivery (real HTTP $setOnInsert)', async () => {
    const player = await newPlayer('comp-player-2');
    const mail = new HttpMailDispatcher(baseUrl, KEY);
    const req = {
      dispatchKey: 'comp-dup-001',
      scope: 'single' as const,
      target: { publicId: player.publicId },
      subject: 'Compensation',
      body: 'x',
      attachments: [{ kind: 'coins' as const, count: 100 }],
      expireDays: 7,
    };
    const r1 = await mail.send(req);
    const r2 = await mail.send(req);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Still only one mail (dispatchKey idempotency).
    const inbox = await getMail(player.token);
    expect(inbox.data.mail).toHaveLength(1);
  });

  it('global fan-out: preview + global approval → each account receives one mail', async () => {
    const p1 = await newPlayer('comp-g-1');
    const p2 = await newPlayer('comp-g-2');
    const ops = await actorOf('opsy');
    const root = await actorOf('root');

    // dry-run preview via the real meta /internal/mail/system/preview.
    const preview = await svc.preview({ scope: 'global', target: { filter: { kind: 'all' } } });
    expect(preview.available).toBe(true);
    expect(preview.recipientCount).toBe(2);

    const g = await svc.initiateTicket(ops, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: 'Server-wide gift', body: 'Log in to claim', attachments: [{ kind: 'coins', count: 50 }], expireDays: 3 },
      reason: 'Version update gift',
    });
    const done = await svc.approveTicket(root, g.id); // global scope always requires a super-admin approver
    expect(done.status).toBe('executed');
    expect(done.recipientCount).toBe(2);

    expect((await getMail(p1.token)).data.mail).toHaveLength(1);
    expect((await getMail(p2.token)).data.mail).toHaveLength(1);
  });

  it('player.lookup via real meta /internal/player reverse lookup', async () => {
    const player = await newPlayer('comp-lookup-1');
    const profile = await svc.lookupPlayer(player.publicId);
    expect(profile.publicId).toBe(player.publicId);
    expect(profile.accountId).toBe(player.accountId);
    expect(typeof profile.elo).toBe('number'); // save exists → pvp fields are present
  });

  it('auth boundary: wrong internal key → meta 401 → ticket failed (retryable)', async () => {
    const player = await newPlayer('comp-badkey-1');
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');
    // Assemble the service with a dispatcher using the wrong key.
    const badSvc = new AdminService({
      cols: admin.collections,
      stats: stubStats,
      players: new HttpPlayerClient(baseUrl, KEY),
      mail: new HttpMailDispatcher(baseUrl, 'wrong-key'),
      now,
    });
    const ticket = await badSvc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: player.publicId },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 7 },
      reason: 'r',
    });
    const failed = await badSvc.approveTicket(ops, ticket.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('401');
    // Player received no mail.
    expect((await getMail(player.token)).data.mail).toHaveLength(0);
  });

  it('recipient does not exist: single target publicId not found → ticket failed', async () => {
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');
    const ticket = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '000000001' }, // 9 digits but account does not exist
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 7 },
      reason: 'r',
    });
    const failed = await svc.approveTicket(ops, ticket.id);
    expect(failed.status).toBe('failed');
  });
});
