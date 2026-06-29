// Admin environment variables (OPS_DESIGN §8 baseline). Two-layer auth: admin JWT (ops users) uses a dedicated secret,
// isolated from the player NW_JWT_SECRET; NW_INTERNAL_KEY (shared) is used to call internal endpoints on business services.
// Separate database notebook_wars_admin (defaults to the same instance as meta). Unreachable by players; the reverse proxy does not route to it.
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface AdminEnv extends ServerEnv {
  /** API port for the ops frontend (protected by admin session auth; not exposed to the public internet — internal/VPN only). Default 18083. */
  port: number;
  host: string;
  /** Admin-dedicated JWT secret (isolated from the player jwtSecret). */
  adminJwtSecret: string;
  /** Admin session TTL (zeit duration string). Default 8h. */
  adminJwtTtl: string;
  /** Admin-dedicated Mongo URI (defaults to the same instance as meta). */
  adminMongoUri: string;
  /** Admin-dedicated database name (physically isolated from the business database). */
  adminMongoDb: string;
  /** Seed super-admin account injected at deployment time on first start; skipped if empty. */
  seedUser: string | null;
  seedPass: string | null;
  // —— internal base URLs for business services (called with X-Internal-Key) ——
  /** meta REST base URL (player.lookup / system mail endpoints). null = related capabilities degraded. */
  metaBaseUrl: string | null;
  /** gateway internal HTTP base URL (GET /internal/stats for online count). */
  gatewayInternalUrl: string | null;
  /** matchsvc internal HTTP base URL (GET /internal/stats for matchmaking pool). */
  matchsvcInternalUrl: string | null;
  /** analyticsvc internal HTTP base URL (GET /internal/query for analytics queries). */
  analyticsBaseUrl: string | null;
  /** worldsvc internal HTTP base URL (SLG season ops /admin/world/*, G7/§17.7). null = SLG ops degraded. */
  worldInternalUrl: string | null;
  /** Self-scrape sampling interval in ms (writes metricSnapshots). Default 30000; <=0 disables sampling. */
  sampleIntervalMs: number;
  /** metricSnapshots TTL in seconds (retention window). Default 14 days. */
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
    analyticsBaseUrl: process.env.NW_ANALYTICS_BASE_URL ?? null,
    worldInternalUrl: process.env.NW_WORLD_INTERNAL_URL ?? null,
    sampleIntervalMs: Number(process.env.NW_ADMIN_SAMPLE_MS ?? 30000),
    snapshotTtlSec: Number(process.env.NW_ADMIN_SNAPSHOT_TTL_SEC ?? 14 * 24 * 3600),
  };
}
