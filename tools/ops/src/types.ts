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
