// Frontend-local view types (mirror of server/shared/admin.ts; the frontend does not import @nw/shared to avoid pulling in mongo).
// Real authorization is enforced at each backend endpoint; the frontend uses capabilities only to render the visible navigation/buttons (UX convenience, not a security boundary).
export type AdminRole = 'super' | 'ops' | 'support' | 'viewer';

export type AdminCapability =
  | 'monitor.view'
  | 'analytics.view'
  | 'player.lookup'
  | 'player.password_reset'
  | 'anticheat.view'
  | 'anticheat.action'
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
  | 'slg.shop.manage'
  | 'config.manage'
  | 'events.manage'
  | 'gacha.pools.manage'
  | 'paddle.events.view'
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

export interface PaddleEventView {
  transactionId: string;
  eventType: string;
  status?: string;
  accountId?: string;
  rawEvent: string;
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
/** Deck-composition PvP win-rate by card (BALANCE data pipeline P1, aggregated across days). */
export interface PvpCardStatRow {
  cardId: string;
  games: number;
  wins: number;
}
/** Anti-cheat review record (S9-7 + PvE reject 2026-07-18; mirror of the meta AntiCheatReviewDoc). Human resolves via resolveAntiCheatReview. */
export interface AntiCheatReviewView {
  _id: string;
  kind?: 'pvp_overclaim' | 'pve_reject'; // absent = 'pvp_overclaim' (pre-existing rows)
  accountId: string;
  publicId?: string;
  status: 'open' | 'reviewed';
  ts: number;
  // pvp_overclaim
  roomId?: string;
  side?: number;
  reported?: Record<string, number>;
  authoritative?: Record<string, number>;
  overclaim?: Record<string, number>;
  rolledBack?: Record<string, number>;
  suspicionAfter?: number;
  judgeAccountId?: string;
  // pve_reject
  levelId?: string;
  claimedStars?: number;
  judgedStars?: number;
  rejectCountAfter?: number;
  severity?: 'normal' | 'high';
  // resolution
  resolvedBy?: string;
  resolvedAt?: number;
  resolution?: 'dismissed' | 'banned';
}

export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
  banned?: boolean;
}

export interface PlayerSummary {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

export interface Session {
  token: string;
  admin: AdminAccountView;
  capabilities: AdminCapability[];
}

// ── Feature flags (mirror of @nw/shared featureFlags.ts) ──
export type FlagPlatform = 'web' | 'wechat' | 'crazygames';
export interface FlagRollout {
  pct?: number;
  regions?: string[];
  platforms?: FlagPlatform[];
  allowAccounts?: string[];
  denyAccounts?: string[];
  /** publicId allowlist (9-digit player-visible id; a hit enables the flag, same priority as allowAccounts). Used for targeted client log collection. */
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
/** GET /admin/config/flags row: registered flag + its default + current override rule (doc=null means using the default). */
export interface FeatureFlagRow {
  key: string;
  default: boolean;
  desc: string;
  side: string;
  doc: FeatureFlagDoc | null;
}

// ── SLG shop price overrides (mirror of @nw/shared slg/shop.ts) ──
export interface SlgShopItem {
  id: string;
  cost: number;
  kind: 'troop_speedup' | 'resource_pack' | 'protection' | 'battle_pass';
  effect: Record<string, number | string>;
  description: string;
}
export interface SlgShopItemOverrideDoc {
  _id: string;
  cost?: number;
  effect?: Record<string, number | string>;
  updatedAt: number;
  updatedBy: string;
}
/** GET /admin/config/slg-shop row: one of the 9 catalog items + its code default + current effective (default merged with override) + raw override doc (null = using the default). */
export interface SlgShopItemRow {
  id: string;
  default: SlgShopItem;
  effective: SlgShopItem;
  doc: SlgShopItemOverrideDoc | null;
}

// ── SLG season ops (G7/§17.7, mirror of server/admin/src/clients.ts + @nw/shared) ──
export interface SlgWorldSummary {
  worldId: string;
  season: number;
  shard: number;
  status: string;
  population: number;
  capacity: number;
  openAt: number;
  resetAt?: number;
  engineVersion?: number;
}

export type AuctionAnomalyReason = 'repeated' | 'designated' | 'high_value';
export interface AuctionAnomaly {
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  reasons: AuctionAnomalyReason[];
}

// ── Ops auction listing lookup (mirror of @nw/shared AuctionListingAdminView/AuctionListingQuery) ──
export interface AuctionListingQuery {
  sellerId?: string;
  itemType?: 'material' | 'equipment' | 'card' | 'skin';
  status?: 'open' | 'sold' | 'cancelled' | 'expired';
  itemName?: string;
  limit?: number;
}

export interface AuctionListingAdminView {
  auctionId: string;
  sellerId: string;
  itemType: 'material' | 'equipment' | 'card' | 'skin';
  itemName: string;
  item: Record<string, unknown>;
  qty: number;
  price: number;
  currency: string;
  designatedBuyerId?: string;
  expireAt: number;
  status: 'open' | 'sold' | 'cancelled' | 'expired';
  buyerId?: string;
  soldAt?: number;
  closedAt?: number;
  saleMode: 'fixed' | 'auction';
  startPrice?: number;
  buyoutPrice?: number;
  topBid?: { bidderId: string; amount: number; ts: number };
  rev: number;
}

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
  reasons: AuctionAnomalyReason[];
}

export type TradeAuditTicketStatus = 'open' | 'dismissed' | 'actioned';

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
  enforcement?: { sellerBanned: boolean; buyerBanned: boolean };
}

// ── Timed events (B6, mirror of @nw/shared events.ts) ──
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
/** Create/edit input (_id may be specified optionally; the server fills in createdAt). */
export interface EventInput {
  id?: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
}

// ── Custom gacha pools (GACHA_DESIGN §12, gacha.pools.manage) ──
// Mirrors @nw/shared economy.GachaCategory (§11.2 canonical taxonomy; equipment split by tier).
export type GachaCategory = 'material' | 'card' | 'equip_t1' | 'equip_t2' | 'equip_t3' | 'skin';
export interface GachaCatalogItem {
  itemId: string;
  category: GachaCategory;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  name: string;
}
export interface CustomPoolItem {
  itemId: string;
  weight: number;
}
export interface CustomPoolCategory {
  category: GachaCategory;
  weight: number;
  items: CustomPoolItem[];
}
export interface CustomPoolConfig {
  id: string;
  name: string;
  costSingle: number;
  costTen?: number;
  startAt: number;
  endAt: number;
  categories: CustomPoolCategory[];
}
/** A pool as listed by the backend (derived §2.2 or custom §12; discriminated by `kind`). */
export interface AdminGachaPool {
  id: string;
  name: string;
  startAt: number;
  endAt: number;
  kind?: 'derived' | 'custom';
  featuredLegendary?: string; // derived pools
  costSingle?: number; // custom pools
  costTen?: number;
  categories?: CustomPoolCategory[];
  createdBy: string;
  createdAt: number;
  closedAt?: number;
}
