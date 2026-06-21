// admin 业务核心（OPS_DESIGN §2/§3/§5）。RBAC + 账号管理 + 补偿审批工单流 + 审计 + 监控/趋势 + 采样。
// httpApi 负责鉴权（admin JWT）+ 静态能力门；本类负责业务不变量（发起≠审批、额度→审批能力、
// 工单状态机）+ 审计落库。所有写操作经此 → 单一真相。
import { randomUUID } from 'node:crypto';
import {
  ADMIN_ROLES,
  capabilitiesForRole,
  hashPassword,
  isAdminRole,
  requiredApproveCapability,
  requiredInitiateCapability,
  roleHasCapability,
  tierForAttachments,
  totalCoinValue,
  validatePassword,
  verifyPassword,
  createLogger,
  type AdminAccountView,
  type AdminCapability,
  type AdminRole,
  type AuditAction,
  type AuditEntryView,
  type CompAttachment,
  type CompMailContent,
  type CompScope,
  type CompTarget,
  type CompTicketStatus,
  type CompTicketView,
  type LiveStats,
  type MetricKey,
  type TrendPoint,
} from '@nw/shared';
import { METRIC_KEYS } from '@nw/shared';
import type { AdminAccountDoc, AdminCollections, AuditDoc, CompTicketDoc } from './db';
import type { AnalyticsClient, AnalyticsQueryResult, AntiCheatClient, AntiCheatReviewRow, MailDispatcher, PlayerClient, PlayerProfile, StatsClient, WorldClient, SlgWorldSummary } from './clients';

const log = createLogger('admin:service');

/** 端点错误（httpApi 据 status 映射 HTTP 码）。 */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AdminError';
  }
}

/** 已认证的运维主体（httpApi 从 admin JWT 解出账号后注入）。 */
export interface Actor {
  adminId: string;
  username: string;
  displayName: string;
  role: AdminRole;
}

export interface AdminServiceDeps {
  cols: AdminCollections;
  stats: StatsClient;
  players: PlayerClient;
  antiCheat: AntiCheatClient;
  mail: MailDispatcher;
  analytics: AnalyticsClient;
  world: WorldClient;
  now: () => number;
}

const ALL_TICKET_STATUS: readonly CompTicketStatus[] = [
  'pending',
  'approved',
  'executed',
  'rejected',
  'cancelled',
  'failed',
];

// 登录失败限流（OPS_DESIGN §6「登录失败限流」）。admin 同时持内部密钥 + 对运维开端口，
// 是攻击高地；按登录名滑动窗口计数，达阈值即锁定一段时间。内存态（admin 单实例够用，
// 多实例横扩时迁 Redis）。
const LOGIN_MAX_FAILURES = 5; // 窗口内最大失败次数
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 失败计数滑动窗口
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 触发后锁定时长

interface LoginAttempt {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

export class AdminService {
  private readonly cols: AdminCollections;
  private readonly stats: StatsClient;
  private readonly players: PlayerClient;
  private readonly antiCheat: AntiCheatClient;
  private readonly mail: MailDispatcher;
  private readonly analytics: AnalyticsClient;
  private readonly world: WorldClient;
  private readonly now: () => number;
  /** 登录失败限流表（按登录名，内存态）。 */
  private readonly loginAttempts = new Map<string, LoginAttempt>();

  constructor(deps: AdminServiceDeps) {
    this.cols = deps.cols;
    this.stats = deps.stats;
    this.players = deps.players;
    this.antiCheat = deps.antiCheat;
    this.mail = deps.mail;
    this.analytics = deps.analytics;
    this.world = deps.world;
    this.now = deps.now;
  }

  // ───────────────────── SLG 赛季运维（G7/§17.7）─────────────────────
  // worldsvc /admin/world/* 代理 + 审计 + 运维序列约束（reset 前必须 settle，防丢历史）。

  /** 列出各大区运维概要（capability slg.season.view）。worldsvc 不可达 → 空表。 */
  async slgListWorlds(): Promise<SlgWorldSummary[]> {
    if (!this.world.available) return [];
    return this.world.listWorlds();
  }

  /** 开新大区（高危，仅 super）。审计。 */
  async slgOpenSeason(actor: string, worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.world.openWorld(worldId, season, shard, capacity);
    await this.audit(actor, 'slg.season.open', { target: worldId, summary: `s${season}-${shard} cap=${capacity}` });
  }

  /** 结算大区（落 seasonResults + 发奖）。审计。 */
  async slgSettleSeason(actor: string, worldId: string): Promise<unknown> {
    const r = await this.world.settleWorld(worldId);
    await this.audit(actor, 'slg.season.settle', { target: worldId });
    return r;
  }

  /**
   * 重置大区（清档重开，高危）。运维序列约束：reset 前必须已 settle（status=settling/resetting），
   * 否则拒绝（防跳过结算丢 seasonResults 历史，§17.7）。worldsvc 端亦有同守卫（双保险）。
   */
  async slgResetSeason(actor: string, worldId: string): Promise<unknown> {
    const worlds = await this.world.listWorlds();
    const w = worlds.find((x) => x.worldId === worldId);
    if (w && w.status !== 'settling' && w.status !== 'resetting') {
      throw new AdminError(409, 'conflict', `重置前须先结算（当前 status=${w.status}，应为 settling）`);
    }
    const r = await this.world.resetWorld(worldId);
    await this.audit(actor, 'slg.season.reset', { target: worldId });
    return r;
  }

  /** 关闭大区（归档）。审计。 */
  async slgCloseSeason(actor: string, worldId: string): Promise<void> {
    await this.world.closeWorld(worldId);
    await this.audit(actor, 'slg.season.close', { target: worldId });
  }

  // ───────────────────────── 认证 ─────────────────────────

  /** 校验账号口令。成功返回账号（供 httpApi 签 token）；失败抛 AdminError。审计登录成败。 */
  async authenticate(username: string, password: string, ip?: string): Promise<AdminAccountDoc> {
    const key = (username ?? '').trim().toLowerCase();
    // 限流闸门：达阈值即拒，连口令对错都不校验（防爆破 + 防计时旁路）。
    const lockedFor = this.loginLockedMs(key);
    if (lockedFor > 0) {
      await this.audit(`unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: `rate limited (${Math.ceil(lockedFor / 1000)}s left)`,
      });
      throw new AdminError(429, 'too_many_attempts', 'too many failed attempts, try again later');
    }

    const doc = await this.cols.adminAccounts.findOne({ username });
    if (!doc || doc.disabled || !(await verifyPassword(password, doc.passwordHash))) {
      this.recordLoginFailure(key);
      // 不区分「无此人/密码错/已禁用」对外，避免账号枚举；审计记原因。
      await this.audit(doc?._id ?? `unknown:${username}`, 'login.failed', {
        target: username,
        ...(ip ? { ip } : {}),
        summary: doc ? (doc.disabled ? 'disabled' : 'bad password') : 'no such user',
      });
      throw new AdminError(401, 'invalid_credentials', 'invalid username or password');
    }
    this.loginAttempts.delete(key); // 成功即清零
    await this.cols.adminAccounts.updateOne({ _id: doc._id }, { $set: { lastLoginAt: this.now() } });
    await this.audit(doc._id, 'login', { ...(ip ? { ip } : {}) });
    return doc;
  }

  /** 当前是否处于锁定中；返回剩余锁定毫秒（0 = 未锁）。 */
  private loginLockedMs(key: string): number {
    const a = this.loginAttempts.get(key);
    if (!a) return 0;
    const now = this.now();
    return a.lockedUntil > now ? a.lockedUntil - now : 0;
  }

  /** 记一次登录失败；窗口外重置计数，达阈值则锁定。 */
  private recordLoginFailure(key: string): void {
    const now = this.now();
    const a = this.loginAttempts.get(key);
    if (!a || now - a.windowStart > LOGIN_WINDOW_MS) {
      this.loginAttempts.set(key, { fails: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    a.fails += 1;
    if (a.fails >= LOGIN_MAX_FAILURES) {
      a.lockedUntil = now + LOGIN_LOCKOUT_MS;
      a.fails = 0; // 锁定后计数清零，解锁后重新计
      a.windowStart = now;
    }
  }

  async getAccount(adminId: string): Promise<AdminAccountDoc | null> {
    return this.cols.adminAccounts.findOne({ _id: adminId });
  }

  meView(doc: AdminAccountDoc): { admin: AdminAccountView; capabilities: AdminCapability[] } {
    return { admin: toAccountView(doc), capabilities: capabilitiesForRole(doc.role) };
  }

  // ───────────────────────── 账号管理（admin.manage）─────────────────────────

  async listAccounts(): Promise<AdminAccountView[]> {
    const docs = await this.cols.adminAccounts.find({}).sort({ createdAt: 1 }).toArray();
    return docs.map(toAccountView);
  }

  async createAccount(
    actor: Actor,
    input: { username: string; password: string; role: string; displayName: string },
  ): Promise<AdminAccountView> {
    const username = (input.username ?? '').trim();
    if (username.length < 3) throw new AdminError(400, 'bad_request', 'username too short (min 3)');
    if (!isAdminRole(input.role)) throw new AdminError(400, 'bad_request', 'invalid role');
    const pwErr = validatePassword(input.password);
    if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
    const exists = await this.cols.adminAccounts.findOne({ username });
    if (exists) throw new AdminError(409, 'conflict', 'username taken');

    const doc: AdminAccountDoc = {
      _id: randomUUID(),
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      displayName: (input.displayName ?? username).trim() || username,
      disabled: false,
      createdAt: this.now(),
      createdBy: actor.adminId,
    };
    try {
      await this.cols.adminAccounts.insertOne(doc);
    } catch (e) {
      // 唯一索引并发冲突。
      if ((e as { code?: number }).code === 11000) throw new AdminError(409, 'conflict', 'username taken');
      throw e;
    }
    await this.audit(actor.adminId, 'account.create', {
      target: doc._id,
      summary: `${username} (${doc.role})`,
    });
    return toAccountView(doc);
  }

  async updateAccount(
    actor: Actor,
    id: string,
    patch: { role?: string; disabled?: boolean; displayName?: string },
  ): Promise<AdminAccountView> {
    const doc = await this.cols.adminAccounts.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such account');
    const set: Partial<AdminAccountDoc> = {};
    if (patch.role !== undefined) {
      if (!isAdminRole(patch.role)) throw new AdminError(400, 'bad_request', 'invalid role');
      // 防止超管把自己降级后无人能管理（至少留一个启用的超管）。
      if (doc._id === actor.adminId && patch.role !== 'super') {
        throw new AdminError(400, 'bad_request', 'cannot demote yourself');
      }
      set.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (doc._id === actor.adminId && patch.disabled) {
        throw new AdminError(400, 'bad_request', 'cannot disable yourself');
      }
      set.disabled = patch.disabled;
    }
    if (patch.displayName !== undefined) {
      const dn = patch.displayName.trim();
      if (dn) set.displayName = dn;
    }
    if (Object.keys(set).length === 0) return toAccountView(doc);
    await this.cols.adminAccounts.updateOne({ _id: id }, { $set: set });
    await this.audit(actor.adminId, 'account.update', {
      target: id,
      summary: JSON.stringify(set),
    });
    return toAccountView({ ...doc, ...set });
  }

  async resetPassword(actor: Actor, id: string, password: string): Promise<void> {
    const pwErr = validatePassword(password);
    if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
    const doc = await this.cols.adminAccounts.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such account');
    await this.cols.adminAccounts.updateOne(
      { _id: id },
      { $set: { passwordHash: await hashPassword(password) } },
    );
    await this.audit(actor.adminId, 'account.reset_password', { target: id });
  }

  // ───────────────────────── 补偿工单 ─────────────────────────

  async initiateTicket(
    actor: Actor,
    input: { scope: string; target: CompTarget; mail: CompMailContent; reason: string },
  ): Promise<CompTicketView> {
    const scope = input.scope;
    if (scope !== 'single' && scope !== 'global') {
      throw new AdminError(400, 'bad_request', 'scope must be single|global');
    }
    // 发起能力校验（个人 vs 全服）。
    this.requireCap(actor, requiredInitiateCapability(scope));

    const reason = (input.reason ?? '').trim();
    if (!reason) throw new AdminError(400, 'bad_request', 'reason required');
    const mail = validateMail(input.mail);
    const target = validateTarget(scope, input.target);

    // 个人补偿据附件总当量分级；全服恒走超管审批（amountTier 仅审计语义，能力由 scope 决定）。
    const amountTier = scope === 'global' ? 'overquota' : tierForAttachments(mail.attachments);

    const doc: CompTicketDoc = {
      _id: randomUUID(),
      scope,
      target,
      mail,
      reason,
      status: 'pending',
      amountTier,
      initiatedBy: actor.adminId,
      initiatedAt: this.now(),
      dispatchKey: randomUUID(),
    };
    await this.cols.compTickets.insertOne(doc);
    await this.audit(actor.adminId, 'comp.initiate', {
      target: doc._id,
      summary: `${scope} ${describeTarget(target)} value=${totalCoinValue(mail.attachments)} tier=${amountTier}`,
    });
    return this.toTicketView(doc);
  }

  async listTickets(filter: { status?: string }): Promise<CompTicketView[]> {
    const q: Partial<Record<'status', CompTicketStatus>> = {};
    if (filter.status) {
      if (!ALL_TICKET_STATUS.includes(filter.status as CompTicketStatus)) {
        throw new AdminError(400, 'bad_request', 'invalid status');
      }
      q.status = filter.status as CompTicketStatus;
    }
    const docs = await this.cols.compTickets.find(q).sort({ initiatedAt: -1 }).limit(200).toArray();
    return Promise.all(docs.map((d) => this.toTicketView(d)));
  }

  /**
   * 审批 → 自动执行（OPS_DESIGN §3.3）。校验：①工单 pending；②审批人 ≠ 发起人；
   * ③审批人具备该 scope/tier 所需能力。通过即置 approved 并立刻执行（投递系统邮件）。
   */
  async approveTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    if (doc.initiatedBy === actor.adminId) {
      throw new AdminError(403, 'forbidden', 'initiator cannot approve own ticket');
    }
    this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));

    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', approvedBy: actor.adminId, approvedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.approve', { target: id, summary: doc.scope });

    return this.execute(res);
  }

  async rejectTicket(actor: Actor, id: string, note: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    if (doc.initiatedBy === actor.adminId) {
      throw new AdminError(403, 'forbidden', 'initiator cannot reject own ticket');
    }
    this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'rejected', approvedBy: actor.adminId, approvedAt: this.now(), error: note } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.reject', { target: id, summary: note });
    return this.toTicketView(res);
  }

  /** 撤销（仅 pending；发起人或超管）。 */
  async cancelTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'pending') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    if (doc.initiatedBy !== actor.adminId && actor.role !== 'super') {
      throw new AdminError(403, 'forbidden', 'only initiator or super can cancel');
    }
    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'cancelled', approvedBy: actor.adminId, approvedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.cancel', { target: id });
    return this.toTicketView(res);
  }

  /** 全服补偿 dry-run 命中人数预览（OPS_DESIGN §3.3 安全阀）。 */
  async preview(input: { scope: string; target: CompTarget }): Promise<{ recipientCount: number; available: boolean }> {
    if (input.scope !== 'single' && input.scope !== 'global') {
      throw new AdminError(400, 'bad_request', 'scope must be single|global');
    }
    const target = validateTarget(input.scope, input.target);
    if (input.scope === 'single') return { recipientCount: 1, available: true };
    const r = await this.mail.preview({ scope: 'global', target });
    return { recipientCount: r.recipientCount, available: r.ok };
  }

  /** 重试执行失败的工单（failed → 重新投递；幂等键不变，邮件后端据此防重复）。 */
  async retryTicket(actor: Actor, id: string): Promise<CompTicketView> {
    const doc = await this.cols.compTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'failed') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    this.requireCap(actor, requiredApproveCapability(doc.scope, doc.amountTier));
    return this.execute(doc);
  }

  /**
   * 执行器：调 meta 系统邮件端点（带 dispatchKey 幂等）。成功 executed（回填 recipientCount），
   * 失败 failed（可重试）。执行 ≠ 入账——只是把邮件投到玩家邮箱，领取时才经 commercial/inventory。
   */
  private async execute(doc: CompTicketDoc): Promise<CompTicketView> {
    const res = await this.mail.send({
      dispatchKey: doc.dispatchKey,
      scope: doc.scope,
      target: doc.target,
      subject: doc.mail.subject,
      body: doc.mail.body,
      attachments: doc.mail.attachments,
      expireDays: doc.mail.expireDays,
    });
    if (res.ok) {
      const updated = await this.cols.compTickets.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            status: 'executed',
            executedAt: this.now(),
            ...(typeof res.recipientCount === 'number' ? { recipientCount: res.recipientCount } : {}),
          },
          $unset: { error: '' },
        },
        { returnDocument: 'after' },
      );
      await this.audit(doc.initiatedBy, 'comp.execute', {
        target: doc._id,
        summary: `recipients=${res.recipientCount ?? '?'}`,
      });
      return this.toTicketView(updated ?? doc);
    }
    const err = res.error ?? 'mail dispatch failed';
    const updated = await this.cols.compTickets.findOneAndUpdate(
      { _id: doc._id },
      { $set: { status: 'failed', error: err } },
      { returnDocument: 'after' },
    );
    log.warn('ticket execute failed', { ticketId: doc._id, err });
    await this.audit(doc.initiatedBy, 'comp.execute.failed', { target: doc._id, summary: err });
    return this.toTicketView(updated ?? { ...doc, status: 'failed', error: err });
  }

  // ───────────────────────── 审计 ─────────────────────────

  /**
   * 审计查询。audit.view.all → 全部（可按 actor 过滤）；否则仅本人（actor.view.self）。
   * httpApi 已校验「至少 audit.view.self」；此处据能力收窄可见范围。
   */
  async listAudit(
    actor: Actor,
    filter: { actor?: string; from?: number; to?: number },
  ): Promise<AuditEntryView[]> {
    const canAll = roleHasCapability(actor.role, 'audit.view.all');
    const q: Record<string, unknown> = {};
    if (canAll) {
      if (filter.actor) q.actor = filter.actor;
    } else {
      q.actor = actor.adminId; // 强制只看自己
    }
    if (filter.from !== undefined || filter.to !== undefined) {
      const ts: Record<string, number> = {};
      if (filter.from !== undefined) ts.$gte = filter.from;
      if (filter.to !== undefined) ts.$lte = filter.to;
      q.ts = ts;
    }
    const docs = await this.cols.auditLog.find(q).sort({ ts: -1 }).limit(500).toArray();
    const names = await this.actorNames(docs.map((d) => d.actor));
    return docs.map((d) => ({
      id: d._id,
      actor: d.actor,
      ...(names.get(d.actor) ? { actorName: names.get(d.actor)! } : {}),
      action: d.action,
      ...(d.target ? { target: d.target } : {}),
      ...(d.summary ? { summary: d.summary } : {}),
      ...(d.ip ? { ip: d.ip } : {}),
      ts: d.ts,
    }));
  }

  // ───────────────────────── 监控 / 趋势 / 分析 ─────────────────────────

  async liveStats(): Promise<LiveStats & { available: boolean }> {
    const live = await this.stats.fetchLive();
    return { ...live, available: this.stats.available };
  }

  async trend(input: { metric: string; from?: number; to?: number }): Promise<TrendPoint[]> {
    if (!METRIC_KEYS.includes(input.metric as MetricKey)) {
      throw new AdminError(400, 'bad_request', 'invalid metric');
    }
    const q: Record<string, unknown> = { metric: input.metric };
    if (input.from !== undefined || input.to !== undefined) {
      const ts: Record<string, number> = {};
      if (input.from !== undefined) ts.$gte = input.from;
      if (input.to !== undefined) ts.$lte = input.to;
      q.ts = ts;
    }
    const docs = await this.cols.metricSnapshots
      .find(q)
      .sort({ ts: 1 })
      .limit(2000)
      .toArray();
    return docs.map((d) => ({ ts: d.ts, value: d.value }));
  }

  /** 数据分析概览（自采指标聚合 + 工单态统计）。 */
  async analyticsSummary(): Promise<{
    live: LiveStats & { available: boolean };
    last24h: Record<MetricKey, { avg: number; peak: number; samples: number }>;
    tickets: Record<CompTicketStatus, number>;
  }> {
    const live = await this.liveStats();
    const since = this.now() - 24 * 3600 * 1000;
    const last24h = {} as Record<MetricKey, { avg: number; peak: number; samples: number }>;
    for (const metric of METRIC_KEYS) {
      const docs = await this.cols.metricSnapshots
        .find({ metric, ts: { $gte: since } })
        .toArray();
      const samples = docs.length;
      const sum = docs.reduce((s, d) => s + d.value, 0);
      const peak = docs.reduce((m, d) => Math.max(m, d.value), 0);
      last24h[metric] = { avg: samples ? sum / samples : 0, peak, samples };
    }
    const tickets = {} as Record<CompTicketStatus, number>;
    for (const st of ALL_TICKET_STATUS) {
      tickets[st] = await this.cols.compTickets.countDocuments({ status: st });
    }
    return { live, last24h, tickets };
  }

  /** 埋点聚合查询（代理到 analyticsvc /internal/query，A9-6）。 */
  async analyticsQuery(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult & { available: boolean }> {
    if (!this.analytics.available) return { available: false };
    const result = await this.analytics.query(type, days, platform);
    return { ...result, available: true };
  }

  /** 玩家查询（player.lookup）。 */
  async lookupPlayer(publicId: string): Promise<PlayerProfile> {
    const pid = (publicId ?? '').trim();
    if (!/^\d{9}$/.test(pid)) throw new AdminError(400, 'bad_request', 'publicId must be 9 digits');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const p = await this.players.lookupByPublicId(pid);
    if (!p) throw new AdminError(404, 'not_found', 'no such player');
    return p;
  }

  /** 成就反作弊审查队列（anticheat.view，S9-7）。默认 open；可按 accountId 过滤。审计。 */
  async listAntiCheatReviews(
    actor: string,
    opts: { accountId?: string; status?: string; limit?: number } = {},
  ): Promise<AntiCheatReviewRow[]> {
    if (!this.antiCheat.available) {
      throw new AdminError(503, 'unavailable', 'anti-cheat backend unavailable');
    }
    const rows = await this.antiCheat.listReviews(opts);
    await this.audit(actor, 'anticheat.view', {
      ...(opts.accountId ? { target: opts.accountId } : {}),
      summary: `${rows.length} reviews (status=${opts.status ?? 'open'})`,
    });
    return rows;
  }

  // ───────────────────────── 采样（OPS_DESIGN §5）─────────────────────────

  /** 拉一次实时态写时序快照（采样定时器调）。出错记 0（采样不中断）。 */
  async sampleOnce(): Promise<void> {
    const live = await this.stats.fetchLive();
    const ts = this.now();
    const at = new Date(ts);
    const vals: Record<MetricKey, number> = {
      online: live.online,
      queue: live.queue,
      rooms: live.rooms,
      gameInstances: live.gameInstances,
      gameLoad: live.gameLoad ?? 0,
    };
    await this.cols.metricSnapshots.insertMany(
      METRIC_KEYS.map((metric) => ({ metric, ts, value: vals[metric], at })),
    );
  }

  // ───────────────────────── 内部 ─────────────────────────

  private requireCap(actor: Actor, cap: AdminCapability): void {
    if (!roleHasCapability(actor.role, cap)) {
      throw new AdminError(403, 'forbidden', `missing capability: ${cap}`);
    }
  }

  /** 写一条审计（best-effort，不抛 —— 审计失败不应阻断主操作，但要打日志）。 */
  async audit(
    actor: string,
    action: AuditAction,
    extra: { target?: string; summary?: string; ip?: string } = {},
  ): Promise<void> {
    const doc: AuditDoc = {
      _id: randomUUID(),
      actor,
      action,
      ...(extra.target ? { target: extra.target } : {}),
      ...(extra.summary ? { summary: extra.summary } : {}),
      ...(extra.ip ? { ip: extra.ip } : {}),
      ts: this.now(),
    };
    try {
      await this.cols.auditLog.insertOne(doc);
    } catch (e) {
      log.error('audit write failed', { action, err: (e as Error).message });
    }
  }

  private async actorNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)].filter((x) => !x.startsWith('unknown:'));
    const out = new Map<string, string>();
    if (uniq.length === 0) return out;
    const docs = await this.cols.adminAccounts
      .find({ _id: { $in: uniq } }, { projection: { displayName: 1, username: 1 } })
      .toArray();
    for (const d of docs) out.set(d._id, d.displayName || d.username);
    return out;
  }

  private async toTicketView(doc: CompTicketDoc): Promise<CompTicketView> {
    const names = await this.actorNames(
      [doc.initiatedBy, doc.approvedBy].filter((x): x is string => !!x),
    );
    return {
      id: doc._id,
      scope: doc.scope,
      target: doc.target,
      mail: doc.mail,
      reason: doc.reason,
      status: doc.status,
      amountTier: doc.amountTier,
      initiatedBy: doc.initiatedBy,
      ...(names.get(doc.initiatedBy) ? { initiatedByName: names.get(doc.initiatedBy)! } : {}),
      initiatedAt: doc.initiatedAt,
      ...(doc.approvedBy ? { approvedBy: doc.approvedBy } : {}),
      ...(doc.approvedBy && names.get(doc.approvedBy) ? { approvedByName: names.get(doc.approvedBy)! } : {}),
      ...(doc.approvedAt ? { approvedAt: doc.approvedAt } : {}),
      ...(doc.executedAt ? { executedAt: doc.executedAt } : {}),
      ...(typeof doc.recipientCount === 'number' ? { recipientCount: doc.recipientCount } : {}),
      ...(doc.error ? { error: doc.error } : {}),
    };
  }
}

// ── 纯函数辅助 ──────────────────────────────────────────
function toAccountView(doc: AdminAccountDoc): AdminAccountView {
  return {
    id: doc._id,
    username: doc.username,
    role: doc.role,
    displayName: doc.displayName,
    disabled: doc.disabled,
    createdAt: doc.createdAt,
    ...(doc.createdBy ? { createdBy: doc.createdBy } : {}),
    ...(doc.lastLoginAt ? { lastLoginAt: doc.lastLoginAt } : {}),
  };
}

function validateMail(mail: CompMailContent | undefined): CompMailContent {
  if (!mail || typeof mail !== 'object') throw new AdminError(400, 'bad_request', 'mail required');
  const subject = (mail.subject ?? '').trim();
  const body = (mail.body ?? '').trim();
  if (!subject) throw new AdminError(400, 'bad_request', 'mail subject required');
  if (!body) throw new AdminError(400, 'bad_request', 'mail body required');
  const attachments: CompAttachment[] = Array.isArray(mail.attachments) ? mail.attachments : [];
  for (const a of attachments) {
    if (a.kind !== 'coins' && a.kind !== 'item' && a.kind !== 'skin') {
      throw new AdminError(400, 'bad_request', 'invalid attachment kind');
    }
    if ((a.kind === 'item' || a.kind === 'skin') && !a.id) {
      throw new AdminError(400, 'bad_request', `${a.kind} attachment requires id`);
    }
    if (a.count !== undefined && (!Number.isFinite(a.count) || a.count < 0)) {
      throw new AdminError(400, 'bad_request', 'invalid attachment count');
    }
  }
  const expireDays = Number.isFinite(mail.expireDays) && mail.expireDays > 0 ? Math.floor(mail.expireDays) : 30;
  return { subject, body, attachments, expireDays };
}

function validateTarget(scope: CompScope, target: CompTarget | undefined): CompTarget {
  if (scope === 'single') {
    const pid = (target as { publicId?: string } | undefined)?.publicId;
    if (typeof pid !== 'string' || !/^\d{9}$/.test(pid.trim())) {
      throw new AdminError(400, 'bad_request', 'single target requires 9-digit publicId');
    }
    return { publicId: pid.trim() };
  }
  // global：一期仅 all。
  return { filter: { kind: 'all' } };
}

function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? `#${target.publicId}` : `filter:${target.filter.kind}`;
}

export { ADMIN_ROLES };
