// End-to-end test for admin SLG suspicious-trade audit tickets (G7 anti-RMT, SLG_DESIGN §17.7): real Mongo in a dedicated DB.
//   Covers: scan via worldsvc proxy / file ticket + pairKey deduplication / open→dismissed|actioned resolution /
//   rejection of invalid and duplicate resolutions / audit trail.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type { MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, StatsClient, AnalyticsClient, WorldClient, AuctionClient, SuspiciousPveClient } from '../src/clients';
import type { AuctionAnomaly, LiveStats, TradeAuditSnapshot } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_audit_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[admin.audit.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

let t = 1000;
const now = (): number => t++;

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0, gameLoad: 0 }),
};
const stubPlayer: PlayerClient = { available: false, lookupByPublicId: async () => null };
const stubAnalytics: AnalyticsClient = { available: false, query: async () => ({}) };
class FakeMail implements MailDispatcher {
  available = true;
  async send(_req: MailSendReq): Promise<MailSendRes> { return { ok: true, recipientCount: 1 }; }
  async preview(_req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: 1 }; }
}

// Fake auctionsvc: scanning returns pre-configured anomalies (auction task5: scan moved off worldsvc, see slgAudit.ts).
const sampleAnomalies: AuctionAnomaly[] = [
  { sellerId: 'rich', buyerId: 'mule', trades: 4, designatedTrades: 4, totalCoins: 80000, firstTs: 1, lastTs: 9, severity: 'high', reasons: ['designated', 'high_value'] },
];
class FakeWorld implements WorldClient {
  available = true;
  async listWorlds() { return []; }
  async openWorld() {}
  async settleWorld() { return {}; }
  async resetWorld() { return {}; }
  async closeWorld() {}
}
class FakeAuction implements AuctionClient {
  available = true;
  async scanAnomalies(): Promise<AuctionAnomaly[]> { return sampleAnomalies; }
}
// Fake suspiciousPve/ban client: records which accounts got banned, for enforcement-on-actioned assertions.
class FakeSuspiciousPve implements SuspiciousPveClient {
  available = true;
  banned = new Set<string>();
  async listSuspiciousPve() { return []; }
  async banAccount(accountId: string) { this.banned.add(accountId); return { ok: true }; }
  async unbanAccount(accountId: string) { this.banned.delete(accountId); return { ok: true }; }
}

const SNAP: TradeAuditSnapshot = {
  worldId: 's1-0', sellerId: 'rich', buyerId: 'mule', trades: 4, designatedTrades: 4,
  totalCoins: 80000, firstTs: 1, lastTs: 9, severity: 'high', reasons: ['designated', 'high_value'],
};

async function actorOf(username: string): Promise<Actor> {
  const doc = (await mongo!.collections.adminAccounts.findOne({ username }))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin SLG audit e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let suspiciousPve: FakeSuspiciousPve;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    suspiciousPve = new FakeSuspiciousPve();
    svc = new AdminService({
      cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(),
      analytics: stubAnalytics, world: new FakeWorld(), auction: new FakeAuction(), suspiciousPve, now,
    });
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('scan proxies worldsvc and returns anomalies', async () => {
    const anomalies = await svc.slgScanAnomalies('s1-0');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.severity).toBe('high');
  });

  it('file ticket + pairKey deduplication (same pair open does not create duplicate)', async () => {
    const root = await actorOf('root');
    const a = await svc.slgFileAuditTicket(root, SNAP);
    expect(a.status).toBe('open');
    expect(a.snapshot.totalCoins).toBe(80000);
    const b = await svc.slgFileAuditTicket(root, SNAP);
    expect(b.id).toBe(a.id); // idempotent: returns the same ticket
    const all = await svc.slgListAuditTickets({});
    expect(all).toHaveLength(1);
  });

  it('resolve open→actioned, second resolution rejected (no longer open)', async () => {
    const root = await actorOf('root');
    const a = await svc.slgFileAuditTicket(root, SNAP);
    const resolved = await svc.slgResolveAuditTicket(root, a.id, 'actioned', 'confirmed RMT, account banned');
    expect(resolved.status).toBe('actioned');
    expect(resolved.note).toBe('confirmed RMT, account banned');
    expect(resolved.resolvedBy).toBe(root.adminId);
    await expect(svc.slgResolveAuditTicket(root, a.id, 'dismissed', '')).rejects.toMatchObject({ status: 409 });
  });

  it('actioned ticket auto-bans both parties (enforcement recorded, audited); dismissed does not ban anyone', async () => {
    const root = await actorOf('root');
    const actioned = await svc.slgFileAuditTicket(root, SNAP);
    const resolved = await svc.slgResolveAuditTicket(root, actioned.id, 'actioned', '');
    expect(resolved.enforcement).toEqual({ sellerBanned: true, buyerBanned: true });
    expect(suspiciousPve.banned.has(SNAP.sellerId)).toBe(true);
    expect(suspiciousPve.banned.has(SNAP.buyerId)).toBe(true);
    const banActions = (await svc.listAudit(root, {})).filter((e) => e.action === 'account.ban');
    expect(banActions).toHaveLength(2);

    const dismissed = await svc.slgFileAuditTicket(root, { ...SNAP, sellerId: 'clean-seller', buyerId: 'clean-buyer' });
    const resolvedDismissed = await svc.slgResolveAuditTicket(root, dismissed.id, 'dismissed', 'false positive');
    expect(resolvedDismissed.enforcement).toBeUndefined();
    expect(suspiciousPve.banned.has('clean-seller')).toBe(false);
    expect(suspiciousPve.banned.has('clean-buyer')).toBe(false);
  });

  it('after resolution same pair can file new ticket (open dedup does not block closed tickets)', async () => {
    const root = await actorOf('root');
    const a = await svc.slgFileAuditTicket(root, SNAP);
    await svc.slgResolveAuditTicket(root, a.id, 'dismissed', 'false positive');
    const c = await svc.slgFileAuditTicket(root, SNAP);
    expect(c.id).not.toBe(a.id);
    expect((await svc.slgListAuditTickets({})).length).toBe(2);
    expect((await svc.slgListAuditTickets({ status: 'open' })).length).toBe(1);
  });

  it('invalid resolution action / invalid snapshot → bad_request', async () => {
    const root = await actorOf('root');
    const a = await svc.slgFileAuditTicket(root, SNAP);
    await expect(svc.slgResolveAuditTicket(root, a.id, 'bogus', '')).rejects.toMatchObject({ status: 400 });
    await expect(svc.slgFileAuditTicket(root, { ...SNAP, sellerId: '', buyerId: '' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.slgFileAuditTicket(root, { ...SNAP, buyerId: 'rich' })).rejects.toMatchObject({ status: 400 }); // seller===buyer
  });

  it('filing and resolving tickets both appear in audit log', async () => {
    const root = await actorOf('root');
    const a = await svc.slgFileAuditTicket(root, SNAP);
    await svc.slgResolveAuditTicket(root, a.id, 'actioned', 'x');
    const entries = await svc.listAudit(root, {});
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('slg.audit.file');
    expect(actions).toContain('slg.audit.resolve');
  });
});
