// 运维后台（Ops / Admin）共享契约（OPS_DESIGN.md S7-0）。纯数据 + 角色→能力矩阵单一真相。
// admin 后端用它做 RBAC 校验、工单额度分级；前端按返回的能力集渲染可见按钮（隐藏≠安全边界，
// 真正校验在后端每个端点）。集合文档形状（AdminAccountDoc/CompTicketDoc/AuditDoc/MetricSnapshotDoc）
// 在 server/admin/db.ts。

// ── 角色 ──────────────────────────────────────────────
export type AdminRole = 'super' | 'ops' | 'support' | 'viewer';
export const ADMIN_ROLES: readonly AdminRole[] = ['super', 'ops', 'support', 'viewer'];

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

// ── 原子能力点（写死枚举，OPS_DESIGN §2.2）─────────────
export type AdminCapability =
  | 'monitor.view' // 在线 / 匹配池 / 趋势
  | 'analytics.view' // 数据分析
  | 'player.lookup' // 查玩家档案
  | 'anticheat.view' // 查成就反作弊审查队列（S9-7）
  | 'anticheat.action' // 手动封号/解封（S4-4）
  | 'comp.initiate.single' // 发起个人补偿
  | 'comp.initiate.global' // 发起全服补偿
  | 'comp.approve.single' // 审批个人补偿（额度内）
  | 'comp.approve.single.overquota' // 审批超额个人补偿
  | 'comp.approve.global' // 审批全服补偿
  | 'comp.view' // 查看工单 / 已发邮件
  | 'audit.view.all' // 看全部审计
  | 'audit.view.self' // 看自己操作
  | 'ladder.season.manage' // 天梯赛季推进（开新赛季/SE-3）
  | 'slg.season.view' // 看 SLG 各大区状态（G7/§17.7）
  | 'slg.season.manage' // SLG 赛季运维：开/结算/重置/关闭大区（G7/§17.7，高危）
  | 'slg.audit.view' // 看拍卖异常交易扫描 + 审计队列（G7 反 RMT）
  | 'slg.audit.manage' // 立/裁定异常交易审计工单（G7 反 RMT）
  | 'config.manage' // 功能开关（feature flag）总闸/定向编辑（FEATURE_FLAGS_DESIGN §5）
  | 'events.manage' // 限时活动（B6）创建/编辑/下线（ADR-014）
  | 'admin.manage'; // 账号 / 角色管理

/**
 * 角色 → 能力集（单一真相，OPS_DESIGN §2.2 表）。前端据此渲染导航，后端据此守每个端点。
 * super 拥有全部能力；其余按表精确列举。
 */
export const ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  super: [
    'monitor.view',
    'analytics.view',
    'player.lookup',
    'anticheat.view',
    'anticheat.action',
    'comp.initiate.single',
    'comp.initiate.global',
    'comp.approve.single',
    'comp.approve.single.overquota',
    'comp.approve.global',
    'comp.view',
    'audit.view.all',
    'audit.view.self',
    'ladder.season.manage',
    'slg.season.view',
    'slg.season.manage',
    'slg.audit.view',
    'slg.audit.manage',
    'config.manage',
    'events.manage',
    'admin.manage',
  ],
  ops: [
    'monitor.view',
    'analytics.view',
    'player.lookup',
    'anticheat.view',
    'anticheat.action',
    'comp.initiate.single',
    'comp.initiate.global',
    'comp.approve.single',
    'comp.view',
    'audit.view.self',
    'ladder.season.manage',
    'slg.season.view',
    'slg.audit.view',
    'slg.audit.manage',
    'config.manage',
    'events.manage',
  ],
  support: [
    'monitor.view',
    'player.lookup',
    'comp.initiate.single',
    'comp.view',
    'audit.view.self',
  ],
  viewer: ['monitor.view', 'analytics.view', 'comp.view', 'audit.view.self', 'slg.season.view', 'slg.audit.view'],
};

export function capabilitiesForRole(role: AdminRole): AdminCapability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function roleHasCapability(role: AdminRole, cap: AdminCapability): boolean {
  return (ROLE_CAPABILITIES[role] as readonly string[]).includes(cap);
}

// ── 补偿额度（金币当量，OPS_DESIGN §3.2）────────────────
/**
 * 单张个人补偿工单附件总价值（金币当量）阈值。≤ 阈值 = normal（运营/超管可审批），
 * 超过 = overquota（仅超管）。DRAFT：金币当量换算表后续在 ECONOMY_BALANCE.md 定，
 * 此处先给保守占位值。
 */
export const SINGLE_COMP_QUOTA = 5000;

/**
 * 非金币附件的金币当量（DRAFT 占位，待 ECONOMY_BALANCE.md）。用于工单额度分级，
 * 不影响真实发放（发放在玩家领邮件时经 commercial/inventory 入账）。
 */
export const ITEM_COIN_EQUIV = 500;
export const SKIN_COIN_EQUIV = 2000;

export type CompAttachmentKind = 'coins' | 'item' | 'skin';
export interface CompAttachment {
  kind: CompAttachmentKind;
  /** item / skin 的资源 id（coins 忽略）。 */
  id?: string;
  /** coins = 金币数；item/skin = 数量（缺省 1）。 */
  count?: number;
}

/** 单条附件的金币当量。 */
export function attachmentCoinValue(a: CompAttachment): number {
  const n = Math.max(0, a.count ?? (a.kind === 'coins' ? 0 : 1));
  switch (a.kind) {
    case 'coins':
      return n;
    case 'item':
      return ITEM_COIN_EQUIV * n;
    case 'skin':
      return SKIN_COIN_EQUIV * n;
  }
}

/** 工单附件总金币当量（额度分级用）。 */
export function totalCoinValue(attachments: readonly CompAttachment[]): number {
  return attachments.reduce((sum, a) => sum + attachmentCoinValue(a), 0);
}

export type AmountTier = 'normal' | 'overquota';

/** 据附件总当量判定额度档（global 恒由上层覆写为需超管审批，见 §3.2）。 */
export function tierForAttachments(attachments: readonly CompAttachment[]): AmountTier {
  return totalCoinValue(attachments) > SINGLE_COMP_QUOTA ? 'overquota' : 'normal';
}

/**
 * 审批某工单所需的能力点（OPS_DESIGN §3.2 路由）：
 *   个人 normal   → comp.approve.single
 *   个人 overquota → comp.approve.single.overquota（超管）
 *   全服          → comp.approve.global（超管）
 */
export function requiredApproveCapability(
  scope: CompScope,
  tier: AmountTier,
): AdminCapability {
  if (scope === 'global') return 'comp.approve.global';
  return tier === 'overquota' ? 'comp.approve.single.overquota' : 'comp.approve.single';
}

/** 发起某工单所需的能力点。 */
export function requiredInitiateCapability(scope: CompScope): AdminCapability {
  return scope === 'global' ? 'comp.initiate.global' : 'comp.initiate.single';
}

// ── 工单 / 全服过滤器 / 邮件 ─────────────────────────────
export type CompScope = 'single' | 'global';
export type CompTicketStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

/** 全服补偿目标过滤器（一期仅 all；维度待与邮件 fan-out 对齐，OPS_DESIGN §9）。 */
export interface GlobalFilter {
  kind: 'all';
}

export type CompTarget = { publicId: string } | { filter: GlobalFilter };

export interface CompMailContent {
  subject: string;
  body: string;
  attachments: CompAttachment[];
  expireDays: number;
}

/** 工单视图（REST 响应；DB 文档形状在 server/admin/db.ts，字段同义）。 */
export interface CompTicketView {
  id: string;
  scope: CompScope;
  target: CompTarget;
  mail: CompMailContent;
  reason: string;
  status: CompTicketStatus;
  amountTier: AmountTier;
  initiatedBy: string;
  initiatedByName?: string;
  initiatedAt: number;
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: number;
  executedAt?: number;
  recipientCount?: number;
  error?: string;
}

// ── SLG 异常交易审计工单（G7 反 RMT，OPS_DESIGN §3 工单基建的同构复用）──────────
// worldsvc 离线扫描出可疑「卖家→买家」配对（detectAuctionAnomalies），运维在 admin 把可疑配对
// 立成审计工单，裁定为 dismissed（误报/正常交易）或 actioned（确认违规，处置走既有补偿/封禁流程外联）。
// 与补偿工单平行但独立：补偿是「发奖」，审计是「核查违规」，不发奖、不走双人审批（核查由单人裁定 + 审计留痕）。
export type TradeAuditTicketStatus = 'open' | 'dismissed' | 'actioned';

/** 异常配对快照（立单时从 worldsvc 扫描结果拷入，冻结当时证据）。 */
export interface TradeAuditSnapshot {
  worldId: string;
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  reasons: Array<'repeated' | 'designated' | 'high_value'>;
}

/** 审计工单视图（REST 响应；DB 文档形状在 server/admin/db.ts，字段同义）。 */
export interface TradeAuditTicketView {
  id: string;
  snapshot: TradeAuditSnapshot;
  status: TradeAuditTicketStatus;
  filedBy: string;
  filedByName?: string;
  filedAt: number;
  note?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: number;
}

// ── 审计 ───────────────────────────────────────────────
export type AuditAction =
  | 'login'
  | 'login.failed'
  | 'logout'
  | 'account.create'
  | 'account.update'
  | 'account.reset_password'
  | 'comp.initiate'
  | 'comp.approve'
  | 'comp.reject'
  | 'comp.cancel'
  | 'comp.execute'
  | 'comp.execute.failed'
  | 'anticheat.view'
  | 'account.ban'
  | 'account.unban'
  | 'player.search'
  | 'ladder.season.roll'
  | 'slg.season.open'
  | 'slg.season.settle'
  | 'slg.season.reset'
  | 'slg.season.close'
  | 'slg.audit.file'
  | 'slg.audit.resolve'
  | 'config.update'
  | 'event.create'
  | 'event.update'
  | 'event.delete';

export interface AuditEntryView {
  id: string;
  actor: string; // adminId
  actorName?: string;
  action: AuditAction;
  target?: string; // 工单 id / 账号 id / publicId …
  summary?: string;
  ip?: string;
  ts: number;
}

// ── 账号视图 ────────────────────────────────────────────
export interface AdminAccountView {
  id: string;
  username: string;
  role: AdminRole;
  displayName: string;
  disabled: boolean;
  createdAt: number;
  createdBy?: string;
  lastLoginAt?: number;
}

// ── 监控 / 趋势 ──────────────────────────────────────────
/** gateway/matchsvc 的 GET /internal/stats 聚合 + admin monitor/live 形状。 */
export interface LiveStats {
  /** gateway：当前在线连接数。 */
  online: number;
  /** matchsvc：ranked 匹配队列长度。 */
  queue: number;
  /** matchsvc：活跃 friendly 房间数。 */
  rooms: number;
  /** matchsvc：已注册 game 实例数。 */
  gameInstances: number;
  /** matchsvc：game 实例容量利用（load/capacity 求和）。 */
  gameLoad?: number;
}

/** 自采时序指标键（metricSnapshots.metric）。 */
export type MetricKey = 'online' | 'queue' | 'rooms' | 'gameInstances' | 'gameLoad';
export const METRIC_KEYS: readonly MetricKey[] = [
  'online',
  'queue',
  'rooms',
  'gameInstances',
  'gameLoad',
];

export interface TrendPoint {
  ts: number;
  value: number;
}
