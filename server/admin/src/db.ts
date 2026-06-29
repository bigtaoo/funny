// Admin-exclusive database factory (OPS_DESIGN §4.3). Database name: notebook_wars_admin, physically isolated from the game database.
// Collections: adminAccounts / compTickets / auditLog / metricSnapshots.
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type {
  AdminRole,
  AmountTier,
  AuditAction,
  CompMailContent,
  CompScope,
  CompTarget,
  CompTicketStatus,
  FeatureFlagDoc,
  MetricKey,
  TradeAuditSnapshot,
  TradeAuditTicketStatus,
} from '@nw/shared';

/** Operations account (standalone account store, never reuses player accounts; §2.1). */
export interface AdminAccountDoc {
  _id: string; // uuid
  username: string; // login name (unique index)
  passwordHash: string; // shared/password scrypt
  role: AdminRole;
  displayName: string;
  disabled: boolean;
  createdAt: number;
  createdBy?: string; // creator adminId
  lastLoginAt?: number;
  /**
   * Seed super-admin flag set at deployment time (§2.1). The seed account is intended for backup/emergency use
   * and bootstrapping new accounts; it should not be considered an active operator during normal operations.
   * It is excluded when the four-eyes rule checks "does another qualified approver exist", because
   * otherwise a single super-admin (e.g. tao) would be blocked from self-approving server-wide or
   * over-threshold tickets by this dormant account.
   */
  seed?: boolean;
}

/** Compensation ticket (§3.1). */
export interface CompTicketDoc {
  _id: string; // uuid
  scope: CompScope;
  target: CompTarget;
  mail: CompMailContent;
  reason: string;
  status: CompTicketStatus;
  amountTier: AmountTier;
  initiatedBy: string; // adminId
  initiatedAt: number;
  approvedBy?: string; // adminId (must ≠ initiatedBy)
  approvedAt?: number;
  executedAt?: number;
  /** Execution idempotency key (prevents duplicate execution); unique index. */
  dispatchKey: string;
  recipientCount?: number;
  error?: string;
}

/** SLG abnormal-trade audit ticket (G7 anti-RMT). The anomalous snapshot is frozen when the ticket is filed; single-reviewer adjudication with full audit trail. */
export interface TradeAuditTicketDoc {
  _id: string; // uuid
  /** Dedup key `${worldId}:${sellerId}:${buyerId}`: no new ticket is filed while an open ticket for the same pair exists. */
  pairKey: string;
  snapshot: TradeAuditSnapshot;
  status: TradeAuditTicketStatus;
  filedBy: string; // adminId
  filedAt: number;
  note?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

/** Operation audit record (§4.3). */
export interface AuditDoc {
  _id: string; // uuid
  actor: string; // adminId (who performed the action)
  action: AuditAction;
  target?: string;
  summary?: string;
  ip?: string;
  ts: number;
}

/** Self-collected time-series metric snapshot (§5). */
export interface MetricSnapshotDoc {
  metric: MetricKey;
  ts: number;
  value: number;
  dims?: Record<string, string>;
  // BSON Date (not epoch number): Mongo TTL only expires Date fields. Stored as new Date(ts) on write;
  // queries/sorts use ts (number). Both fields represent the same moment; only the TTL expiry reads at.
  at: Date;
}

export interface AdminCollections {
  adminAccounts: Collection<AdminAccountDoc>;
  compTickets: Collection<CompTicketDoc>;
  tradeAuditTickets: Collection<TradeAuditTicketDoc>;
  auditLog: Collection<AuditDoc>;
  metricSnapshots: Collection<MetricSnapshotDoc>;
  // Feature flag rules (FEATURE_FLAGS_DESIGN §2.2): _id = flag key; only flags overridden by ops are stored.
  featureFlags: Collection<FeatureFlagDoc>;
}

export interface AdminMongo {
  client: MongoClient;
  db: Db;
  collections: AdminCollections;
  ensureIndexes(snapshotTtlSec: number): Promise<void>;
  close(): Promise<void>;
}

function sanitizeMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
}

export async function createAdminMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<AdminMongo> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    const safeUri = sanitizeMongoUri(uri);
    console.error(
      `[admin-mongo] 连接 MongoDB 失败 (uri=${safeUri}, db=${dbName}): ` +
        `${(err as Error).message}. 请确认数据库已启动且连接配置 (NW_ADMIN_MONGO_URI/NW_MONGO_URI) 正确。`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: AdminCollections = {
    adminAccounts: db.collection<AdminAccountDoc>('adminAccounts'),
    compTickets: db.collection<CompTicketDoc>('compTickets'),
    tradeAuditTickets: db.collection<TradeAuditTicketDoc>('tradeAuditTickets'),
    auditLog: db.collection<AuditDoc>('auditLog'),
    metricSnapshots: db.collection<MetricSnapshotDoc>('metricSnapshots'),
    featureFlags: db.collection<FeatureFlagDoc>('featureFlags'),
  };

  async function ensureIndexes(snapshotTtlSec: number): Promise<void> {
    await collections.adminAccounts.createIndex({ username: 1 }, { unique: true });
    await collections.compTickets.createIndex({ status: 1, initiatedAt: -1 });
    await collections.compTickets.createIndex({ initiatedBy: 1 });
    await collections.compTickets.createIndex({ dispatchKey: 1 }, { unique: true });
    // Trade audit tickets: indexed by status/time; pairKey checks for an existing open ticket for the same pair (dedup).
    await collections.tradeAuditTickets.createIndex({ status: 1, filedAt: -1 });
    await collections.tradeAuditTickets.createIndex({ pairKey: 1 });
    await collections.auditLog.createIndex({ actor: 1, ts: -1 });
    await collections.auditLog.createIndex({ ts: -1 });
    // Trend queries use (metric, ts); TTL recycles old snapshots within the retention window (Date field at).
    await collections.metricSnapshots.createIndex({ metric: 1, ts: -1 });
    await collections.metricSnapshots.createIndex(
      { at: 1 },
      { expireAfterSeconds: snapshotTtlSec },
    );
    // Feature flags: indexed by most-recent update time (_id is the flag key, naturally unique — no extra unique index needed).
    await collections.featureFlags.createIndex({ updatedAt: -1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
