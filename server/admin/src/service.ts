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
  FEATURE_FLAGS,
  FLAG_KEYS,
  FLAG_PLATFORMS,
  isFlagKey,
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
  type FeatureFlagDoc,
  type FlagKey,
  type FlagPlatform,
  type FlagRollout,
  type LiveStats,
  type MetricKey,
  type TradeAuditSnapshot,
  type TradeAuditTicketStatus,
  type TradeAuditTicketView,
  type TrendPoint,
} from '@nw/shared';
import { METRIC_KEYS } from '@nw/shared';
import type { AdminAccountDoc, AdminCollections, AuditDoc, CompTicketDoc, TradeAuditTicketDoc } from './db';
import type { AnalyticsClient, AnalyticsQueryResult, AntiCheatClient, AntiCheatReviewRow, EventsClient, LadderClient, LadderSeasonInfo, MailDispatcher, MismatchClient, MismatchRow, PlayerClient, PlayerProfile, PlayerSummary, PromoClient, PromoCodeView, StatsClient, SuspiciousPveClient, SuspiciousPveRow, WorldClient, SlgWorldSummary } from './clients';
import type { AuctionAnomaly, EventDoc, EventInput } from '@nw/shared';

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
  mismatches: MismatchClient;
  suspiciousPve: SuspiciousPveClient;
  mail: MailDispatcher;
  analytics: AnalyticsClient;
  world: WorldClient;
  ladder: LadderClient;
  events: EventsClient;
  promo: PromoClient;
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
  private readonly mismatches: MismatchClient;
  private readonly suspiciousPve: SuspiciousPveClient;
  private readonly mail: MailDispatcher;
  private readonly analytics: AnalyticsClient;
  private readonly world: WorldClient;
  private readonly ladder: LadderClient;
  private readonly events: EventsClient;
  private readonly promo: PromoClient;
  private readonly now: () => number;
  /** 登录失败限流表（按登录名，内存态）。 */
  private readonly loginAttempts = new Map<string, LoginAttempt>();

  constructor(deps: AdminServiceDeps) {
    this.cols = deps.cols;
    this.stats = deps.stats;
    this.players = deps.players;
    this.antiCheat = deps.antiCheat;
    this.mismatches = deps.mismatches;
    this.suspiciousPve = deps.suspiciousPve;
    this.mail = deps.mail;
    this.analytics = deps.analytics;
    this.world = deps.world;
    this.ladder = deps.ladder;
    this.events = deps.events;
    this.promo = deps.promo;
    this.now = deps.now;
  }

  // ───────────────────── 限时活动管理（B6，events.manage）──────────────────
  /** 列出全部活动定义（含未开始/已结束）。meta 不可达返回空。 */
  async listEvents(): Promise<EventDoc[]> {
    if (!this.events.available) return [];
    return this.events.list();
  }

  /** 创建活动；meta 端校验失败 → EventsClientError（httpApi 映射 4xx）。审计。 */
  async createEvent(actor: Actor, input: EventInput): Promise<EventDoc> {
    const ev = await this.events.create(input);
    await this.audit(actor.adminId, 'event.create', { target: ev._id, summary: ev.title });
    return ev;
  }

  /** 全量替换活动定义。审计。 */
  async updateEvent(actor: Actor, eventId: string, input: EventInput): Promise<EventDoc> {
    const ev = await this.events.update(eventId, input);
    await this.audit(actor.adminId, 'event.update', { target: ev._id, summary: ev.title });
    return ev;
  }

  /** 删除活动定义。审计。 */
  async deleteEvent(actor: Actor, eventId: string): Promise<void> {
    await this.events.remove(eventId);
    await this.audit(actor.adminId, 'event.delete', { target: eventId });
  }

  // ───────────────────── 优惠码管理（B-PROMO，promo.manage）──────────────────────────
  /** 列出全部优惠码；commercial 不可达返回空列表。 */
  async listPromoCodes(): Promise<PromoCodeView[]> {
    if (!this.promo.available) return [];
    return this.promo.list();
  }

  /** 创建优惠码。审计。commercial 不可达 / 重复码抛 AdminError。 */
  async createPromoCode(
    actor: Actor,
    args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
  ): Promise<{ code: string }> {
    if (!this.promo.available) throw new AdminError(503, 'promo_unavailable', 'commercial not configured');
    const r = await this.promo.create({ ...args, createdBy: actor.adminId });
    await this.audit(actor.adminId, 'promo.create', { target: r.code, summary: `${args.coins} coins` });
    return r;
  }

  // ───────────────────── 天梯赛季运维（SE-3）──────────────────────────
  /** 读当前天梯赛季概要；meta 不可达返回 null（ops 前端用于临近 endAt 高亮）。 */
  async getLadderCurrentSeason(): Promise<LadderSeasonInfo | null> {
    if (!this.ladder.available) return null;
    return this.ladder.getCurrentSeason();
  }

  /** CAS 幂等推进天梯赛季（开新赛季）。审计。 */
  async rollLadderSeason(actor: string): Promise<LadderSeasonInfo> {
    const season = await this.ladder.rollSeason();
    await this.audit(actor, 'ladder.season.roll', { summary: `→ s${season.seasonNo}` });
    return season;
  }

  /** 24h 内 hash mismatch 对局列表（C3，anticheat.view 权限）。 */
  async listMismatches(): Promise<MismatchRow[]> {
    if (!this.mismatches.available) return [];
    return this.mismatches.listMismatches();
  }

  /** C4：pveWarnings > 0 的可疑账号列表（anticheat.view 权限）。 */
  async listSuspiciousPve(): Promise<SuspiciousPveRow[]> {
    if (!this.suspiciousPve.available) return [];
    return this.suspiciousPve.listSuspiciousPve();
  }

  /** S4-4：手动封号（anticheat.action 权限）。 */
  async banAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.suspiciousPve.available) return { ok: false };
    return this.suspiciousPve.banAccount(accountId);
  }

  /** S4-4：手动解封（anticheat.action 权限）。 */
  async unbanAccount(accountId: string): Promise<{ ok: boolean }> {
    if (!this.suspiciousPve.available) return { ok: false };
    return this.suspiciousPve.unbanAccount(accountId);
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

  // ───────────────── SLG 异常交易审计（G7 反 RMT，§17.7）─────────────────
  // worldsvc 离线扫出可疑「卖家→买家」配对，运维立审计工单 → 单人裁定（误报 dismiss / 确认 action）。
  // 与补偿工单平行：不发奖、不双人审批，核查由单人裁定 + 审计留痕；处置（封禁/扣回）走外联流程。

  /** 拉一个大区的拍卖异常扫描（capability slg.audit.view）。worldsvc 不可达 → 空表。 */
  async slgScanAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]> {
    if (!this.world.available) return [];
    return this.world.listAuctionAnomalies(worldId, windowSec);
  }

  /**
   * 立异常交易审计工单（capability slg.audit.manage）。冻结快照 + pairKey 去重：
   * 同配对已有 open 工单则直接返回那一张（幂等，不重复立）。审计 slg.audit.file。
   */
  async slgFileAuditTicket(actor: Actor, snapshot: TradeAuditSnapshot): Promise<TradeAuditTicketView> {
    const snap = validateAuditSnapshot(snapshot);
    const pairKey = `${snap.worldId}:${snap.sellerId}:${snap.buyerId}`;
    const existing = await this.cols.tradeAuditTickets.findOne({ pairKey, status: 'open' });
    if (existing) return this.toAuditTicketView(existing);
    const doc: TradeAuditTicketDoc = {
      _id: randomUUID(),
      pairKey,
      snapshot: snap,
      status: 'open',
      filedBy: actor.adminId,
      filedAt: this.now(),
    };
    await this.cols.tradeAuditTickets.insertOne(doc);
    await this.audit(actor.adminId, 'slg.audit.file', {
      target: doc._id,
      summary: `${snap.worldId} ${snap.sellerId}→${snap.buyerId} ${snap.severity} coins=${snap.totalCoins}`,
    });
    return this.toAuditTicketView(doc);
  }

  /** 列审计工单（capability slg.audit.view），可按状态过滤，按立单时间倒序。 */
  async slgListAuditTickets(filter: { status?: string }): Promise<TradeAuditTicketView[]> {
    const q: Partial<Record<'status', TradeAuditTicketStatus>> = {};
    if (filter.status) {
      if (filter.status !== 'open' && filter.status !== 'dismissed' && filter.status !== 'actioned') {
        throw new AdminError(400, 'bad_request', 'invalid status');
      }
      q.status = filter.status;
    }
    const docs = await this.cols.tradeAuditTickets.find(q).sort({ filedAt: -1 }).limit(200).toArray();
    return Promise.all(docs.map((d) => this.toAuditTicketView(d)));
  }

  /**
   * 裁定审计工单（capability slg.audit.manage）：open → dismissed（误报）/ actioned（确认违规）。
   * 仅 open 可裁定（原子守卫防并发双裁）。审计 slg.audit.resolve。
   */
  async slgResolveAuditTicket(
    actor: Actor,
    id: string,
    disposition: string,
    note: string,
  ): Promise<TradeAuditTicketView> {
    if (disposition !== 'dismissed' && disposition !== 'actioned') {
      throw new AdminError(400, 'bad_request', 'disposition must be dismissed|actioned');
    }
    const doc = await this.cols.tradeAuditTickets.findOne({ _id: id });
    if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
    if (doc.status !== 'open') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
    const trimmedNote = (note ?? '').trim();
    const res = await this.cols.tradeAuditTickets.findOneAndUpdate(
      { _id: id, status: 'open' },
      {
        $set: {
          status: disposition,
          resolvedBy: actor.adminId,
          resolvedAt: this.now(),
          ...(trimmedNote ? { note: trimmedNote } : {}),
        },
      },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer open');
    await this.audit(actor.adminId, 'slg.audit.resolve', {
      target: id,
      summary: `${disposition}${trimmedNote ? `: ${trimmedNote}` : ''}`,
    });
    return this.toAuditTicketView(res);
  }

  private async toAuditTicketView(doc: TradeAuditTicketDoc): Promise<TradeAuditTicketView> {
    const names = await this.actorNames([doc.filedBy, doc.resolvedBy].filter((x): x is string => !!x));
    return {
      id: doc._id,
      snapshot: doc.snapshot,
      status: doc.status,
      filedBy: doc.filedBy,
      ...(names.get(doc.filedBy) ? { filedByName: names.get(doc.filedBy)! } : {}),
      filedAt: doc.filedAt,
      ...(doc.note ? { note: doc.note } : {}),
      ...(doc.resolvedBy ? { resolvedBy: doc.resolvedBy } : {}),
      ...(doc.resolvedBy && names.get(doc.resolvedBy) ? { resolvedByName: names.get(doc.resolvedBy)! } : {}),
      ...(doc.resolvedAt ? { resolvedAt: doc.resolvedAt } : {}),
    };
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
    const cap = requiredApproveCapability(doc.scope, doc.amountTier);
    // 四眼原则：发起人原则上不能审批自己的工单。但当全场没有「其他可审批此单」的有效账号时
    // （典型：当前仅一个超管，全服/超额工单只有超管能批），硬性四眼会导致工单永久死锁。
    // 故仅在「存在其他合格审批人」时强制他人审批；否则允许发起人自批，并专门留痕（selfApproved）。
    // TODO(single-super-exception): 招到第二名运维（具备对应审批能力）后删除此例外，恢复硬性发起≠审批。
    let selfApproved = false;
    if (doc.initiatedBy === actor.adminId) {
      if (await this.hasOtherEligibleApprover(doc.initiatedBy, cap)) {
        throw new AdminError(403, 'forbidden', 'initiator cannot approve own ticket');
      }
      selfApproved = true;
    }
    this.requireCap(actor, cap);

    const res = await this.cols.compTickets.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', approvedBy: actor.adminId, approvedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw new AdminError(409, 'conflict', 'ticket no longer pending');
    await this.audit(actor.adminId, 'comp.approve', {
      target: id,
      summary: selfApproved ? `${doc.scope} [SELF-APPROVED:no-other-approver]` : doc.scope,
    });

    return this.execute(res);
  }

  /**
   * 是否存在「除发起人外、当前可用（未禁用）、且具备该审批能力」的其他管理员。
   * 决定四眼原则能否真正落地：存在 → 必须他人审批；不存在 → 允许发起人自批（单超管例外，见 approveTicket）。
   */
  private async hasOtherEligibleApprover(initiatorId: string, cap: AdminCapability): Promise<boolean> {
    const eligibleRoles = ADMIN_ROLES.filter((r) => roleHasCapability(r, cap));
    const count = await this.cols.adminAccounts.countDocuments({
      _id: { $ne: initiatorId },
      disabled: { $ne: true },
      // 种子超管是休眠备份/建号账号，不算活跃运维，排除之（否则单超管永远被它挡住自批）。
      seed: { $ne: true },
      role: { $in: eligibleRoles },
    });
    return count > 0;
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

  /** 按 accountId 查玩家详情（player.lookup，模糊搜结果点击后取详情）。 */
  async lookupPlayerByAccountId(accountId: string): Promise<PlayerProfile> {
    const id = (accountId ?? '').trim();
    if (!id) throw new AdminError(400, 'bad_request', 'accountId required');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const p = await this.players.lookupByAccountId(id);
    if (!p) throw new AdminError(404, 'not_found', 'no such player');
    return p;
  }

  /** 玩家模糊搜（player.lookup）：昵称/登录账号/公开 id/accountId，返回命中摘要列表。审计。 */
  async searchPlayers(actor: string, q: string): Promise<PlayerSummary[]> {
    const term = (q ?? '').trim();
    if (term.length < 2) throw new AdminError(400, 'bad_request', 'query too short (min 2)');
    if (!this.players.available) {
      throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
    }
    const rows = await this.players.search(term, 20);
    await this.audit(actor, 'player.search', { summary: `q=${term} → ${rows.length} hits` });
    return rows;
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

  // ───────────────────── 功能开关（feature flags，§5）─────────────────────
  // admin 是「处理中心」：唯一碰 flag 库、唯一写、对内出原始规则。运营在 ops 翻开关 →
  // upsertFlag 写库 + 审计；不连库的后端轮询 getInternalFlags() 拿原始规则自己求值。

  /**
   * 列出全部白名单 flag + 当前覆盖规则 + 默认值（capability config.manage，ops 列表用）。
   * 没被覆盖过的 flag doc=null，前端显示「默认（default）」。
   */
  async getConfigFlags(): Promise<
    Array<{ key: FlagKey; default: boolean; desc: string; side: string; doc: FeatureFlagDoc | null }>
  > {
    const docs = await this.cols.featureFlags.find({}).toArray();
    const byKey = new Map(docs.map((d) => [d._id, d]));
    return FLAG_KEYS.map((key) => ({
      key,
      default: FEATURE_FLAGS[key].default,
      desc: FEATURE_FLAGS[key].desc,
      side: FEATURE_FLAGS[key].side,
      doc: byKey.get(key) ?? null,
    }));
  }

  /** 全量原始规则（admin 内部端点 GET /admin/internal/flags 用；不求值，给消费者本地求值）。 */
  async getInternalFlags(): Promise<FeatureFlagDoc[]> {
    return this.cols.featureFlags.find({}).toArray();
  }

  /**
   * 写入/更新一条 flag 规则（capability config.manage）。校验 key 在白名单内、pct/平台合法值；
   * 每次写 auditLog（actor / 前后值 / 时间），与补偿审批一致。
   */
  async upsertFlag(
    actor: Actor,
    key: string,
    input: { enabled?: boolean; rollout?: unknown; desc?: string },
  ): Promise<FeatureFlagDoc> {
    if (!isFlagKey(key)) throw new AdminError(400, 'bad_request', `unknown flag key: ${key}`);
    const before = await this.cols.featureFlags.findOne({ _id: key });
    const rollout = validateRollout(input.rollout);
    const doc: FeatureFlagDoc = {
      _id: key,
      enabled: input.enabled !== false, // 缺省视为开总闸（仅显式 false 关）
      ...(rollout ? { rollout } : {}),
      ...(typeof input.desc === 'string' && input.desc.trim() ? { desc: input.desc.trim() } : {}),
      updatedAt: this.now(),
      updatedBy: actor.adminId,
    };
    await this.cols.featureFlags.replaceOne({ _id: key }, doc, { upsert: true });
    await this.audit(actor.adminId, 'config.update', {
      target: key,
      summary: `${describeFlag(before)} → ${describeFlag(doc)}`,
    });
    return doc;
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

function validateAuditSnapshot(s: TradeAuditSnapshot | undefined): TradeAuditSnapshot {
  if (!s || typeof s !== 'object') throw new AdminError(400, 'bad_request', 'snapshot required');
  const worldId = (s.worldId ?? '').trim();
  const sellerId = (s.sellerId ?? '').trim();
  const buyerId = (s.buyerId ?? '').trim();
  if (!worldId || !sellerId || !buyerId) {
    throw new AdminError(400, 'bad_request', 'snapshot requires worldId/sellerId/buyerId');
  }
  if (sellerId === buyerId) throw new AdminError(400, 'bad_request', 'seller and buyer must differ');
  const severity = s.severity === 'high' ? 'high' : 'medium';
  const allowed = new Set(['repeated', 'designated', 'high_value']);
  const reasons = (Array.isArray(s.reasons) ? s.reasons : []).filter((r) => allowed.has(r));
  const num = (v: unknown): number => (Number.isFinite(v as number) && (v as number) >= 0 ? Math.floor(v as number) : 0);
  return {
    worldId,
    sellerId,
    buyerId,
    trades: num(s.trades),
    designatedTrades: num(s.designatedTrades),
    totalCoins: num(s.totalCoins),
    firstTs: num(s.firstTs),
    lastTs: num(s.lastTs),
    severity,
    reasons,
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

/** 校验/规整 flag 定向规则（越界/非法直接抛 400，与玩家可见配置不同——这里要严，防误配）。 */
function validateRollout(raw: unknown): FlagRollout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new AdminError(400, 'bad_request', 'rollout must be an object');
  const o = raw as Record<string, unknown>;
  const out: FlagRollout = {};
  if (o.pct !== undefined) {
    if (typeof o.pct !== 'number' || !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100) {
      throw new AdminError(400, 'bad_request', 'rollout.pct must be 0-100');
    }
    out.pct = Math.floor(o.pct);
  }
  const strArr = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new AdminError(400, 'bad_request', `rollout.${field} must be string[]`);
    }
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  };
  const regions = strArr(o.regions, 'regions');
  if (regions && regions.length) out.regions = regions;
  const platforms = strArr(o.platforms, 'platforms');
  if (platforms) {
    for (const p of platforms) {
      if (!(FLAG_PLATFORMS as readonly string[]).includes(p)) {
        throw new AdminError(400, 'bad_request', `invalid platform: ${p}`);
      }
    }
    if (platforms.length) out.platforms = platforms as FlagPlatform[];
  }
  const allow = strArr(o.allowAccounts, 'allowAccounts');
  if (allow && allow.length) out.allowAccounts = allow;
  const deny = strArr(o.denyAccounts, 'denyAccounts');
  if (deny && deny.length) out.denyAccounts = deny;
  const allowPublicIds = strArr(o.allowPublicIds, 'allowPublicIds');
  if (allowPublicIds && allowPublicIds.length) out.allowPublicIds = allowPublicIds;
  return Object.keys(out).length ? out : undefined;
}

/** 审计摘要：紧凑描述一条 flag 的态（before/after 对比用）。 */
function describeFlag(doc: FeatureFlagDoc | null): string {
  if (!doc) return 'default';
  const r = doc.rollout;
  const parts = [doc.enabled ? 'on' : 'OFF'];
  if (r?.pct !== undefined) parts.push(`${r.pct}%`);
  if (r?.regions?.length) parts.push(`region=${r.regions.join('|')}`);
  if (r?.platforms?.length) parts.push(`plat=${r.platforms.join('|')}`);
  if (r?.allowAccounts?.length) parts.push(`allow=${r.allowAccounts.length}`);
  if (r?.denyAccounts?.length) parts.push(`deny=${r.denyAccounts.length}`);
  if (r?.allowPublicIds?.length) parts.push(`allowPid=${r.allowPublicIds.length}`);
  return parts.join(',');
}

export { ADMIN_ROLES };
