// admin 环境变量（OPS_DESIGN §8 基线）。两层鉴权：admin JWT（运维用户）用独立 secret，
// 与玩家 NW_JWT_SECRET 隔离；NW_INTERNAL_KEY（shared）用于调业务服务的内部端点。
// 独立库 notebook_wars_admin（缺省复用 meta 同实例）。玩家不可达，反代不路由到它。
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface AdminEnv extends ServerEnv {
  /** 给运维前端的 API 端口（带 admin 会话鉴权；不暴露公网/仅内网/VPN）。默认 18083。 */
  port: number;
  host: string;
  /** admin 专用 JWT secret（与玩家 jwtSecret 隔离）。 */
  adminJwtSecret: string;
  /** admin 会话有效期（zeit 字符串）。默认 8h。 */
  adminJwtTtl: string;
  /** admin 专属库 Mongo URI（缺省复用 meta 同实例）。 */
  adminMongoUri: string;
  /** admin 专属库名（与业务库物理隔离）。 */
  adminMongoDb: string;
  /** 部署期种子超管账号（首启注入；为空跳过）。 */
  seedUser: string | null;
  seedPass: string | null;
  // —— 业务服务内部基址（X-Internal-Key 调用）——
  /** meta REST 基址（player.lookup / 系统邮件端点）。null = 相关能力降级。 */
  metaBaseUrl: string | null;
  /** gateway 内部 HTTP 基址（GET /internal/stats 在线数）。 */
  gatewayInternalUrl: string | null;
  /** matchsvc 内部 HTTP 基址（GET /internal/stats 匹配池）。 */
  matchsvcInternalUrl: string | null;
  /** 自采采样间隔 ms（写 metricSnapshots）。默认 30000；<=0 关闭采样。 */
  sampleIntervalMs: number;
  /** metricSnapshots TTL（秒，保留窗口）。默认 14 天。 */
  snapshotTtlSec: number;
}

export function loadAdminEnv(): AdminEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_ADMIN_PORT ?? 18083),
    host: process.env.NW_ADMIN_HOST ?? '0.0.0.0',
    adminJwtSecret: process.env.NW_ADMIN_JWT_SECRET ?? 'dev-insecure-admin-secret-change-me',
    adminJwtTtl: process.env.NW_ADMIN_JWT_TTL ?? '8h',
    adminMongoUri: process.env.NW_ADMIN_MONGO_URI ?? base.mongoUri,
    adminMongoDb: process.env.NW_ADMIN_MONGO_DB ?? 'notebook_wars_admin',
    seedUser: process.env.NW_ADMIN_SEED_USER ?? null,
    seedPass: process.env.NW_ADMIN_SEED_PASS ?? null,
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    matchsvcInternalUrl: process.env.NW_MATCHSVC_INTERNAL_URL ?? null,
    sampleIntervalMs: Number(process.env.NW_ADMIN_SAMPLE_MS ?? 30000),
    snapshotTtlSec: Number(process.env.NW_ADMIN_SNAPSHOT_TTL_SEC ?? 14 * 24 * 3600),
  };
}
