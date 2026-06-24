// admin 专属库工厂（OPS_DESIGN §4.3）。库名 notebook_wars_admin，与业务库物理隔离。
// 集合：adminAccounts / compTickets / auditLog / metricSnapshots。
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

/** 运维账号（独立账号库，绝不复用玩家账号；§2.1）。 */
export interface AdminAccountDoc {
  _id: string; // uuid
  username: string; // 登录名（唯一索引）
  passwordHash: string; // shared/password scrypt
  role: AdminRole;
  displayName: string;
  disabled: boolean;
  createdAt: number;
  createdBy?: string; // 创建者 adminId
  lastLoginAt?: number;
}

/** 补偿工单（§3.1）。 */
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
  approvedBy?: string; // adminId（必须 ≠ initiatedBy）
  approvedAt?: number;
  executedAt?: number;
  /** 执行幂等键（防重复执行），唯一索引。 */
  dispatchKey: string;
  recipientCount?: number;
  error?: string;
}

/** SLG 异常交易审计工单（G7 反 RMT）。立单时冻结异常快照；单人裁定 + 审计留痕。 */
export interface TradeAuditTicketDoc {
  _id: string; // uuid
  /** 去重键 `${worldId}:${sellerId}:${buyerId}`：同配对存在 open 工单时不重复立。 */
  pairKey: string;
  snapshot: TradeAuditSnapshot;
  status: TradeAuditTicketStatus;
  filedBy: string; // adminId
  filedAt: number;
  note?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

/** 操作审计（§4.3）。 */
export interface AuditDoc {
  _id: string; // uuid
  actor: string; // adminId
  action: AuditAction;
  target?: string;
  summary?: string;
  ip?: string;
  ts: number;
}

/** 自采时序快照（§5）。 */
export interface MetricSnapshotDoc {
  metric: MetricKey;
  ts: number;
  value: number;
  dims?: Record<string, string>;
  // BSON Date（非 epoch number）：Mongo TTL 只过期 Date 字段。写入存 new Date(ts)，
  // 查询/排序用 ts（number）。两字段同刻，仅 TTL 回收读 at。
  at: Date;
}

export interface AdminCollections {
  adminAccounts: Collection<AdminAccountDoc>;
  compTickets: Collection<CompTicketDoc>;
  tradeAuditTickets: Collection<TradeAuditTicketDoc>;
  auditLog: Collection<AuditDoc>;
  metricSnapshots: Collection<MetricSnapshotDoc>;
  // 功能开关规则（FEATURE_FLAGS_DESIGN §2.2）：_id = flag key，只存被运营覆盖过的 flag。
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
    // 审计工单：按状态/时间列；pairKey 查同配对是否已有 open 工单（去重）。
    await collections.tradeAuditTickets.createIndex({ status: 1, filedAt: -1 });
    await collections.tradeAuditTickets.createIndex({ pairKey: 1 });
    await collections.auditLog.createIndex({ actor: 1, ts: -1 });
    await collections.auditLog.createIndex({ ts: -1 });
    // 趋势按 (metric, ts) 查；TTL 按保留窗口回收旧快照（Date 字段 at）。
    await collections.metricSnapshots.createIndex({ metric: 1, ts: -1 });
    await collections.metricSnapshots.createIndex(
      { at: 1 },
      { expireAfterSeconds: snapshotTtlSec },
    );
    // 功能开关：按最近修改时间列（_id 即 flag key，天然唯一，无需额外唯一索引）。
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
