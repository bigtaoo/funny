// admin service end-to-end (OPS_DESIGN §8 verification): dedicated real Mongo database. Entire suite skipped if Mongo is unreachable.
//   Login/RBAC rejection, ticket approval routing "initiator ≠ approver", over-quota routed to super-admin, global routed to super-admin, dry-run,
//   idempotent execution, audit visibility, account management. Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { LOGIN_WINDOW_MS } from '../src/service/base';
import { seedSuperAdmin } from '../src/seed';
import type {
  AntiCheatClient,
  AntiCheatReviewRow,
  MailDispatcher,
  MailSendReq,
  MailSendRes,
  MailPreviewReq,
  MailPreviewRes,
  PlayerClient,
  PlayerProfile,
  StatsClient,
  SuspiciousPveClient,
} from '../src/clients';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_test';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[admin.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

let t = 1000;
const now = (): number => t++;

// —— Fake business clients (injected; do not connect to real services) ——
const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 5, queue: 2, rooms: 1, gameInstances: 1, gameLoad: 3 }),
};
class FakeMail implements MailDispatcher {
  available = true;
  sent: MailSendReq[] = [];
  failNext = false;
  async send(req: MailSendReq): Promise<MailSendRes> {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: 'mail backend down' };
    }
    this.sent.push(req);
    return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 };
  }
  async preview(req: MailPreviewReq): Promise<MailPreviewRes> {
    return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 };
  }
}
const stubPlayer: PlayerClient = {
  available: true,
  lookupByPublicId: async (publicId: string): Promise<PlayerProfile | null> => {
    if (publicId === '123456789') return { publicId, displayName: 'Alice', rank: 'gold', elo: 1200, wins: 3, losses: 1, banned: false };
    if (publicId === '999999998') return { publicId, displayName: 'Bob', banned: true };
    return null;
  },
  lookupByAccountId: async (): Promise<PlayerProfile | null> => null,
  search: async (): Promise<[]> => [],
  resetPassword: async (accountId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    accountId === 'no-password-account' ? { ok: false, error: 'account has no password credential' } : { ok: true },
};
// Fake ban/unban backing store for the manual ban feature (S4-4, anticheat.action) — mirrors FakeSuspiciousPve in season-audit.e2e.test.ts.
class FakeSuspiciousPve implements SuspiciousPveClient {
  available = true;
  banned = new Set<string>();
  async listSuspiciousPve() { return []; }
  async banAccount(accountId: string) { this.banned.add(accountId); return { ok: true }; }
  async unbanAccount(accountId: string) { this.banned.delete(accountId); return { ok: true }; }
}
// Fake anti-cheat review queue backing store (PvE reject review, 2026-07-18 policy change: no auto-ban).
class FakeAntiCheat implements AntiCheatClient {
  available = true;
  rows: AntiCheatReviewRow[] = [];
  async listReviews(opts?: { accountId?: string; status?: string; limit?: number }) {
    return this.rows.filter(
      (r) => (!opts?.accountId || r.accountId === opts.accountId) && (!opts?.status || opts.status === 'all' || r.status === opts.status),
    );
  }
  async resolveReview(id: string, resolution: 'dismissed' | 'banned', resolvedBy: string) {
    const row = this.rows.find((r) => r._id === id);
    if (!row) return { ok: false };
    row.status = 'reviewed';
    row.resolution = resolution;
    row.resolvedBy = resolvedBy;
    row.resolvedAt = 1;
    return { ok: true };
  }
}

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin service e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let mail: FakeMail;
  let suspiciousPve: FakeSuspiciousPve;
  let antiCheat: FakeAntiCheat;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    mail = new FakeMail();
    suspiciousPve = new FakeSuspiciousPve();
    antiCheat = new FakeAntiCheat();
    svc = new AdminService({ cols: m.collections, stats: stubStats, players: stubPlayer, suspiciousPve, antiCheat, mail, now });
    // Seed: one super-admin + one ops + one support agent.
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    const root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'opsy', password: 'opspass', role: 'ops', displayName: 'Ops' });
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('successful login issues token + capability set; wrong password rejected', async () => {
    const doc = await svc.authenticate('root', 'rootpass');
    const { capabilities } = svc.meView(doc);
    expect(capabilities).toContain('admin.manage');
    await expect(svc.authenticate('root', 'wrong')).rejects.toBeInstanceOf(AdminError);
  });

  it('login failure rate-limit: locked after 5 consecutive wrong attempts (429), even correct password rejected; successful login resets counter', async () => {
    // First ensure correct password still works below the threshold (4 failures do not lock).
    for (let i = 0; i < 4; i++) {
      await expect(svc.authenticate('root', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    await svc.authenticate('root', 'rootpass'); // success → counter reset
    // 5 more wrong attempts trigger lockout.
    for (let i = 0; i < 5; i++) {
      await expect(svc.authenticate('root', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    // After lockout, even the correct password is blocked with 429.
    await expect(svc.authenticate('root', 'rootpass')).rejects.toMatchObject({ status: 429 });
    // Case/whitespace normalization maps to the same rate-limit key.
    await expect(svc.authenticate(' ROOT ', 'rootpass')).rejects.toMatchObject({ status: 429 });
  });

  // Regression for the 2026-07-29 audit fix: `loginAttempts` is keyed by attacker-controlled username with
  // no account-existence check before the table is touched — failed logins against nonexistent usernames
  // (never hit the `.delete()` on success, see the test above) used to grow this map without bound for
  // the life of the process. maybeSweepLoginAttempts now piggybacks a cleanup pass onto normal login
  // traffic once the window has fully elapsed.
  it('loginAttempts sweeps out stale entries (attacker-controlled usernames) once their window has elapsed', async () => {
    for (let i = 0; i < 20; i++) {
      await expect(svc.authenticate(`nosuchuser-${i}`, 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    // 2026-08-11 mixin-chain split: loginAttempts moved from AdminService (inherited from
    // AdminServiceBase) to a private field on AuthService, held by AdminService's `auth` field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attempts = (svc as any).auth.loginAttempts as Map<string, unknown>;
    expect(attempts.size).toBeGreaterThanOrEqual(20);

    t += LOGIN_WINDOW_MS + 1000; // past the window — every entry above is now stale and unlocked
    // Any call re-enters authenticate() and triggers maybeSweepLoginAttempts (runs at most once per
    // LOGIN_WINDOW_MS); this one also adds exactly one fresh entry for 'nosuchuser-999'.
    await expect(svc.authenticate('nosuchuser-999', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(attempts.size).toBe(1);
  });

  it('support initiates + ops approves personal compensation (normal) → auto-executes and delivers mail', async () => {
    const cs = await actorOf(svc, 'csr');
    const ops = await actorOf(svc, 'opsy');
    const t1 = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 'Apology', body: 'Compensation', attachments: [{ kind: 'coins', count: 100 }], expireDays: 30 },
      reason: 'stuck order',
    });
    expect(t1.status).toBe('pending');
    expect(t1.amountTier).toBe('normal');
    const approved = await svc.approveTicket(ops, t1.id);
    expect(approved.status).toBe('executed');
    expect(approved.recipientCount).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('initiator cannot approve their own ticket (initiator ≠ approver)', async () => {
    const root = await actorOf(svc, 'root');
    const ops = await actorOf(svc, 'opsy');
    // A second eligible approver must exist, otherwise the single-super exception (service.ts
    // hasOtherEligibleApprover) permits self-approval by design — see approveTicket's comment.
    await svc.createAccount(root, { username: 'opsy2', password: 'opspass2', role: 'ops', displayName: 'Ops2' });
    const t1 = await svc.initiateTicket(ops, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    await expect(svc.approveTicket(ops, t1.id)).rejects.toMatchObject({ status: 403 });
  });

  it('over-quota personal compensation can only be approved by super-admin (ops rejected)', async () => {
    const cs = await actorOf(svc, 'csr');
    const ops = await actorOf(svc, 'opsy');
    const root = await actorOf(svc, 'root');
    const big = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 999999 }], expireDays: 30 },
      reason: 'big',
    });
    expect(big.amountTier).toBe('overquota');
    await expect(svc.approveTicket(ops, big.id)).rejects.toMatchObject({ status: 403 });
    const ok = await svc.approveTicket(root, big.id);
    expect(ok.status).toBe('executed');
  });

  it('support cannot initiate global compensation; ops may initiate but only super-admin can approve', async () => {
    const cs = await actorOf(svc, 'csr');
    const ops = await actorOf(svc, 'opsy');
    const root = await actorOf(svc, 'root');
    await expect(
      svc.initiateTicket(cs, {
        scope: 'global',
        target: { filter: { kind: 'all' } },
        mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
        reason: 'r',
      }),
    ).rejects.toMatchObject({ status: 403 });
    const g = await svc.initiateTicket(ops, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    await expect(svc.approveTicket(ops, g.id)).rejects.toMatchObject({ status: 403 });
    const done = await svc.approveTicket(root, g.id);
    expect(done.status).toBe('executed');
    expect(done.recipientCount).toBe(100);
  });

  it('sole super-admin exception: when no other qualified approver exists, super-admin may self-approve their own global ticket (explicitly logged)', async () => {
    // seed has only root as super; global tickets require super approval → no second approver → self-approval allowed.
    const root = await actorOf(svc, 'root');
    const g = await svc.initiateTicket(root, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    const done = await svc.approveTicket(root, g.id);
    expect(done.status).toBe('executed');
    // Audit log explicitly marks self-approval for future review / removal of this exception.
    const audit = await m.collections.auditLog.findOne({ action: 'comp.approve', target: g.id });
    expect(audit?.summary).toContain('SELF-APPROVED');
  });

  it('when a second super-admin exists, initiator cannot self-approve their own global ticket (four-eyes restored)', async () => {
    const root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'root2', password: 'root2pass', role: 'super', displayName: 'Root2' });
    const g = await svc.initiateTicket(root, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    await expect(svc.approveTicket(root, g.id)).rejects.toMatchObject({ status: 403 });
    // The second super-admin can approve and release it.
    const root2 = await actorOf(svc, 'root2');
    const done = await svc.approveTicket(root2, g.id);
    expect(done.status).toBe('executed');
  });

  it('a disabled second approver does not count: super-admin self-approval still allowed', async () => {
    const root = await actorOf(svc, 'root');
    const r2 = await svc.createAccount(root, {
      username: 'root2',
      password: 'root2pass',
      role: 'super',
      displayName: 'Root2',
    });
    await svc.updateAccount(root, r2.id, { disabled: true }); // disable the second super
    const g = await svc.initiateTicket(root, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    const done = await svc.approveTicket(root, g.id);
    expect(done.status).toBe('executed');
  });

  it('dry-run preview returns recipient count', async () => {
    const ops = await actorOf(svc, 'opsy');
    expect(await svc.preview(ops, { scope: 'global', target: { filter: { kind: 'all' } } })).toMatchObject({
      recipientCount: 100,
    });
    expect(await svc.preview(ops, { scope: 'single', target: { publicId: '123456789' } })).toMatchObject({
      recipientCount: 1,
    });
  });

  // Regression for the 2026-08-04 fix: preview() (and its httpApi.ts route) never called requireCap at
  // all — ANY authenticated admin, regardless of role, could probe how many players a global compensation
  // broadcast would reach. preview is now gated by the SAME capability initiateTicket requires for that
  // scope (support has comp.initiate.single but not comp.initiate.global — see ROLE_CAPABILITIES).
  it('preview is gated by the same capability initiateTicket requires for that scope', async () => {
    const cs = await actorOf(svc, 'csr'); // role: support
    await expect(svc.preview(cs, { scope: 'global', target: { filter: { kind: 'all' } } })).rejects.toMatchObject({
      status: 403,
    });
    // support DOES hold comp.initiate.single — single-scope preview must still work for it.
    await expect(
      svc.preview(cs, { scope: 'single', target: { publicId: '123456789' } }),
    ).resolves.toMatchObject({ recipientCount: 1 });
  });

  it('execution failure → failed → retry succeeds; dispatchKey unchanged (idempotent)', async () => {
    const cs = await actorOf(svc, 'csr');
    const root = await actorOf(svc, 'root');
    const t1 = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    mail.failNext = true;
    const failed = await svc.approveTicket(root, t1.id);
    expect(failed.status).toBe('failed');
    const retried = await svc.retryTicket(root, t1.id);
    expect(retried.status).toBe('executed');
    const dk = (await m.collections.compTickets.findOne({ _id: t1.id }))!.dispatchKey;
    expect(mail.sent[0]!.dispatchKey).toBe(dk);
  });

  // Regression for the 2026-07-29 audit fix: retryTicket used to read status==='failed' and call
  // execute() with no atomic claim in between (unlike approveTicket, which does a status CAS before
  // execute()) — two concurrent retryTicket calls (a double-click) would both pass the check and both
  // call mail.send. The dispatchKey makes actual mail delivery idempotent server-side, but this still
  // wasted a redundant network call and double-wrote the audit log; now only one call wins the claim.
  it('retryTicket: concurrent double-click only executes once, the loser gets 409', async () => {
    const cs = await actorOf(svc, 'csr');
    const root = await actorOf(svc, 'root');
    const t1 = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    mail.failNext = true;
    await svc.approveTicket(root, t1.id); // → failed
    mail.sent.length = 0; // isolate the retry attempts below

    const [r1, r2] = await Promise.allSettled([svc.retryTicket(root, t1.id), svc.retryTicket(root, t1.id)]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(mail.sent).toHaveLength(1); // exactly one mail.send call, not two
    expect((await m.collections.compTickets.findOne({ _id: t1.id }))!.status).toBe('executed');
  });

  it('audit visibility: super-admin sees all entries, ops sees only their own', async () => {
    const root = await actorOf(svc, 'root');
    const ops = await actorOf(svc, 'opsy');
    await svc.initiateTicket(ops, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    const all = await svc.listAudit(root, {});
    const opsActions = new Set(all.map((e) => e.actor));
    expect(opsActions.has(ops.adminId)).toBe(true);
    expect(opsActions.has(root.adminId)).toBe(true);
    const mine = await svc.listAudit(ops, {});
    expect(mine.every((e) => e.actor === ops.adminId)).toBe(true);
  });

  it('player.lookup by publicId + not found', async () => {
    expect(await svc.lookupPlayer('123456789')).toMatchObject({ displayName: 'Alice', rank: 'gold' });
    await expect(svc.lookupPlayer('999999999')).rejects.toMatchObject({ status: 404 });
  });

  it('player.lookup surfaces the banned flag from the player client (2026-07-18 Player Lookup ban-visibility fix)', async () => {
    expect(await svc.lookupPlayer('123456789')).toMatchObject({ banned: false });
    expect(await svc.lookupPlayer('999999998')).toMatchObject({ banned: true });
  });

  it('anticheat.action: manual ban/unban (S4-4) is idempotent and toggles the backing store', async () => {
    expect(await svc.banAccount('acc-1')).toEqual({ ok: true });
    expect(suspiciousPve.banned.has('acc-1')).toBe(true);
    // Idempotent: banning an already-banned account still succeeds.
    expect(await svc.banAccount('acc-1')).toEqual({ ok: true });
    expect(await svc.unbanAccount('acc-1')).toEqual({ ok: true });
    expect(suspiciousPve.banned.has('acc-1')).toBe(false);
    // Idempotent: unbanning an already-clear account still succeeds.
    expect(await svc.unbanAccount('acc-1')).toEqual({ ok: true });
  });

  it('player.password_reset: resets via the player client + audits; surfaces the client error for a passwordless account', async () => {
    const root = await actorOf(svc, 'root');
    await svc.resetPlayerPassword(root.adminId, 'acc-1', '123456');
    const entries = await svc.listAudit(root, {});
    expect(entries.some((e) => e.action === 'player.password_reset' && e.target === 'acc-1')).toBe(true);
    await expect(svc.resetPlayerPassword(root.adminId, 'no-password-account', '123456')).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.resetPlayerPassword(root.adminId, 'acc-1', 'short')).rejects.toMatchObject({ status: 400 });
  });

  it('anticheat review resolve (2026-07-18 policy: PvE reject no longer auto-bans, human decides ban vs dismiss)', async () => {
    const root = await actorOf(svc, 'root');
    antiCheat.rows.push({
      _id: 'pve:verify-1',
      kind: 'pve_reject',
      accountId: 'acc-1',
      levelId: 'ch1_lv7',
      claimedStars: 2,
      judgedStars: 0,
      rejectCountAfter: 1,
      severity: 'normal',
      status: 'open',
      ts: 1,
    });
    antiCheat.rows.push({
      _id: 'pve:verify-2',
      kind: 'pve_reject',
      accountId: 'acc-2',
      levelId: 'ch1_lv9',
      claimedStars: 2,
      judgedStars: 1,
      rejectCountAfter: 3,
      severity: 'high',
      status: 'open',
      ts: 2,
    });
    // Dismiss: no ban, just marks the review resolved.
    await svc.resolveAntiCheatReview(root.adminId, 'pve:verify-1', 'acc-1', 'dismissed');
    expect(suspiciousPve.banned.has('acc-1')).toBe(false);
    expect(antiCheat.rows[0]).toMatchObject({ status: 'reviewed', resolution: 'dismissed', resolvedBy: root.adminId });
    // Ban: goes through the same manual-ban backing store as Player Lookup's Ban button.
    await svc.resolveAntiCheatReview(root.adminId, 'pve:verify-2', 'acc-2', 'banned');
    expect(suspiciousPve.banned.has('acc-2')).toBe(true);
    expect(antiCheat.rows[1]).toMatchObject({ status: 'reviewed', resolution: 'banned' });
    // Audited under account.ban when banned, so it's visible in the same audit trail as manual bans.
    const entries = await svc.listAudit(root, {});
    expect(entries.some((e) => e.action === 'account.ban' && e.target === 'acc-2')).toBe(true);
    // Unknown review id → 404.
    await expect(svc.resolveAntiCheatReview(root.adminId, 'no-such-review', 'acc-3', 'dismissed')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('sampling writes metricSnapshots → trend queryable', async () => {
    await svc.sampleOnce();
    await svc.sampleOnce();
    const points = await svc.trend({ metric: 'online' });
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBe(5);
  });

  // Regression for the 2026-07-29 audit fix: analyticsSummary used to run one unlimited
  // `find({metric,ts:{$gte}}).toArray()` per METRIC_KEY, pulling every last-24h snapshot into app memory
  // just to reduce() avg/peak/samples. Replaced with a single $group aggregation across all metrics —
  // this asserts the aggregated numbers are still correct (avg/peak/samples), not just "doesn't throw".
  it('analyticsSummary aggregates avg/peak/samples per metric over the last 24h', async () => {
    await svc.sampleOnce(); // online=5, queue=2, rooms=1, gameInstances=1, gameLoad=3
    await svc.sampleOnce(); // same stub values again
    const summary = await svc.analyticsSummary();
    expect(summary.last24h.online).toEqual({ avg: 5, peak: 5, samples: 2 });
    expect(summary.last24h.queue).toEqual({ avg: 2, peak: 2, samples: 2 });
    expect(summary.last24h.gameLoad).toEqual({ avg: 3, peak: 3, samples: 2 });
    // A metric with zero samples in the window reports zeroed-out stats, not undefined/NaN.
    const untouched = await m.collections.metricSnapshots.deleteMany({});
    expect(untouched.deletedCount).toBeGreaterThan(0);
    const empty = await svc.analyticsSummary();
    expect(empty.last24h.online).toEqual({ avg: 0, peak: 0, samples: 0 });
  });

  it('account management: create account + cannot disable/demote self', async () => {
    const root = await actorOf(svc, 'root');
    await expect(svc.updateAccount(root, root.adminId, { disabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateAccount(root, root.adminId, { role: 'viewer' })).rejects.toMatchObject({ status: 400 });
    const accts = await svc.listAccounts();
    expect(accts.map((a) => a.username).sort()).toEqual(['csr', 'opsy', 'root']);
  });
});
