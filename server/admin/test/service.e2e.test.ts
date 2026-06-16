// admin service 端到端（OPS_DESIGN §8 验证）：真实 Mongo 专属库。Mongo 不可达整套 skip。
//   登录/RBAC 拒绝、工单审批路由「发起≠审批」、超额走超管、global 走超管、dry-run、
//   幂等执行、审计可见性、账号管理。需 `cd server && docker compose up -d`。
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
  console.warn(`[admin.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

let t = 1000;
const now = (): number => t++;

// —— 假业务客户端（注入，不连真服务）——
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
    // 种子超管 + 一个运营 + 一个客服。
    await seedSuperAdmin(m.collections, 'root', 'rootpass', now);
    const root = await actorOf(svc, 'root');
    await svc.createAccount(root, { username: 'opsy', password: 'opspass', role: 'ops', displayName: 'Ops' });
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('登录成功签发 + 能力集；错误口令拒绝', async () => {
    const doc = await svc.authenticate('root', 'rootpass');
    const { capabilities } = svc.meView(doc);
    expect(capabilities).toContain('admin.manage');
    await expect(svc.authenticate('root', 'wrong')).rejects.toBeInstanceOf(AdminError);
  });

  it('登录失败限流：连错 5 次后锁定（429），即便口令正确也拒；成功登录清零', async () => {
    // 先确保未达阈值时正确口令仍可登录（计数到 4 不锁）。
    for (let i = 0; i < 4; i++) {
      await expect(svc.authenticate('root', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    await svc.authenticate('root', 'rootpass'); // 成功 → 计数清零
    // 再连错 5 次触发锁定。
    for (let i = 0; i < 5; i++) {
      await expect(svc.authenticate('root', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    // 锁定后即使口令正确也被 429 挡下。
    await expect(svc.authenticate('root', 'rootpass')).rejects.toMatchObject({ status: 429 });
    // 大小写/空白归一化为同一限流键。
    await expect(svc.authenticate(' ROOT ', 'rootpass')).rejects.toMatchObject({ status: 429 });
  });

  it('客服发起 + 运营审批个人补偿（normal）→ 自动执行投递邮件', async () => {
    const cs = await actorOf(svc, 'csr');
    const ops = await actorOf(svc, 'opsy');
    const t1 = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: '抱歉', body: '补偿', attachments: [{ kind: 'coins', count: 100 }], expireDays: 30 },
      reason: '卡单',
    });
    expect(t1.status).toBe('pending');
    expect(t1.amountTier).toBe('normal');
    const approved = await svc.approveTicket(ops, t1.id);
    expect(approved.status).toBe('executed');
    expect(approved.recipientCount).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('发起人不能审批自己的工单（发起≠审批）', async () => {
    const ops = await actorOf(svc, 'opsy');
    const t1 = await svc.initiateTicket(ops, {
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 30 },
      reason: 'r',
    });
    await expect(svc.approveTicket(ops, t1.id)).rejects.toMatchObject({ status: 403 });
  });

  it('超额个人补偿仅超管可审批（运营被拒）', async () => {
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

  it('客服不能发起全服补偿；运营可发起但仅超管审批', async () => {
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

  it('dry-run 预览命中人数', async () => {
    const ops = await actorOf(svc, 'opsy');
    expect(await svc.preview({ scope: 'global', target: { filter: { kind: 'all' } } })).toMatchObject({
      recipientCount: 100,
    });
    expect(await svc.preview({ scope: 'single', target: { publicId: '123456789' } })).toMatchObject({
      recipientCount: 1,
    });
    void ops;
  });

  it('执行失败→failed→retry 成功；dispatchKey 不变（幂等）', async () => {
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

  it('审计可见性：超管看全部，运营只看自己', async () => {
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

  it('player.lookup 按 publicId 反查 + 未找到', async () => {
    expect(await svc.lookupPlayer('123456789')).toMatchObject({ displayName: 'Alice', rank: 'gold' });
    await expect(svc.lookupPlayer('999999999')).rejects.toMatchObject({ status: 404 });
  });

  it('采样写 metricSnapshots → trend 可查', async () => {
    await svc.sampleOnce();
    await svc.sampleOnce();
    const points = await svc.trend({ metric: 'online' });
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBe(5);
  });

  it('账号管理：建账号 + 不能禁用/降级自己', async () => {
    const root = await actorOf(svc, 'root');
    await expect(svc.updateAccount(root, root.adminId, { disabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateAccount(root, root.adminId, { role: 'viewer' })).rejects.toMatchObject({ status: 400 });
    const accts = await svc.listAccounts();
    expect(accts.map((a) => a.username).sort()).toEqual(['csr', 'opsy', 'root']);
  });
});
