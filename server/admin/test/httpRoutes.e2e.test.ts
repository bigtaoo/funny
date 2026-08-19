// admin ops HTTP-route e2e — 2026-08-14, closes the biggest remaining gap in the admin coverage baseline
// (claudedocs/server.md "测试覆盖率百分比工具": src/httpApi/*Routes.ts sat at 0~2% line coverage). Every
// pre-existing e2e file (service.e2e / season-ops.e2e / season-audit.e2e / comp-mail.e2e / moderation.e2e /
// shop.e2e / feedback.e2e) calls `AdminService` methods directly, bypassing the node:http dispatcher chain
// entirely; internalHttp.e2e.test.ts is the only file that starts a real server, and it only ever exercises
// the three X-Internal-Key routes inside `handlePreAuth` (no admin JWT involved). The eight domain route
// files (monitor/player/trustSafety/comp/opsConfig/account/slg/commerce) plus handleLogin/handleSession and
// httpApi.ts's own dispatch/error-mapping had never run through a real HTTP request.
//
// This file: one real node:http server (startHttpApi), one real Mongo, real Bearer tokens minted by real
// POST /admin/login calls, and one request per route — the success path with a 'super' actor (which holds
// every capability) plus a handful of 403/401/404/422/500 checks that prove requireCap/authenticate/the
// EventsClientError and generic-Error catch branches in httpApi.ts are actually wired. Business-rule depth
// (four-eyes, quota tiers, dry-run, idempotency, season-ops sequencing, ...) is already covered at the
// service layer by the e2e files above — this file's job is only to prove each route is reachable, parses
// its own inputs, and calls the right service method; it deliberately does not re-derive that depth.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { loadInternalAuth, type LiveStats } from '@nw/shared';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, type Actor } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import { seedSuperAdmin } from '../src/seed';
import { EventsClientError } from '../src/clients';
import type {
  AnalyticsClient, AnalyticsQueryResult,
  AntiCheatClient, AntiCheatReviewRow,
  AppealsClient, AppealRow,
  AuctionClient,
  EnforcementClient,
  EventsClient,
  FeedbackClient, FeedbackRow,
  GachaPoolsClient, AdminGachaPool,
  LadderClient, LadderSeasonInfo,
  MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes,
  MismatchClient,
  PaddleEventsClient,
  PlayerClient, PlayerProfile,
  PromoClient, PromoCodeView,
  PvpCardStatsClient,
  ReportsClient, ReportRow,
  StatsClient,
  SuspiciousPveClient,
  WorldClient, SlgWorldSummary, SlgAllocateResult,
} from '../src/clients';
import type { MapEditorCityNode, EventDoc, EventInput, CustomPoolConfig, MapTemplateSummary, MapTemplateTile } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_http_routes_test';
const JWT_SECRET = 'http-routes-test-secret';
const INTERNAL_KEY = 'http-routes-test-key';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.httpRoutes.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

let t = 1000;
const now = (): number => t++;

// —— Fake business clients: one per AdminServiceDeps field, minimal but real-shaped implementations ——
const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 5, queue: 1, rooms: 1, gameInstances: 1, gameLoad: 2 }),
};
const stubPlayer: PlayerClient = {
  available: true,
  lookupByPublicId: async (publicId: string): Promise<PlayerProfile | null> =>
    publicId === '123456789' ? { publicId, displayName: 'Alice', banned: false } : null,
  lookupByAccountId: async (accountId: string): Promise<PlayerProfile | null> =>
    accountId === 'acc-1' ? { publicId: '123456789', displayName: 'Alice', banned: false } : null,
  search: async () => [{ publicId: '123456789', displayName: 'Alice', accountId: 'acc-1' }] as never,
  resetPassword: async () => ({ ok: true }),
};
class FakeAntiCheat implements AntiCheatClient {
  available = true;
  rows: AntiCheatReviewRow[] = [{ _id: 'rev1', accountId: 'acc-cheat', status: 'open', ts: 1 } as AntiCheatReviewRow];
  async listReviews(opts?: { accountId?: string; status?: string; limit?: number }) {
    return this.rows.filter((r) => (!opts?.accountId || r.accountId === opts.accountId) && (!opts?.status || opts.status === r.status));
  }
  async resolveReview(id: string, resolution: 'dismissed' | 'banned') {
    const row = this.rows.find((r) => r._id === id);
    if (!row) return { ok: false };
    row.status = 'reviewed';
    return { ok: true };
  }
}
const stubMismatches: MismatchClient = { available: true, listMismatches: async () => [] };
const stubPvpCardStats: PvpCardStatsClient = { available: true, listPvpCardStats: async () => [{ cardId: 'c1', games: 10, wins: 6 }] };
class FakeSuspiciousPve implements SuspiciousPveClient {
  available = true;
  banned = new Set<string>();
  async listSuspiciousPve() { return []; }
  async banAccount(accountId: string) { this.banned.add(accountId); return { ok: true }; }
  async unbanAccount(accountId: string) { this.banned.delete(accountId); return { ok: true }; }
}
class FakeMail implements MailDispatcher {
  available = true;
  failNext = false;
  async send(req: MailSendReq): Promise<MailSendRes> {
    if (this.failNext) { this.failNext = false; return { ok: false, error: 'mail backend down' }; }
    return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 };
  }
  async preview(req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
}
class FakeAnalytics implements AnalyticsClient {
  available = true;
  async query(type: string): Promise<AnalyticsQueryResult> {
    if (type === 'CRASH') throw new Error('analyticsvc exploded');
    return { event_counts: [{ date: '2026-08-14', event: 'login', count: 3 }] };
  }
}
class FakeWorld implements WorldClient {
  available = true;
  worlds: SlgWorldSummary[] = [];
  templates = new Map<string, { summary: MapTemplateSummary; tiles: MapTemplateTile[]; cities: MapEditorCityNode[] }>();
  async listWorlds() { return this.worlds; }
  async openWorld() {}
  async settleWorld() { return { ranking: [] }; }
  async resetWorld() { return { reset: true }; }
  async closeWorld() {}
  async mergeWorld() { return { moved: 1, failed: [] }; }
  async allocateNextSeason(season: number): Promise<SlgAllocateResult> { return { shardCount: 1, worldIds: [`s${season}-0`], allocatedFamilies: 0 }; }
  async listMapTemplates() { return [...this.templates.values()].map((t) => t.summary); }
  async generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    const summary: MapTemplateSummary = { templateId, width, height, version: 1, tileCount: width * height, active: false, createdAt: now(), updatedAt: now() };
    this.templates.set(templateId, { summary, tiles: [], cities: [] });
    return summary;
  }
  async getMapTemplateTiles(templateId: string) { return this.templates.get(templateId)?.tiles ?? []; }
  async saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]) {
    const entry = this.templates.get(templateId);
    if (entry) entry.tiles = tiles;
    return { updated: tiles.length };
  }
  async getMapTemplateCities(templateId: string) { return this.templates.get(templateId)?.cities ?? []; }
  async saveMapTemplateCities(templateId: string, cities: MapEditorCityNode[]) {
    const entry = this.templates.get(templateId);
    if (entry) entry.cities = cities;
    return { updated: cities.length };
  }
  async activateMapTemplate(templateId: string) { const e = this.templates.get(templateId); if (e) e.summary.active = true; }
  async deleteMapTemplate(templateId: string) { this.templates.delete(templateId); }
}
const stubAuction: AuctionClient = {
  available: true,
  scanAnomalies: async () => [{ sellerId: 's1', buyerId: 'b1', trades: 3, designatedTrades: 1, totalCoins: 500, firstTs: 1, lastTs: 2, severity: 'medium', reasons: ['repeated'] }],
  queryListings: async () => [{ auctionId: 'a1', sellerId: 's1', itemType: 'material', itemName: 'wood', item: {}, qty: 1, price: 10, currency: 'coins' } as never],
};
const stubLadder: LadderClient = {
  available: true,
  rollSeason: async (): Promise<LadderSeasonInfo> => ({ seasonNo: 2, startAt: now(), endAt: now(), state: 'active' }),
  getCurrentSeason: async (): Promise<LadderSeasonInfo | null> => ({ seasonNo: 1, startAt: 0, endAt: 1, state: 'active' }),
};
class FakeEvents implements EventsClient {
  available = true;
  docs = new Map<string, EventDoc>();
  async list() { return [...this.docs.values()]; }
  async create(input: EventInput): Promise<EventDoc> {
    if (input.title === 'FORCE_ERROR') throw new EventsClientError(422, 'validation failed upstream');
    const doc: EventDoc = { _id: input.id ?? 'ev1', title: input.title, windowStart: input.windowStart, windowEnd: input.windowEnd, tasks: input.tasks, rewards: input.rewards, createdAt: now() };
    this.docs.set(doc._id, doc);
    return doc;
  }
  async update(eventId: string, input: EventInput): Promise<EventDoc> {
    const doc: EventDoc = { _id: eventId, title: input.title, windowStart: input.windowStart, windowEnd: input.windowEnd, tasks: input.tasks, rewards: input.rewards, createdAt: this.docs.get(eventId)?.createdAt ?? now() };
    this.docs.set(eventId, doc);
    return doc;
  }
  async remove(eventId: string) { this.docs.delete(eventId); }
}
class FakeGachaPools implements GachaPoolsClient {
  available = true;
  pools = new Map<string, AdminGachaPool>();
  async list() { return [...this.pools.values()]; }
  async createCustom(config: CustomPoolConfig, createdBy: string) {
    this.pools.set(config.id, { id: config.id, name: config.name, startAt: config.startAt, endAt: config.endAt, kind: 'custom', costSingle: config.costSingle, createdBy, createdAt: now() });
    return { id: config.id };
  }
  async close(id: string) { const p = this.pools.get(id); if (p) p.closedAt = now(); return { id }; }
}
const stubPromo: PromoClient = {
  available: true,
  list: async (): Promise<PromoCodeView[]> => [{ code: 'WELCOME10', coins: 100, redeemed: 0, createdBy: 'root', createdAt: 1 }],
  create: async (args) => ({ code: args.code }),
};
const stubPaddleEvents: PaddleEventsClient = {
  available: true,
  list: async () => [{ transactionId: 'txn1', eventType: 'transaction.completed', rawEvent: '{}', ts: 1 }],
};
class FakeReports implements ReportsClient {
  available = true;
  rows: ReportRow[] = [{ _id: 'rep1', reporterId: 'r1', targetId: 'acc-report', reason: 'spam', ts: 1, status: 'open' }];
  async listReports(opts?: { status?: string }) { return this.rows.filter((r) => !opts?.status || r.status === opts.status); }
  async resolveReport(id: string, resolution: 'dismissed' | 'upheld') {
    const row = this.rows.find((r) => r._id === id);
    if (!row) return { ok: false };
    row.status = resolution;
    return { ok: true };
  }
}
class FakeAppeals implements AppealsClient {
  available = true;
  rows: AppealRow[] = [{ _id: 'app1', accountId: 'acc-appeal', reason: 'wrongful ban', enforcementSnapshot: { banned: true }, status: 'open', createdAt: 1 }];
  async listAppeals(opts?: { status?: string }) { return this.rows.filter((r) => !opts?.status || r.status === opts.status); }
  async resolveAppeal(id: string, resolution: 'approved' | 'denied') {
    const row = this.rows.find((r) => r._id === id);
    if (!row) return { ok: false };
    row.status = resolution;
    return { ok: true };
  }
}
const stubEnforcement: EnforcementClient = {
  available: true,
  applyPenalty: async () => ({ ok: true, result: { reputationScore: 80, action: 'warn' } }),
};
const stubFeedback: FeedbackClient = {
  available: true,
  listFeedback: async (): Promise<FeedbackRow[]> => [{ _id: 'fb1', accountId: 'acc-1', text: 'great game', createdAt: 1 }],
};

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await mongo!.collections.adminAccounts.findOne({ username }))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin ops HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let mail: FakeMail;
  let antiCheat: FakeAntiCheat;
  let suspiciousPve: FakeSuspiciousPve;
  let events: FakeEvents;
  let gachaPools: FakeGachaPools;
  let reports: FakeReports;
  let appeals: FakeAppeals;
  let world: FakeWorld;
  let analytics: FakeAnalytics;

  let rootToken: string;
  let opsToken: string;
  let csToken: string;

  async function call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }
  async function loginAs(username: string, password: string): Promise<string> {
    const r = await call(null, 'POST', '/admin/login', { username, password });
    expect(r.status).toBe(200);
    return r.json.token as string;
  }

  beforeAll(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    mail = new FakeMail();
    antiCheat = new FakeAntiCheat();
    suspiciousPve = new FakeSuspiciousPve();
    events = new FakeEvents();
    gachaPools = new FakeGachaPools();
    reports = new FakeReports();
    appeals = new FakeAppeals();
    world = new FakeWorld();
    analytics = new FakeAnalytics();

    const svc = new AdminService({
      cols: m.collections, now,
      stats: stubStats, players: stubPlayer, antiCheat, mismatches: stubMismatches, pvpCardStats: stubPvpCardStats,
      suspiciousPve, mail, analytics, world, auction: stubAuction, ladder: stubLadder, events, gachaPools,
      promo: stubPromo, paddleEvents: stubPaddleEvents, reports, appeals, enforcement: stubEnforcement, feedback: stubFeedback,
    });

    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    const root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'ops2', password: 'ops2pass', role: 'ops', displayName: 'Ops Two' });
    await svc.createAccount(root, { username: 'csuser', password: 'cspass', role: 'support', displayName: 'CS' });

    server = startHttpApi({ host: '127.0.0.1', port: 0, jwt: { secret: JWT_SECRET }, internalAuth: loadInternalAuth(INTERNAL_KEY) }, svc);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rootToken = await loginAs('root', 'rootpass');
    opsToken = await loginAs('ops2', 'ops2pass');
    csToken = await loginAs('csuser', 'cspass');
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  // ── session.ts: login / me / logout ──
  describe('session', () => {
    it('wrong password → 401, never issues a token', async () => {
      const r = await call(null, 'POST', '/admin/login', { username: 'root', password: 'nope' });
      expect(r.status).toBe(401);
    });
    it('GET /admin/me returns the actor + capability set', async () => {
      const r = await call(rootToken, 'GET', '/admin/me');
      expect(r.status).toBe(200);
      expect(r.json.admin).toMatchObject({ username: 'root' });
      expect(r.json.capabilities).toContain('admin.manage');
    });
    it('POST /admin/logout audits + returns ok', async () => {
      const r = await call(rootToken, 'POST', '/admin/logout');
      expect(r.status).toBe(200);
    });
  });

  // ── httpApi.ts dispatch/error-mapping ──
  describe('httpApi dispatch + error mapping', () => {
    it('no bearer token → 401 (authenticate throws before any route matches)', async () => {
      const r = await call(null, 'GET', '/admin/monitor/live');
      expect(r.status).toBe(401);
    });
    it('garbage bearer token → 401 (verifyToken throws)', async () => {
      const r = await call('not-a-real-jwt', 'GET', '/admin/monitor/live');
      expect(r.status).toBe(401);
    });
    it('unknown route (past auth) → 404', async () => {
      const r = await call(rootToken, 'GET', '/admin/does-not-exist');
      expect(r.status).toBe(404);
    });
    it('lacking capability → 403 (AdminError catch branch, generic)', async () => {
      const r = await call(csToken, 'GET', '/admin/accounts');
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ ok: false, code: 'forbidden' });
    });
    it('EventsClientError from a client bubbles up as its own status (422)', async () => {
      const r = await call(rootToken, 'POST', '/admin/events', { title: 'FORCE_ERROR', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] });
      expect(r.status).toBe(422);
    });
    it('an unexpected Error → 500 generic error body', async () => {
      const r = await call(rootToken, 'GET', '/admin/analytics/events?type=CRASH');
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ ok: false, error: 'internal error' });
    });
  });

  // ── monitorRoutes ──
  describe('monitorRoutes', () => {
    it('GET /admin/monitor/live', async () => {
      const r = await call(rootToken, 'GET', '/admin/monitor/live');
      expect(r.status).toBe(200);
      expect(r.json.online).toBe(5);
    });
    it('GET /admin/monitor/trend', async () => {
      const r = await call(rootToken, 'GET', '/admin/monitor/trend?metric=online');
      expect(r.status).toBe(200);
      expect(r.json.points).toEqual([]);
    });
    it('GET /admin/analytics/summary', async () => {
      const r = await call(rootToken, 'GET', '/admin/analytics/summary');
      expect(r.status).toBe(200);
      expect(r.json.live).toMatchObject({ online: 5 });
    });
    it('GET /admin/analytics/events', async () => {
      const r = await call(rootToken, 'GET', '/admin/analytics/events?type=event_counts&days=3&platform=web');
      expect(r.status).toBe(200);
      expect(r.json.event_counts).toHaveLength(1);
    });
    it('GET /admin/pvp-card-stats', async () => {
      const r = await call(rootToken, 'GET', '/admin/pvp-card-stats?mode=ranked&since=2026-01-01');
      expect(r.status).toBe(200);
      expect(r.json.cards).toHaveLength(1);
    });
  });

  // ── playerRoutes ──
  describe('playerRoutes', () => {
    it('GET /admin/players/search', async () => {
      const r = await call(rootToken, 'GET', '/admin/players/search?q=alice');
      expect(r.status).toBe(200);
    });
    it('GET /admin/player/:publicId', async () => {
      const r = await call(rootToken, 'GET', '/admin/player/123456789');
      expect(r.status).toBe(200);
      expect(r.json.player).toMatchObject({ displayName: 'Alice' });
    });
    it('GET /admin/player/account/:accountId', async () => {
      const r = await call(rootToken, 'GET', '/admin/player/account/acc-1');
      expect(r.status).toBe(200);
    });
    it('POST /admin/players/:accountId/reset-password', async () => {
      const r = await call(rootToken, 'POST', '/admin/players/acc-1/reset-password', { password: 'NewPassw0rd!' });
      expect(r.status).toBe(200);
    });
    it('POST /admin/accounts/:accountId/ban then /unban', async () => {
      const ban = await call(rootToken, 'POST', '/admin/accounts/acc-suspect/ban');
      expect(ban.status).toBe(200);
      expect(suspiciousPve.banned.has('acc-suspect')).toBe(true);
      const unban = await call(rootToken, 'POST', '/admin/accounts/acc-suspect/unban');
      expect(unban.status).toBe(200);
      expect(suspiciousPve.banned.has('acc-suspect')).toBe(false);
    });
  });

  // ── trustSafetyRoutes ──
  describe('trustSafetyRoutes', () => {
    it('anti-cheat review queue: list then resolve', async () => {
      const list = await call(rootToken, 'GET', '/admin/anticheat/reviews?status=open');
      expect(list.status).toBe(200);
      expect(list.json.reviews).toHaveLength(1);
      const resolve = await call(rootToken, 'POST', '/admin/anticheat/reviews/rev1/resolve', { resolution: 'dismissed', accountId: 'acc-cheat' });
      expect(resolve.status).toBe(200);
      const badResolution = await call(rootToken, 'POST', '/admin/anticheat/reviews/rev1/resolve', { resolution: 'bogus', accountId: 'acc-cheat' });
      expect(badResolution.status).toBe(400);
    });
    it('support role lacks anticheat.view → 403', async () => {
      const r = await call(csToken, 'GET', '/admin/anticheat/reviews');
      expect(r.status).toBe(403);
    });
    it('UGC report queue: list then resolve (upheld → applies enforcement penalty)', async () => {
      const list = await call(rootToken, 'GET', '/admin/reports?status=open');
      expect(list.status).toBe(200);
      expect(list.json.reports).toHaveLength(1);
      const resolve = await call(rootToken, 'POST', '/admin/reports/rep1/resolve', { resolution: 'upheld', accountId: 'acc-report' });
      expect(resolve.status).toBe(200);
      expect(resolve.json).toMatchObject({ action: 'warn' });
    });
    it('support role lacks reports.action → 403', async () => {
      const r = await call(csToken, 'POST', '/admin/reports/rep1/resolve', { resolution: 'dismissed', accountId: 'acc-report' });
      expect(r.status).toBe(403);
    });
    it('appeal queue: list then resolve', async () => {
      const list = await call(rootToken, 'GET', '/admin/appeals?status=open');
      expect(list.status).toBe(200);
      expect(list.json.appeals).toHaveLength(1);
      const resolve = await call(rootToken, 'POST', '/admin/appeals/app1/resolve', { resolution: 'approved', note: 'looks fine' });
      expect(resolve.status).toBe(200);
      const badResolution = await call(rootToken, 'POST', '/admin/appeals/app1/resolve', { resolution: 'bogus' });
      expect(badResolution.status).toBe(400);
    });
    it('GET /admin/feedback', async () => {
      const r = await call(rootToken, 'GET', '/admin/feedback?limit=10');
      expect(r.status).toBe(200);
      expect(r.json.feedback).toHaveLength(1);
    });
  });

  // ── compRoutes: initiate → approve / reject / cancel / retry, preview, list ──
  describe('compRoutes', () => {
    const mailBody = { subject: 'Sorry!', body: 'Here is a gift.', attachments: [{ kind: 'coins', count: 100 }] };

    it('POST /admin/comp/preview (single + global)', async () => {
      const single = await call(rootToken, 'POST', '/admin/comp/preview', { scope: 'single', target: { publicId: '123456789' } });
      expect(single.status).toBe(200);
      expect(single.json).toMatchObject({ recipientCount: 1 });
      const global = await call(rootToken, 'POST', '/admin/comp/preview', { scope: 'global', target: {} });
      expect(global.status).toBe(200);
      expect(global.json).toMatchObject({ recipientCount: 100 });
    });

    it('GET /admin/comp/tickets (list)', async () => {
      const r = await call(rootToken, 'GET', '/admin/comp/tickets');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.json.tickets)).toBe(true);
    });

    it('initiate (root) → self-approve rejected (four-eyes: ops2 is another eligible approver) → approve (ops2) → executed', async () => {
      const init = await call(rootToken, 'POST', '/admin/comp/tickets', { scope: 'single', target: { publicId: '123456789' }, mail: mailBody, reason: 'compensation' });
      expect(init.status).toBe(200);
      const id = (init.json.ticket as { id: string }).id;
      const selfApprove = await call(rootToken, 'POST', `/admin/comp/tickets/${id}/approve`);
      expect(selfApprove.status).toBe(403);
      const approve = await call(opsToken, 'POST', `/admin/comp/tickets/${id}/approve`);
      expect(approve.status).toBe(200);
      expect((approve.json.ticket as { status: string }).status).toBe('executed');
    });

    it('initiate (root) → reject (ops2, a different eligible approver)', async () => {
      const init = await call(rootToken, 'POST', '/admin/comp/tickets', { scope: 'single', target: { publicId: '123456789' }, mail: mailBody, reason: 'to be rejected' });
      const id = (init.json.ticket as { id: string }).id;
      const reject = await call(opsToken, 'POST', `/admin/comp/tickets/${id}/reject`, { note: 'insufficient evidence' });
      expect(reject.status).toBe(200);
      expect((reject.json.ticket as { status: string }).status).toBe('rejected');
    });

    it('initiate → cancel (initiator cancels own pending ticket)', async () => {
      const init = await call(rootToken, 'POST', '/admin/comp/tickets', { scope: 'single', target: { publicId: '123456789' }, mail: mailBody, reason: 'to be cancelled' });
      const id = (init.json.ticket as { id: string }).id;
      const cancel = await call(rootToken, 'POST', `/admin/comp/tickets/${id}/cancel`);
      expect(cancel.status).toBe(200);
      expect((cancel.json.ticket as { status: string }).status).toBe('cancelled');
    });

    it('initiate → approve fails (mail backend down) → retry succeeds', async () => {
      const init = await call(rootToken, 'POST', '/admin/comp/tickets', { scope: 'single', target: { publicId: '123456789' }, mail: mailBody, reason: 'to be retried' });
      const id = (init.json.ticket as { id: string }).id;
      mail.failNext = true;
      const approve = await call(opsToken, 'POST', `/admin/comp/tickets/${id}/approve`);
      expect(approve.status).toBe(200);
      expect((approve.json.ticket as { status: string }).status).toBe('failed');
      const retry = await call(opsToken, 'POST', `/admin/comp/tickets/${id}/retry`);
      expect(retry.status).toBe(200);
      expect((retry.json.ticket as { status: string }).status).toBe('executed');
    });
  });

  // ── opsConfigRoutes: audit / feature flags / SLG shop prices / moderation wordlists ──
  describe('opsConfigRoutes', () => {
    it('GET /admin/audit', async () => {
      const r = await call(rootToken, 'GET', '/admin/audit');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.json.entries)).toBe(true);
    });
    it('GET/PUT /admin/config/flags/:key', async () => {
      const list = await call(rootToken, 'GET', '/admin/config/flags');
      expect(list.status).toBe(200);
      const key = (list.json.flags as Array<{ key: string }>)[0]!.key;
      const put = await call(rootToken, 'PUT', `/admin/config/flags/${key}`, { enabled: true, rollout: { pct: 50 }, desc: 'test rollout' });
      expect(put.status).toBe(200);
      expect(put.json.flag).toMatchObject({ enabled: true });
    });
    it('GET/PUT /admin/config/slg-shop/:id', async () => {
      const list = await call(rootToken, 'GET', '/admin/config/slg-shop');
      expect(list.status).toBe(200);
      const id = (list.json.items as Array<{ id: string }>)[0]!.id;
      const put = await call(rootToken, 'PUT', `/admin/config/slg-shop/${id}`, { cost: 999 });
      expect(put.status).toBe(200);
      expect(put.json.item).toMatchObject({ cost: 999 });
    });
    it('moderation wordlists: get, add word, remove word', async () => {
      const list = await call(rootToken, 'GET', '/admin/moderation/wordlists');
      expect(list.status).toBe(200);
      const add = await call(rootToken, 'POST', '/admin/moderation/wordlists/global/words', { word: 'badword' });
      expect(add.status).toBe(200);
      const remove = await call(rootToken, 'DELETE', '/admin/moderation/wordlists/global/words/badword');
      expect(remove.status).toBe(200);
    });
  });

  // ── accountRoutes ──
  describe('accountRoutes', () => {
    it('GET /admin/accounts', async () => {
      const r = await call(rootToken, 'GET', '/admin/accounts');
      expect(r.status).toBe(200);
      expect((r.json.accounts as unknown[]).length).toBeGreaterThanOrEqual(3);
    });
    it('POST /admin/accounts (create) → PATCH → reset-password', async () => {
      const create = await call(rootToken, 'POST', '/admin/accounts', { username: 'viewer1', password: 'ViewerPass1!', role: 'viewer', displayName: 'Viewer One' });
      expect(create.status).toBe(200);
      const id = (create.json.account as { id: string }).id;
      const patch = await call(rootToken, 'PATCH', `/admin/accounts/${id}`, { displayName: 'Viewer Renamed', disabled: false });
      expect(patch.status).toBe(200);
      expect(patch.json.account).toMatchObject({ displayName: 'Viewer Renamed' });
      const reset = await call(rootToken, 'POST', `/admin/accounts/${id}/reset-password`, { password: 'AnotherPass1!' });
      expect(reset.status).toBe(200);
    });
  });

  // ── slgRoutes: ladder season + SLG season/audit/map-template ops ──
  describe('slgRoutes', () => {
    it('ladder season: current + roll', async () => {
      const current = await call(rootToken, 'GET', '/admin/ladder/season/current');
      expect(current.status).toBe(200);
      const roll = await call(rootToken, 'POST', '/admin/ladder/season/roll');
      expect(roll.status).toBe(200);
      expect(roll.json.season).toMatchObject({ seasonNo: 2 });
    });
    it('support role lacks ladder.season.manage → 403', async () => {
      const r = await call(csToken, 'POST', '/admin/ladder/season/roll');
      expect(r.status).toBe(403);
    });
    it('SLG season ops: worlds / open / settle / reset / close / merge / allocate', async () => {
      expect((await call(rootToken, 'GET', '/admin/slg/worlds')).status).toBe(200);
      expect((await call(rootToken, 'POST', '/admin/slg/season/open', { worldId: 'w1', season: 1, shard: 0, capacity: 5000 })).status).toBe(200);
      expect((await call(rootToken, 'POST', '/admin/slg/season/settle', { worldId: 'w1' })).status).toBe(200);
      expect((await call(rootToken, 'POST', '/admin/slg/season/reset', { worldId: 'w1' })).status).toBe(200);
      expect((await call(rootToken, 'POST', '/admin/slg/season/close', { worldId: 'w1' })).status).toBe(200);
      expect((await call(rootToken, 'POST', '/admin/slg/season/merge', { worldId: 'w1', targetWorldId: 'w2' })).status).toBe(200);
      const alloc = await call(rootToken, 'POST', '/admin/slg/season/allocate', { season: 2, capacity: 8000 });
      expect(alloc.status).toBe(200);
      expect(alloc.json.result).toMatchObject({ shardCount: 1 });
    });
    it('SLG anomaly + listing audit', async () => {
      expect((await call(rootToken, 'GET', '/admin/slg/audit/anomalies')).status).toBe(400); // worldId required
      const anomalies = await call(rootToken, 'GET', '/admin/slg/audit/anomalies?worldId=w1&windowSec=3600');
      expect(anomalies.status).toBe(200);
      expect(anomalies.json.anomalies).toHaveLength(1);
      const listings = await call(rootToken, 'GET', '/admin/slg/audit/listings?sellerId=s1');
      expect(listings.status).toBe(200);
      expect(listings.json.listings).toHaveLength(1);
    });
    it('SLG audit tickets: file → list → resolve (actioned → auto-ban both parties)', async () => {
      const file = await call(rootToken, 'POST', '/admin/slg/audit/tickets', {
        snapshot: { worldId: 'w1', sellerId: 'seller-x', buyerId: 'buyer-y', trades: 5, designatedTrades: 2, totalCoins: 9000, firstTs: 1, lastTs: 2, severity: 'high', reasons: ['high_value'] },
      });
      expect(file.status).toBe(200);
      const id = (file.json.ticket as { id: string }).id;
      const list = await call(rootToken, 'GET', '/admin/slg/audit/tickets?status=open');
      expect(list.status).toBe(200);
      expect((list.json.tickets as unknown[]).length).toBeGreaterThanOrEqual(1);
      const resolve = await call(rootToken, 'POST', `/admin/slg/audit/tickets/${id}/resolve`, { disposition: 'actioned', note: 'confirmed RMT' });
      expect(resolve.status).toBe(200);
      expect(suspiciousPve.banned.has('seller-x')).toBe(true);
      expect(suspiciousPve.banned.has('buyer-y')).toBe(true);
    });
    it('SLG map templates: city nodes round-trip through the proxy and are audited (2026-08-19)', async () => {
      // The point-node half of a Publish. It has its own endpoint pair because the nodes are NOT
      // recoverable from the rasterized tiles — the client's city sprite layer renders this list.
      await call(rootToken, 'POST', '/admin/slg/map-templates/generate', { templateId: 'tpl-cities', width: 10, height: 10 });

      const empty = await call(rootToken, 'GET', '/admin/slg/map-templates/tpl-cities/cities');
      expect(empty.status).toBe(200);
      expect(empty.json.cities).toEqual([]);

      const cities = [{ id: 'garrison-0', kind: 'garrison', provinceIdx: 1, x: 4, y: 6, level: 6, footprint: 7 }];
      const save = await call(rootToken, 'PUT', '/admin/slg/map-templates/tpl-cities/cities', { cities });
      expect(save.status).toBe(200);
      expect(save.json.updated).toBe(1);

      const read = await call(rootToken, 'GET', '/admin/slg/map-templates/tpl-cities/cities');
      expect(read.json.cities).toEqual(cities);

      // Mutating map-template ops are audited (§24) — a whole-list city replace is one of them.
      const audit = await call(rootToken, 'GET', '/admin/audit');
      const entries = audit.json.entries as { action: string; target?: string }[];
      expect(entries.some((e) => e.action === 'slg.map.template.cities' && e.target === 'tpl-cities')).toBe(true);
    });

    it('SLG map templates: a missing cities payload saves an empty list rather than 500ing', async () => {
      await call(rootToken, 'POST', '/admin/slg/map-templates/generate', { templateId: 'tpl-nocities', width: 10, height: 10 });
      const r = await call(rootToken, 'PUT', '/admin/slg/map-templates/tpl-nocities/cities', {});
      expect(r.status).toBe(200);
      expect(r.json.updated).toBe(0);
    });

    it('SLG map templates: generate → list → get tiles → save tiles → activate → delete', async () => {
      const gen = await call(rootToken, 'POST', '/admin/slg/map-templates/generate', { templateId: 'tpl1', width: 10, height: 10 });
      expect(gen.status).toBe(200);
      expect((await call(rootToken, 'GET', '/admin/slg/map-templates')).status).toBe(200);
      const tiles = await call(rootToken, 'GET', '/admin/slg/map-templates/tpl1/tiles?x=0&y=0&w=10&h=10');
      expect(tiles.status).toBe(200);
      const save = await call(rootToken, 'PUT', '/admin/slg/map-templates/tpl1/tiles', { tiles: [{ x: 0, y: 0, type: 'plain', level: 1 }] });
      expect(save.status).toBe(200);
      expect(save.json.updated).toBe(1);
      expect((await call(rootToken, 'POST', '/admin/slg/map-templates/tpl1/activate')).status).toBe(200);
      expect((await call(rootToken, 'DELETE', '/admin/slg/map-templates/tpl1')).status).toBe(200);
    });
  });

  // ── commerceRoutes: Paddle event log, limited-time events, custom gacha pools ──
  describe('commerceRoutes', () => {
    it('GET /admin/paddle/events', async () => {
      const r = await call(rootToken, 'GET', '/admin/paddle/events?accountId=acc-1');
      expect(r.status).toBe(200);
      expect(r.json.events).toHaveLength(1);
    });
    it('events: create → list → patch → delete', async () => {
      const create = await call(rootToken, 'POST', '/admin/events', { title: 'Summer Fest', windowStart: 1, windowEnd: 2, tasks: [], rewards: [] });
      expect(create.status).toBe(200);
      const id = (create.json.event as { _id: string })._id;
      expect((await call(rootToken, 'GET', '/admin/events')).status).toBe(200);
      const patch = await call(rootToken, 'PATCH', `/admin/events/${id}`, { title: 'Summer Fest v2', windowStart: 1, windowEnd: 3, tasks: [], rewards: [] });
      expect(patch.status).toBe(200);
      expect(patch.json.event).toMatchObject({ title: 'Summer Fest v2' });
      const del = await call(rootToken, 'DELETE', `/admin/events/${id}`);
      expect(del.status).toBe(200);
    });
    it('gacha: catalog → list → create custom pool → close', async () => {
      expect((await call(rootToken, 'GET', '/admin/gacha/catalog')).status).toBe(200);
      expect((await call(rootToken, 'GET', '/admin/gacha/pools')).status).toBe(200);
      const create = await call(rootToken, 'POST', '/admin/gacha/pools/custom', {
        id: 'pool1', name: 'Festival', costSingle: 100, startAt: 1, endAt: 2, categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
      });
      expect(create.status).toBe(200);
      expect(create.json.id).toBe('pool1');
      const close = await call(rootToken, 'POST', '/admin/gacha/pools/close', { id: 'pool1' });
      expect(close.status).toBe(200);
    });
  });
});
