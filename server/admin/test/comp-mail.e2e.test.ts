// OPS 补偿工单 ↔ meta 系统邮件 双进程联调（OPS_DESIGN §3.3 / §4.1，SOCIAL_DESIGN S6-3）。
// 这是「契约已对接但未实跑」那条待办的真实联调：admin 的 **真实 HttpMailDispatcher / HttpPlayerClient**
// 经 `fetch` 打一个 **真实 listen 的 meta 进程**（非 fastify inject），跑通整条链：
//   工单 发起 → 审批 → 自动执行（HttpMailDispatcher.send → meta /internal/mail/system/send →
//   insertSystemMail）→ 玩家收件箱有信 → 领取附件（commercial grant + inventory）→ 钱包入账。
// 覆盖：单人补偿全链 / dispatchKey 幂等 / 全服 fan-out + preview / player.lookup / 鉴权边界（错 key→failed）
//   / 收件人不存在→failed。
//
// 需 `cd server && docker compose up -d` + 先 `npx tsc -b shared metaserver admin commercial`（导入 meta dist）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
// meta 是 ESM 包：导入编译产物 dist（与 metaserver/test/*.e2e 同约定，须先 tsc -b）。
import { buildApp } from '../../metaserver/dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../../metaserver/dist/gatewayClient.js';
import type { CommercialClient } from '../../metaserver/dist/commercialClient.js';
// admin 侧用真实 HTTP 客户端 + service（跑 src，vitest 转译）。
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService, type Actor } from '../src/service';
import { HttpMailDispatcher, HttpPlayerClient, type StatsClient } from '../src/clients';
import { seedSuperAdmin } from '../src/seed';
import type { LiveStats } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const META_DB = 'nw_meta_comp_test';
const ADMIN_DB = 'nw_admin_comp_test';
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

const metaMongo = await tryMeta();
const adminMongo = await tryAdmin();
if (!metaMongo || !adminMongo) {
  console.warn(`[comp-mail.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

// —— 假 gateway（验证 mail_new push）+ 假 commercial（领取发币）——
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

describe.skipIf(!metaMongo || !adminMongo)('OPS comp ticket ↔ meta system mail (cross-process)', () => {
  const meta = metaMongo!;
  const admin = adminMongo!;
  let app: FastifyInstance; // 真实 listen 的 meta 进程
  let baseUrl: string;
  let gateway: FakeGateway;
  let comm: FakeCommercial;
  let svc: AdminService;

  const bodyOf = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // 经真实 meta 进程注册玩家（HTTP，inject 即可——被测对象是 admin→meta 的链路）。
  async function newPlayer(deviceId: string): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = bodyOf(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    // 确保存档存在（领取附件需写钱包镜像到 save）。
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
    app = await buildApp({ cols: meta.collections, jwt, internalKey: KEY, gateway, commercial: comm });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    await meta.db.dropDatabase().catch(() => {});
    await admin.db.dropDatabase().catch(() => {});
    await meta.close();
    await admin.close();
  });

  beforeEach(async () => {
    await meta.db.dropDatabase();
    await meta.ensureIndexes();
    await admin.db.dropDatabase();
    await admin.ensureIndexes(3600);
    gateway.pushes = [];
    comm.coins.clear();
    comm.granted.clear();
    // 真实 HTTP 客户端指向 listen 的 meta。
    const mail = new HttpMailDispatcher(baseUrl, KEY);
    const players = new HttpPlayerClient(baseUrl, KEY);
    svc = new AdminService({ cols: admin.collections, stats: stubStats, players, mail, now });
    await seedSuperAdmin(admin.collections, 'root', 'rootpass', now);
    const root = await actorOf('root');
    await svc.createAccount(root, { username: 'opsy', password: 'opspass', role: 'ops', displayName: 'Ops' });
    await svc.createAccount(root, { username: 'csr', password: 'csrpass', role: 'support', displayName: 'CS' });
  });

  it('full chain: csr 发起 → ops 审批 → 真实 HTTP 投递 → 玩家收件箱有信 → 领取入账', async () => {
    const player = await newPlayer('comp-player-1');
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');

    const ticket = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: player.publicId },
      mail: { subject: '补偿', body: '抱歉给您带来不便', attachments: [{ kind: 'coins', count: 500 }], expireDays: 7 },
      reason: '卡单补偿',
    });
    expect(ticket.status).toBe('pending');

    const executed = await svc.approveTicket(ops, ticket.id);
    expect(executed.status).toBe('executed');
    expect(executed.recipientCount).toBe(1);

    // meta 侧：玩家真的收到这封系统邮件（经真实 HTTP 链路写入）。
    const inbox = await getMail(player.token);
    expect(inbox.data.mail).toHaveLength(1);
    const mail = inbox.data.mail[0];
    expect(mail.from).toBe('system');
    expect(mail.subject).toBe('补偿');
    expect(mail.attachments[0]).toMatchObject({ kind: 'coins', count: 500 });
    // mail_new push 已下发给收件人。
    expect(gateway.pushes.some((p) => p.accountId === player.accountId && p.msg.kind === 'mail_new')).toBe(true);

    // 领取附件 → 钱包入账（admin 从不直接写钱包，钱在领取时才经 commercial 入账）。
    const claim = bodyOf(await app.inject({ method: 'POST', url: `/mail/${mail.mailId}/claim`, headers: auth(player.token), payload: {} }));
    expect(claim.ok).toBe(true);
    expect(claim.data.save.wallet.coins).toBe(500);
    expect(comm.bal(player.accountId)).toBe(500);
  });

  it('dispatchKey 幂等：同 key 重发不重复投递（真实 HTTP $setOnInsert）', async () => {
    const player = await newPlayer('comp-player-2');
    const mail = new HttpMailDispatcher(baseUrl, KEY);
    const req = {
      dispatchKey: 'comp-dup-001',
      scope: 'single' as const,
      target: { publicId: player.publicId },
      subject: '补偿',
      body: 'x',
      attachments: [{ kind: 'coins' as const, count: 100 }],
      expireDays: 7,
    };
    const r1 = await mail.send(req);
    const r2 = await mail.send(req);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // 仍然只有一封（dispatchKey 幂等）。
    const inbox = await getMail(player.token);
    expect(inbox.data.mail).toHaveLength(1);
  });

  it('全服 fan-out：preview + global 审批 → 每个账号各一封', async () => {
    const p1 = await newPlayer('comp-g-1');
    const p2 = await newPlayer('comp-g-2');
    const ops = await actorOf('opsy');
    const root = await actorOf('root');

    // dry-run preview 经真实 meta /internal/mail/system/preview。
    const preview = await svc.preview({ scope: 'global', target: { filter: { kind: 'all' } } });
    expect(preview.available).toBe(true);
    expect(preview.recipientCount).toBe(2);

    const g = await svc.initiateTicket(ops, {
      scope: 'global',
      target: { filter: { kind: 'all' } },
      mail: { subject: '全服福利', body: '登录领取', attachments: [{ kind: 'coins', count: 50 }], expireDays: 3 },
      reason: '版本福利',
    });
    const done = await svc.approveTicket(root, g.id); // 全服恒走超管
    expect(done.status).toBe('executed');
    expect(done.recipientCount).toBe(2);

    expect((await getMail(p1.token)).data.mail).toHaveLength(1);
    expect((await getMail(p2.token)).data.mail).toHaveLength(1);
  });

  it('player.lookup 经真实 meta /internal/player 反查档案', async () => {
    const player = await newPlayer('comp-lookup-1');
    const profile = await svc.lookupPlayer(player.publicId);
    expect(profile.publicId).toBe(player.publicId);
    expect(profile.accountId).toBe(player.accountId);
    expect(typeof profile.elo).toBe('number'); // 有存档 → 带 pvp 字段
  });

  it('鉴权边界：错误内部密钥 → meta 401 → 工单 failed（可重试）', async () => {
    const player = await newPlayer('comp-badkey-1');
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');
    // 用错误密钥的 dispatcher 装配 service。
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
    // 玩家没收到信。
    expect((await getMail(player.token)).data.mail).toHaveLength(0);
  });

  it('收件人不存在：single target publicId 查无此人 → 工单 failed', async () => {
    const cs = await actorOf('csr');
    const ops = await actorOf('opsy');
    const ticket = await svc.initiateTicket(cs, {
      scope: 'single',
      target: { publicId: '000000001' }, // 9 位但无此账号
      mail: { subject: 's', body: 'b', attachments: [{ kind: 'coins', count: 10 }], expireDays: 7 },
      reason: 'r',
    });
    const failed = await svc.approveTicket(ops, ticket.id);
    expect(failed.status).toBe('failed');
  });
});
