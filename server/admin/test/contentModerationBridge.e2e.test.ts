// admin ↔ socialsvc/metaserver content-moderation bridge e2e (CONTENT_MODERATION_DESIGN.md CM9-CM11, P4/P5):
//   ReportsMixin.listReports/resolveReport (uphold applies the -20 penalty via the metaserver enforcement
//   path, dismiss does not) and AppealsMixin.listAppeals/resolveAppeal, against fake ReportsClient/
//   AppealsClient/EnforcementClient (the real HTTP implementations are exercised by clients-barrel.test.ts's
//   shape check + the target services' own e2e tests). Requires `cd server && docker compose up -d` (real
//   Mongo, for cols.auditLog).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type {
  MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, PlayerProfile, StatsClient,
  ReportsClient, ReportRow, AppealsClient, AppealRow, EnforcementClient, PenaltyResult,
} from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_content_moderation_bridge_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.content-moderation-bridge.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

let t = 1000;
const now = (): number => t++;

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0 }),
};
class FakeMail implements MailDispatcher {
  available = true;
  async send(req: MailSendReq): Promise<MailSendRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
  async preview(req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
}
const stubPlayer: PlayerClient = {
  available: true,
  lookupByPublicId: async (): Promise<PlayerProfile | null> => null,
};

class FakeReports implements ReportsClient {
  available = true;
  rows: ReportRow[] = [
    { _id: 'r1', reporterId: 'a', targetId: 'b', reason: 'spamming', ts: 1, status: 'open' },
  ];
  async listReports(opts?: { status?: string; limit?: number }): Promise<ReportRow[]> {
    const status = opts?.status ?? 'open';
    return this.rows.filter((r) => r.status === status);
  }
  async resolveReport(id: string, resolution: 'dismissed' | 'upheld', resolvedBy: string): Promise<{ ok: boolean }> {
    const r = this.rows.find((x) => x._id === id && x.status === 'open');
    if (!r) return { ok: false };
    r.status = resolution;
    r.resolvedBy = resolvedBy;
    r.resolvedAt = now();
    return { ok: true };
  }
}

class FakeEnforcement implements EnforcementClient {
  available = true;
  calls: { accountId: string; delta: number }[] = [];
  nextResult: PenaltyResult = { reputationScore: 80, action: 'warn' };
  failNext = false;
  async applyPenalty(accountId: string, delta: number): Promise<{ ok: boolean; result?: PenaltyResult }> {
    this.calls.push({ accountId, delta });
    if (this.failNext) return { ok: false };
    return { ok: true, result: this.nextResult };
  }
}

class FakeAppeals implements AppealsClient {
  available = true;
  rows: AppealRow[] = [
    {
      _id: 'ap1', accountId: 'b', reason: 'it was a joke', status: 'open', createdAt: 1,
      enforcementSnapshot: { mutedUntil: 999999, reputationScore: 60 },
    },
  ];
  async listAppeals(opts?: { status?: string; limit?: number }): Promise<AppealRow[]> {
    const status = opts?.status ?? 'open';
    return this.rows.filter((a) => a.status === status);
  }
  async resolveAppeal(id: string, resolution: 'approved' | 'denied', resolvedBy: string, note?: string): Promise<{ ok: boolean }> {
    const a = this.rows.find((x) => x._id === id && x.status === 'open');
    if (!a) return { ok: false };
    a.status = resolution;
    a.resolvedBy = resolvedBy;
    if (note) a.resolutionNote = note;
    return { ok: true };
  }
}

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin content-moderation report/appeal bridge e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let root: Actor;
  let fakeReports: FakeReports;
  let fakeEnforcement: FakeEnforcement;
  let fakeAppeals: FakeAppeals;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    fakeReports = new FakeReports();
    fakeEnforcement = new FakeEnforcement();
    fakeAppeals = new FakeAppeals();
    svc = new AdminService({
      cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(),
      reports: fakeReports, enforcement: fakeEnforcement, appeals: fakeAppeals, now,
    });
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    root = await actorOf(svc, 'root');
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('listReports proxies the reports client and audits report.review', async () => {
    const rows = await svc.listReports(root.adminId, { status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: 'r1', status: 'open' });
    const audit = await m.collections.auditLog.find({ action: 'report.review' }).toArray();
    expect(audit).toHaveLength(1);
  });

  it('resolveReport(dismissed) flips status without calling the enforcement client', async () => {
    const res = await svc.resolveReport(root, 'r1', 'b', 'dismissed');
    expect(res).toEqual({});
    expect(fakeEnforcement.calls).toHaveLength(0);
    expect(fakeReports.rows[0]!.status).toBe('dismissed');
    const audit = await m.collections.auditLog.find({ action: 'report.review' }).toArray();
    expect(audit.some((a) => a.summary?.includes('dismissed'))).toBe(true);
  });

  it('resolveReport(upheld) applies a -20 penalty via the enforcement client and audits account.penalty', async () => {
    const res = await svc.resolveReport(root, 'r1', 'b', 'upheld');
    expect(fakeEnforcement.calls).toEqual([{ accountId: 'b', delta: -20 }]);
    expect(res).toEqual({ reputationScore: 80, action: 'warn' });
    expect(fakeReports.rows[0]!.status).toBe('upheld');
    const audit = await m.collections.auditLog.find({ action: 'account.penalty' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe('b');
  });

  it('resolveReport rejects an unknown/already-resolved report (404) without calling enforcement', async () => {
    await expect(svc.resolveReport(root, 'nonexistent', 'b', 'dismissed')).rejects.toThrow(AdminError);
    expect(fakeEnforcement.calls).toHaveLength(0);
  });

  it('resolveReport(upheld) surfaces a 502 when the penalty call fails (report already flipped to upheld — caller should retry the penalty side)', async () => {
    fakeEnforcement.failNext = true;
    await expect(svc.resolveReport(root, 'r1', 'b', 'upheld')).rejects.toThrow(AdminError);
    expect(fakeReports.rows[0]!.status).toBe('upheld'); // report resolve already succeeded before the penalty call failed
  });

  // FIXED (O-CM6, audit-followup-fixes-0730 review; closed 2026-07-30): resolveReport() no longer does a
  // blind report-resolve-then-penalize sequence. On retry it first checks whether the report is already
  // resolved to the target `resolution` — if so it skips the (now-404ing) report-resolve CAS and retries
  // only the enforcement call.
  it('resolveReport(upheld) can be retried after a penalty-call failure without re-hitting the already-resolved report (O-CM6)', async () => {
    fakeEnforcement.failNext = true;
    await expect(svc.resolveReport(root, 'r1', 'b', 'upheld')).rejects.toThrow(AdminError);
    expect(fakeReports.rows[0]!.status).toBe('upheld');

    // The operator retries exactly as the error message suggests. The penalty call succeeds this time
    // (failNext cleared) — resolveReport() detects the report is already 'upheld' and retries only the
    // penalty side instead of re-resolving (and 404ing on) the report.
    fakeEnforcement.failNext = false;
    const res = await svc.resolveReport(root, 'r1', 'b', 'upheld');
    expect(fakeEnforcement.calls).toContainEqual({ accountId: 'b', delta: -20 });
    expect(res.action).toBeDefined();
  });

  // FIXED (O-CM7, audit-followup-fixes-0730 review; closed 2026-07-30): resolveReport() now derives the
  // target from the report's own targetId (r1's real target is 'b', per FakeReports.rows above) and
  // rejects a caller-supplied accountId that doesn't match, instead of silently penalizing whatever
  // accountId it's given.
  it('resolveReport(upheld) rejects a caller-supplied accountId that does not match the report\'s own targetId (O-CM7)', async () => {
    await expect(svc.resolveReport(root, 'r1', 'z', 'upheld')).rejects.toThrow(AdminError);
  });

  it('listAppeals proxies the appeals client and audits appeal.review', async () => {
    const rows = await svc.listAppeals(root.adminId, { status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: 'ap1', accountId: 'b' });
  });

  it('resolveAppeal(approved/denied) proxies to the appeals client and audits appeal.review', async () => {
    await svc.resolveAppeal(root, 'ap1', 'approved');
    expect(fakeAppeals.rows[0]!.status).toBe('approved');
    expect(fakeAppeals.rows[0]!.resolvedBy).toBe(root.adminId);
    const audit = await m.collections.auditLog.find({ action: 'appeal.review' }).toArray();
    expect(audit.some((a) => a.target === 'ap1')).toBe(true);
  });

  it('resolveAppeal rejects an unknown/already-resolved appeal (404)', async () => {
    await expect(svc.resolveAppeal(root, 'nonexistent', 'denied')).rejects.toThrow(AdminError);
  });

  it('role/capability wiring: super has reports.action/appeals.action, support/viewer only have .view', async () => {
    const { roleHasCapability } = await import('@nw/shared');
    expect(roleHasCapability('super', 'reports.action')).toBe(true);
    expect(roleHasCapability('super', 'appeals.action')).toBe(true);
    expect(roleHasCapability('support', 'reports.action')).toBe(false);
    expect(roleHasCapability('support', 'reports.view')).toBe(true);
    expect(roleHasCapability('viewer', 'appeals.action')).toBe(false);
    expect(roleHasCapability('viewer', 'appeals.view')).toBe(true);
  });
});
