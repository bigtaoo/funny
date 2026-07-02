// admin service end-to-end (OPS_DESIGN §8 verification): dedicated real Mongo database. Entire suite skipped if Mongo is unreachable.
//   Login/RBAC rejection, ticket approval routing "initiator ≠ approver", over-quota routed to super-admin, global routed to super-admin, dry-run,
//   idempotent execution, audit visibility, account management. Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, AdminError, type Actor } from '../src/service';
import { seedSuperAdmin } from '../src/seed';
import type {
  MailDispatcher,
  MailSendReq,
  MailSendRes,
  MailPreviewReq,
  MailPreviewRes,
  PlayerClient,
  PlayerProfile,
  StatsClient,
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
  lookupByPublicId: async (publicId: string): Promise<PlayerProfile | null> =>
    publicId === '123456789' ? { publicId, displayName: 'Alice', rank: 'gold', elo: 1200, wins: 3, losses: 1 } : null,
};

async function actorOf(svc: AdminService, username: string): Promise<Actor> {
  const doc = (await svc.getAccount((await mongo!.collections.adminAccounts.findOne({ username }))!._id))!;
  return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
}

describe.skipIf(!mongo)('admin service e2e', () => {
  const m = mongo!;
  let svc: AdminService;
  let mail: FakeMail;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes(3600);
    mail = new FakeMail();
    svc = new AdminService({ cols: m.collections, stats: stubStats, players: stubPlayer, mail, now });
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
    expect(await svc.preview({ scope: 'global', target: { filter: { kind: 'all' } } })).toMatchObject({
      recipientCount: 100,
    });
    expect(await svc.preview({ scope: 'single', target: { publicId: '123456789' } })).toMatchObject({
      recipientCount: 1,
    });
    void ops;
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

  it('sampling writes metricSnapshots → trend queryable', async () => {
    await svc.sampleOnce();
    await svc.sampleOnce();
    const points = await svc.trend({ metric: 'online' });
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBe(5);
  });

  it('account management: create account + cannot disable/demote self', async () => {
    const root = await actorOf(svc, 'root');
    await expect(svc.updateAccount(root, root.adminId, { disabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateAccount(root, root.adminId, { role: 'viewer' })).rejects.toMatchObject({ status: 400 });
    const accts = await svc.listAccounts();
    expect(accts.map((a) => a.username).sort()).toEqual(['csr', 'opsy', 'root']);
  });
});
