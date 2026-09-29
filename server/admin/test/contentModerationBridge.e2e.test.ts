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
  ModerationClient, SocialPurgeResult, WorldPurgeResult,
} from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_content_moderation_bridge_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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
  // Not exercised by this suite — throw rather than answer, so a route that starts calling them
  // fails loudly instead of quietly seeing `undefined`.
  lookupByAccountId: () => { throw new Error('stubPlayer.lookupByAccountId is not stubbed'); },
  search: () => { throw new Error('stubPlayer.search is not stubbed'); },
  resetPassword: () => { throw new Error('stubPlayer.resetPassword is not stubbed'); },
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
    expect(res).toEqual({ reputationScore: 80, action: 'warn' });
  });

  // FIXED (O-CM7, audit-followup-fixes-0730 review; closed 2026-07-30): resolveReport() now derives the
  // target from the report's own targetId (r1's real target is 'b', per FakeReports.rows above) and
  // rejects a caller-supplied accountId that doesn't match, instead of silently penalizing whatever
  // accountId it's given.
  it('resolveReport(upheld) rejects a caller-supplied accountId that does not match the report\'s own targetId (O-CM7)', async () => {
    await expect(svc.resolveReport(root, 'r1', 'z', 'upheld')).rejects.toThrow(AdminError);
  });

  // Boundary coverage added 2026-07-30 (audit-followup-fixes-0730 follow-up): the O-CM6/O-CM7 rewrite's
  // "already resolved to this resolution → retry-only" detection and the targetId check apply generically
  // (any resolution, not just the upheld-after-penalty-failure case the KNOWN GAP tests above targeted).

  it('resolveReport(dismissed) is idempotent when called again after already being dismissed', async () => {
    await svc.resolveReport(root, 'r1', 'b', 'dismissed');
    // Second call: the report-resolve CAS would 404 on a literal retry, same shape as the upheld/O-CM6
    // case — resolveReport() detects the report is already 'dismissed' and treats this as a no-op retry
    // (there's nothing to (re-)apply for 'dismissed', so it just re-audits and returns {}).
    const res = await svc.resolveReport(root, 'r1', 'b', 'dismissed');
    expect(res).toEqual({});
    expect(fakeReports.rows[0]!.status).toBe('dismissed');
  });

  it('resolveReport rejects a resolution that conflicts with an already-committed different resolution', async () => {
    await svc.resolveReport(root, 'r1', 'b', 'upheld');
    // The report is now 'upheld', not 'open' and not 'dismissed' — resolveReport() must not silently
    // reinterpret this as a "retry" of a dismiss; it should 404 rather than flip an already-upheld report.
    // (This holds under the pre-O-CM6 implementation too, coincidentally, for a different reason — its
    // single unconditional resolveReport() CAS call already 404s on any second call. Kept as a guard
    // against a regression in the new open→resolution two-step lookup specifically.)
    await expect(svc.resolveReport(root, 'r1', 'b', 'dismissed')).rejects.toThrow(AdminError);
    expect(fakeReports.rows[0]!.status).toBe('upheld');
  });

  it('resolveReport(dismissed) also rejects a caller-supplied accountId mismatch (targetId check is not upheld-only)', async () => {
    await expect(svc.resolveReport(root, 'r1', 'z', 'dismissed')).rejects.toThrow(AdminError);
    expect(fakeReports.rows[0]!.status).toBe('open'); // rejected before ever touching the report
  });

  it('resolveReport(upheld) retry-path still enforces the targetId check against a mismatched accountId', async () => {
    fakeEnforcement.failNext = true;
    await expect(svc.resolveReport(root, 'r1', 'b', 'upheld')).rejects.toThrow(AdminError);
    expect(fakeReports.rows[0]!.status).toBe('upheld');

    fakeEnforcement.failNext = false;
    // A retry with the WRONG accountId must still be rejected even though the report is already 'upheld'
    // and would otherwise qualify for the retry-only path — the targetId check applies before that path
    // ever calls applyPenalty. Asserted on the specific `target_mismatch` code (not just "some AdminError")
    // because a plain 404 would ALSO satisfy a bare toThrow(AdminError) here — the pre-O-CM6 code 404s on
    // any second resolveReport() call regardless of accountId, which would make this assertion pass for
    // the wrong reason if it only checked the error type.
    await expect(svc.resolveReport(root, 'r1', 'z', 'upheld')).rejects.toMatchObject({ code: 'target_mismatch' });
    expect(fakeEnforcement.calls).toEqual([{ accountId: 'b', delta: -20 }]); // only the first (failed) call
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

// ── Staff content removal (App Store Review Guideline 1.2) ──────────────────────────────────────────
class FakeModeration implements ModerationClient {
  socialAvailable = true;
  worldAvailable = true;
  calls: unknown[][] = [];
  worldDown = false;
  async deleteSocialContent(channel: 'dm' | 'family' | 'announcement', ref: { messageId?: string; targetId?: string }) {
    this.calls.push(['social.delete', channel, ref]);
    return { deleted: true };
  }
  async deleteWorldMessage(channel: 'world' | 'sect', messageId: string) {
    this.calls.push(['world.delete', channel, messageId]);
    return { deleted: false };
  }
  async purgeSocialAuthor(accountId: string): Promise<SocialPurgeResult> {
    this.calls.push(['social.purge', accountId]);
    return { dmMessages: 2, familyMessages: 1, announcements: 0, mails: 0, friendRequestMessages: 0 };
  }
  async purgeWorldAuthor(accountId: string): Promise<WorldPurgeResult> {
    this.calls.push(['world.purge', accountId]);
    if (this.worldDown) throw new Error('worldsvc not configured');
    return { worldMessages: 3, sectMessages: 0 };
  }
}

describe.skipIf(!mongo)('admin staff content removal (Guideline 1.2)', () => {
  const m = mongo!;
  let svc: AdminService;
  let root: Actor;
  let reports: FakeReports;
  let moderation: FakeModeration;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    reports = new FakeReports();
    reports.rows = [
      { _id: 'dm1', reporterId: 'a', targetId: 'b', reason: '', ts: 1, status: 'open', contentRef: { kind: 'content', channel: 'dm', messageId: 'm-1' } },
      { _id: 'w1', reporterId: 'a', targetId: 'b', reason: '', ts: 2, status: 'upheld', contentRef: { kind: 'content', channel: 'world', messageId: 'nm:1' } },
      { _id: 'an1', reporterId: 'a', targetId: 'b', reason: '', ts: 3, status: 'open', contentRef: { kind: 'content', channel: 'announcement' } },
      { _id: 'nm1', reporterId: 'a', targetId: 'b', reason: '', ts: 4, status: 'open', contentRef: { kind: 'content', channel: 'name', snapshot: 'X' } },
      { _id: 'noid', reporterId: 'a', targetId: 'b', reason: '', ts: 5, status: 'open', contentRef: { kind: 'content', channel: 'sect' } },
      { _id: 'bare', reporterId: 'a', targetId: 'b', reason: 'x', ts: 6, status: 'open' },
    ];
    moderation = new FakeModeration();
    svc = new AdminService({
      cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(),
      reports, enforcement: new FakeEnforcement(), appeals: new FakeAppeals(), moderation, now,
    } as unknown as ConstructorParameters<typeof AdminService>[0]);
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    root = await actorOf(svc, 'root');
  });

  it('deleteReportedContent routes by channel (dm -> socialsvc, world -> worldsvc, announcement -> by target) and audits', async () => {
    expect(await svc.deleteReportedContent(root, 'dm1')).toEqual({ deleted: true, channel: 'dm' });
    expect(await svc.deleteReportedContent(root, 'w1')).toEqual({ deleted: false, channel: 'world' }); // found in 'upheld' too
    expect(await svc.deleteReportedContent(root, 'an1')).toEqual({ deleted: true, channel: 'announcement' });
    expect(moderation.calls).toEqual([
      ['social.delete', 'dm', { messageId: 'm-1' }],
      ['world.delete', 'world', 'nm:1'],
      ['social.delete', 'announcement', { targetId: 'b' }],
    ]);
    const audit = await m.collections.auditLog.find({ action: 'report.content.remove' }).toArray();
    expect(audit).toHaveLength(3);
    expect(audit.every((a) => a.target === 'b')).toBe(true);
  });

  it('deleteReportedContent rejects reports with nothing single to delete (400) and unknown ids (404)', async () => {
    await expect(svc.deleteReportedContent(root, 'nm1')).rejects.toMatchObject({ status: 400 });
    await expect(svc.deleteReportedContent(root, 'noid')).rejects.toMatchObject({ status: 400 });
    await expect(svc.deleteReportedContent(root, 'bare')).rejects.toMatchObject({ status: 400 });
    await expect(svc.deleteReportedContent(root, 'nope')).rejects.toMatchObject({ status: 404 });
    expect(moderation.calls).toEqual([]);
  });

  it('purgeAuthorContent hits both backends; one failing half is reported, not fatal', async () => {
    expect(await svc.purgeAuthorContent(root, 'b')).toEqual({
      social: { dmMessages: 2, familyMessages: 1, announcements: 0, mails: 0, friendRequestMessages: 0 },
      world: { worldMessages: 3, sectMessages: 0 },
    });
    moderation.worldDown = true;
    const partial = await svc.purgeAuthorContent(root, 'b');
    expect(partial.world).toEqual({ error: 'worldsvc not configured' });
    expect(partial.social).toMatchObject({ dmMessages: 2 });
    expect(await m.collections.auditLog.countDocuments({ action: 'report.content.remove', target: 'b' })).toBe(2);
    await expect(svc.purgeAuthorContent(root, '')).rejects.toMatchObject({ status: 400 });
  });

  it('without a moderation client configured, removal fails loudly (502), never a silent no-op', async () => {
    const bare = new AdminService({
      cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(),
      reports, enforcement: new FakeEnforcement(), appeals: new FakeAppeals(), now,
    } as unknown as ConstructorParameters<typeof AdminService>[0]);
    await expect(bare.deleteReportedContent(root, 'dm1')).rejects.toMatchObject({ status: 502 });
    const res = await bare.purgeAuthorContent(root, 'b');
    expect(res).toEqual({ social: { error: 'socialsvc not configured' }, world: { error: 'worldsvc not configured' } });
  });
});

// One connection shared by both suites above; closed once, after the last of them.
afterAll(async () => {
  await mongo?.close();
});
