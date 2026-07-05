// Shared contract for the Ops / Admin back-office (OPS_DESIGN.md S7-0). Single source of truth for
// pure data + role → capability matrix. The admin backend uses this for RBAC checks and ticket-quota
// tiering; the frontend renders visible buttons based on the returned capability set (hidden ≠ security
// boundary — real enforcement is at each backend endpoint). Collection document shapes
// (AdminAccountDoc/CompTicketDoc/AuditDoc/MetricSnapshotDoc) live in server/admin/db.ts.

// ── Roles ──────────────────────────────────────────────
export type AdminRole = 'super' | 'ops' | 'support' | 'viewer';
export const ADMIN_ROLES: readonly AdminRole[] = ['super', 'ops', 'support', 'viewer'];

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

// ── Atomic capability points (hardcoded enum, OPS_DESIGN §2.2) ─────────────
export type AdminCapability =
  | 'monitor.view' // online / match-queue / trends
  | 'analytics.view' // data analytics
  | 'player.lookup' // look up player profile
  | 'anticheat.view' // view achievement anti-cheat review queue (S9-7)
  | 'anticheat.action' // manual ban / unban (S4-4)
  | 'comp.initiate.single' // initiate a single-player compensation
  | 'comp.initiate.global' // initiate a server-wide compensation
  | 'comp.approve.single' // approve single-player compensation (within quota)
  | 'comp.approve.single.overquota' // approve over-quota single-player compensation
  | 'comp.approve.global' // approve server-wide compensation
  | 'comp.view' // view tickets / sent mail
  | 'audit.view.all' // view all audit logs
  | 'audit.view.self' // view own operations only
  | 'ladder.season.manage' // advance ladder season (open new season / SE-3)
  | 'slg.season.view' // view SLG region status (G7/§17.7)
  | 'slg.season.manage' // SLG season ops: open / settle / reset / close a region (G7/§17.7, high-risk)
  | 'slg.audit.view' // view auction anomaly scan + audit queue (G7 anti-RMT)
  | 'slg.audit.manage' // file / adjudicate anomalous-trade audit tickets (G7 anti-RMT)
  | 'slg.map.view' // view map templates + open the map editor read-only (SLG_DESIGN §24)
  | 'slg.map.manage' // generate/save/activate/delete map templates (SLG_DESIGN §24, high-risk: delete wipes a template's tiles)
  | 'config.manage' // feature flag master switch / targeted edit (FEATURE_FLAGS_DESIGN §5)
  | 'events.manage' // limited-time events (B6): create / edit / take offline (ADR-014)
  | 'gacha.pools.manage' // ops-authored custom gacha pools (GACHA_DESIGN §12): create / close festival pools
  | 'promo.manage' // promo-code create / view (B-PROMO)
  | 'admin.manage'; // account / role management

/**
 * Role → capability set (single source of truth, OPS_DESIGN §2.2 table). The frontend uses this to
 * render navigation; the backend uses it to guard each endpoint. super has all capabilities;
 * the others are enumerated exactly as in the table.
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
    'slg.map.view',
    'slg.map.manage',
    'config.manage',
    'events.manage',
    'gacha.pools.manage',
    'promo.manage',
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
    'slg.map.view',
    'slg.map.manage',
    'config.manage',
    'events.manage',
    'gacha.pools.manage',
    'promo.manage',
  ],
  support: [
    'monitor.view',
    'player.lookup',
    'comp.initiate.single',
    'comp.view',
    'audit.view.self',
  ],
  viewer: ['monitor.view', 'analytics.view', 'comp.view', 'audit.view.self', 'slg.season.view', 'slg.audit.view', 'slg.map.view'],
};

export function capabilitiesForRole(role: AdminRole): AdminCapability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function roleHasCapability(role: AdminRole, cap: AdminCapability): boolean {
  return (ROLE_CAPABILITIES[role] as readonly string[]).includes(cap);
}

// ── Compensation quota (coin equivalent, OPS_DESIGN §3.2) ────────────────
/**
 * Threshold for the total coin-equivalent value of attachments on a single personal compensation
 * ticket. ≤ threshold = normal (ops / super-admin may approve); above = overquota (super-admin only).
 * DRAFT: the coin-equivalent conversion table will be defined in ECONOMY_BALANCE.md later;
 * this is a conservative placeholder for now.
 */
export const SINGLE_COMP_QUOTA = 5000;

/**
 * Coin equivalent for non-coin attachments (DRAFT placeholder, pending ECONOMY_BALANCE.md).
 * Used for ticket quota tiering only; does not affect actual delivery (items are credited via
 * commercial/inventory when the player claims mail).
 */
export const ITEM_COIN_EQUIV = 500;
export const SKIN_COIN_EQUIV = 2000;

export type CompAttachmentKind = 'coins' | 'item' | 'skin';
export interface CompAttachment {
  kind: CompAttachmentKind;
  /** Asset id for item / skin (ignored for coins). */
  id?: string;
  /** coins = coin amount; item/skin = quantity (defaults to 1). */
  count?: number;
}

/** Coin equivalent for a single attachment. */
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

/** Total coin equivalent of all ticket attachments (used for quota tiering). */
export function totalCoinValue(attachments: readonly CompAttachment[]): number {
  return attachments.reduce((sum, a) => sum + attachmentCoinValue(a), 0);
}

export type AmountTier = 'normal' | 'overquota';

/** Determine the quota tier from total attachment value (global is always overridden to require super-admin approval by the caller, see §3.2). */
export function tierForAttachments(attachments: readonly CompAttachment[]): AmountTier {
  return totalCoinValue(attachments) > SINGLE_COMP_QUOTA ? 'overquota' : 'normal';
}

/**
 * Required capability to approve a given ticket (OPS_DESIGN §3.2 routing):
 *   single normal    → comp.approve.single
 *   single overquota → comp.approve.single.overquota (super-admin)
 *   global           → comp.approve.global (super-admin)
 */
export function requiredApproveCapability(
  scope: CompScope,
  tier: AmountTier,
): AdminCapability {
  if (scope === 'global') return 'comp.approve.global';
  return tier === 'overquota' ? 'comp.approve.single.overquota' : 'comp.approve.single';
}

/** Required capability to initiate a ticket. */
export function requiredInitiateCapability(scope: CompScope): AdminCapability {
  return scope === 'global' ? 'comp.initiate.global' : 'comp.initiate.single';
}

// ── Tickets / server-wide filter / mail ─────────────────────────────
export type CompScope = 'single' | 'global';
export type CompTicketStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

/** Server-wide compensation target filter (phase 1: only 'all'; dimensions to be aligned with mail fan-out, OPS_DESIGN §9). */
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

/** Ticket view (REST response; DB document shape lives in server/admin/db.ts with the same fields). */
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

// ── SLG anomalous-trade audit tickets (G7 anti-RMT, isomorphic reuse of OPS_DESIGN §3 ticket infrastructure) ──────────
// worldsvc performs offline scans for suspicious seller→buyer pairs (detectAuctionAnomalies). Ops staff
// then file those suspected pairs as audit tickets in admin, and adjudicate them as dismissed
// (false positive / legitimate trade) or actioned (confirmed violation; remediation is handled via
// existing compensation / ban flows externally). Parallel to but independent from compensation
// tickets: compensation = "issue rewards", audit = "investigate a violation" — no rewards issued,
// no two-person approval required (a single adjudicator resolves, with a full audit trail).
export type TradeAuditTicketStatus = 'open' | 'dismissed' | 'actioned';

/** Anomalous-pair snapshot (copied from the worldsvc scan result at ticket-filing time, freezing evidence as of that moment). */
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

/** Audit ticket view (REST response; DB document shape lives in server/admin/db.ts with the same fields). */
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

// ── Audit ───────────────────────────────────────────────
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
  | 'slg.map.template.generate'
  | 'slg.map.template.save'
  | 'slg.map.template.activate'
  | 'slg.map.template.delete'
  | 'config.update'
  | 'event.create'
  | 'event.update'
  | 'event.delete'
  | 'gacha.pool.create'
  | 'gacha.pool.close'
  | 'promo.create';

export interface AuditEntryView {
  id: string;
  actor: string; // adminId
  actorName?: string;
  action: AuditAction;
  target?: string; // ticket id / account id / publicId …
  summary?: string;
  ip?: string;
  ts: number;
}

// ── Account view ────────────────────────────────────────────
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

// ── Monitor / trends ──────────────────────────────────────────
/** Aggregated shape for gateway/matchsvc GET /internal/stats and the admin monitor/live endpoint. */
export interface LiveStats {
  /** gateway: current number of online connections. */
  online: number;
  /** matchsvc: ranked match-queue length. */
  queue: number;
  /** matchsvc: number of active friendly rooms. */
  rooms: number;
  /** matchsvc: number of registered game instances. */
  gameInstances: number;
  /** matchsvc: total game-instance capacity utilization (sum of load/capacity). */
  gameLoad?: number;
}

/** Self-collected time-series metric keys (metricSnapshots.metric). */
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
