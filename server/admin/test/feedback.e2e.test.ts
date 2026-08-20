// admin ↔ metaserver player-feedback bridge e2e (UI_DESIGN.md §4.1.1 / SERVER_API.md §2.13):
// FeedbackMixin.listFeedback against a fake FeedbackClient (the real HTTP implementation is exercised
// by clients-barrel.test.ts's shape check + metaserver's own feedback.e2e.test.ts for GET
// /internal/feedback). Unlike AppealsMixin/ReportsMixin there is no resolve/action side — feedback has
// no status machine, ops only reads it (feedback.view is the only capability, held by every role).
// Requires `cd server && docker compose up -d` (real Mongo, for cols.auditLog).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type {
  MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, PlayerProfile, StatsClient,
  FeedbackClient, FeedbackRow,
} from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_feedback_bridge_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.feedback.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

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

class FakeFeedback implements FeedbackClient {
  available = true;
  rows: FeedbackRow[] = [
    { _id: 'f1', accountId: 'acc-1', text: 'love the ink-splatter effect', createdAt: 2 },
    { _id: 'f2', accountId: 'acc-2', text: 'please add more character skins', clientPlatform: 'wx', createdAt: 1 },
  ];
  calls: { limit?: number }[] = [];
  reviewCalls: { id: string; readBy: string; note?: string }[] = [];
  /** Set false to simulate metaserver's 404 (unknown feedback id). */
  reviewOk = true;
  async listFeedback(opts?: { limit?: number }): Promise<FeedbackRow[]> {
    this.calls.push({ limit: opts?.limit });
    return this.rows;
  }
  async reviewFeedback(id: string, readBy: string, note?: string): Promise<{ ok: boolean }> {
    this.reviewCalls.push({ id, readBy, note });
    return { ok: this.reviewOk };
  }
}

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin player-feedback bridge e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let root: Actor;
  let fakeFeedback: FakeFeedback;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    fakeFeedback = new FakeFeedback();
    svc = new AdminService({
      cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(),
      feedback: fakeFeedback, now,
    });
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    root = await actorOf(svc, 'root');
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('listFeedback proxies the feedback client, newest-first order preserved, and audits feedback.review', async () => {
    const rows = await svc.listFeedback(root.adminId);
    expect(rows).toEqual(fakeFeedback.rows); // proxied verbatim — admin does not re-sort/filter
    const audit = await m.collections.auditLog.find({ action: 'feedback.review' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(root.adminId);
    expect(audit[0]!.summary).toContain('2 feedback entries');
  });

  it('forwards the limit option to the feedback client', async () => {
    await svc.listFeedback(root.adminId, { limit: 50 });
    expect(fakeFeedback.calls).toEqual([{ limit: 50 }]);
  });

  it('defaults to no limit when the caller omits opts', async () => {
    await svc.listFeedback(root.adminId);
    expect(fakeFeedback.calls).toEqual([{ limit: undefined }]);
  });

  it('surfaces a 503 when the feedback backend is unavailable, without writing an audit entry', async () => {
    fakeFeedback.available = false;
    await expect(svc.listFeedback(root.adminId)).rejects.toThrow(AdminError);
    const audit = await m.collections.auditLog.find({ action: 'feedback.review' }).toArray();
    expect(audit).toHaveLength(0);
  });

  it('role/capability wiring: every role can view; only super/ops can triage (feedback.action)', async () => {
    const { roleHasCapability, ADMIN_ROLES } = await import('@nw/shared');
    for (const role of ADMIN_ROLES) {
      expect(roleHasCapability(role, 'feedback.view')).toBe(true);
    }
    expect(ADMIN_ROLES.filter((r) => roleHasCapability(r, 'feedback.action'))).toEqual(['super', 'ops']);
  });

  // ── Triage trail (feedback.action). Still not a verdict — the service just forwards the read-mark /
  // note write to metaserver and audits it; there is no dismiss/uphold outcome as in reports/appeals.
  describe('reviewFeedback', () => {
    it('forwards the actor as readBy and audits the note write', async () => {
      await svc.reviewFeedback(root.adminId, 'f1', 'forwarded to design');
      expect(fakeFeedback.reviewCalls).toEqual([{ id: 'f1', readBy: root.adminId, note: 'forwarded to design' }]);
      const audit = await m.collections.auditLog.find({ action: 'feedback.review', target: 'f1' }).toArray();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.summary).toContain('noted');
    });

    it('a read-mark passes no note through (leaving any existing note intact) and audits as "marked read"', async () => {
      await svc.reviewFeedback(root.adminId, 'f2');
      expect(fakeFeedback.reviewCalls).toEqual([{ id: 'f2', readBy: root.adminId, note: undefined }]);
      const audit = await m.collections.auditLog.find({ action: 'feedback.review', target: 'f2' }).toArray();
      expect(audit[0]!.summary).toContain('marked read');
    });

    it('an explicit empty note (clear) is forwarded verbatim, not swallowed as "omitted"', async () => {
      await svc.reviewFeedback(root.adminId, 'f1', '');
      expect(fakeFeedback.reviewCalls).toEqual([{ id: 'f1', readBy: root.adminId, note: '' }]);
    });

    it('surfaces a 404 when the row is gone, without writing an audit entry', async () => {
      fakeFeedback.reviewOk = false;
      await expect(svc.reviewFeedback(root.adminId, 'gone')).rejects.toThrow(AdminError);
      const audit = await m.collections.auditLog.find({ action: 'feedback.review', target: 'gone' }).toArray();
      expect(audit).toHaveLength(0);
    });

    it('surfaces a 503 when the feedback backend is unavailable, without calling through', async () => {
      fakeFeedback.available = false;
      await expect(svc.reviewFeedback(root.adminId, 'f1')).rejects.toThrow(AdminError);
      expect(fakeFeedback.reviewCalls).toEqual([]);
    });
  });
});
