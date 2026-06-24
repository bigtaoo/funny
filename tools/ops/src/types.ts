// 前端本地视图类型（与 server/shared/admin.ts 同义；前端不 import @nw/shared 避免拖入 mongo）。
// 真正的权限校验在后端每个端点；前端按 capabilities 渲染可见导航/按钮（仅体验，非安全边界）。
export type AdminRole = 'super' | 'ops' | 'support' | 'viewer';

export type AdminCapability =
  | 'monitor.view'
  | 'analytics.view'
  | 'player.lookup'
  | 'anticheat.view'
  | 'comp.initiate.single'
  | 'comp.initiate.global'
  | 'comp.approve.single'
  | 'comp.approve.single.overquota'
  | 'comp.approve.global'
  | 'comp.view'
  | 'audit.view.all'
  | 'audit.view.self'
  | 'ladder.season.manage'
  | 'slg.season.view'
  | 'slg.season.manage'
  | 'slg.audit.view'
  | 'slg.audit.manage'
  | 'config.manage'
  | 'events.manage'
  | 'admin.manage';

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

export type CompScope = 'single' | 'global';
export type CompTicketStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'cancelled'
  | 'failed';
export type AmountTier = 'normal' | 'overquota';

export interface CompAttachment {
  kind: 'coins' | 'item' | 'skin';
  id?: string;
  count?: number;
}
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

export interface AuditEntryView {
  id: string;
  actor: string;
  actorName?: string;
  action: string;
  target?: string;
  summary?: string;
  ip?: string;
  ts: number;
}

export interface LiveStats {
  online: number;
  queue: number;
  rooms: number;
  gameInstances: number;
  gameLoad?: number;
  available: boolean;
}
export interface TrendPoint {
  ts: number;
  value: number;
}
/** 成就反作弊审查记录（S9-7；= meta AntiCheatReviewDoc 只读视图）。 */
export interface AntiCheatReviewView {
  _id: string;
  roomId: string;
  accountId: string;
  publicId?: string;
  side: number;
  reported: Record<string, number>;
  authoritative: Record<string, number>;
  overclaim: Record<string, number>;
  rolledBack: Record<string, number>;
  suspicionAfter: number;
  judgeAccountId?: string;
  status: 'open' | 'reviewed';
  ts: number;
}

export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
}

export interface Session {
  token: string;
  admin: AdminAccountView;
  capabilities: AdminCapability[];
}

// ── 功能开关（feature flags，与 @nw/shared featureFlags.ts 同义）──
export type FlagPlatform = 'web' | 'wechat' | 'crazygames';
export interface FlagRollout {
  pct?: number;
  regions?: string[];
  platforms?: FlagPlatform[];
  allowAccounts?: string[];
  denyAccounts?: string[];
  /** publicId 白名单（9 位玩家可见 id；命中即开，与 allowAccounts 同优先级）。客户端日志定向采集用。 */
  allowPublicIds?: string[];
}
export interface FeatureFlagDoc {
  _id: string;
  enabled: boolean;
  rollout?: FlagRollout;
  desc?: string;
  updatedAt: number;
  updatedBy: string;
}
/** GET /admin/config/flags 行：白名单 flag + 默认值 + 当前覆盖规则（doc=null 表示用默认）。 */
export interface FeatureFlagRow {
  key: string;
  default: boolean;
  desc: string;
  side: string;
  doc: FeatureFlagDoc | null;
}

// ── 限时活动（B6，与 @nw/shared events.ts 同义）──
export type EventTaskKind = 'pve.clear' | 'pvp.win' | 'ad.watch';
export interface EventTaskDef {
  taskId: string;
  kind: EventTaskKind;
  target: number;
  points: number;
}
export interface EventRewardDef {
  rewardId: string;
  cost: number;
  kind: 'coins' | 'material' | 'skin';
  id?: string;
  count?: number;
  maxClaims?: number;
}
export interface EventDoc {
  _id: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
  createdAt: number;
}
/** 创建/编辑入参（_id 可选指定；服务端补 createdAt）。 */
export interface EventInput {
  id?: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
}
