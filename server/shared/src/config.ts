// Environment variable loading (shared by both services).

export interface ServerEnv {
  jwtSecret: string;
  mongoUri: string;
  mongoDb: string;
  /**
   * Internal service authentication key (shared by gateway / matchsvc / game / meta, S1-M).
   * Used for: matchsvc signing match tickets (HMAC) + fallback X-Internal-Key for inter-service internal HTTP.
   * Never exposed to the public internet; must be changed in production.
   *
   * Advanced: optional NW_INTERNAL_KEYS (`caller=key,...`, see @nw/shared/internalAuth) provides each caller
   * its own independent key, enabling per-caller strict auth (identification + isolation + per-service rotation);
   * falls back to this single shared key if not configured.
   * Note: ticket HMAC always uses this internalKey only (matchsvc↔gameserver must share the same key) — it does not go through the per-caller registry.
   */
  internalKey: string;
}

/**
 * The development Mongo, used when a service's own `NW_*_MONGO_URI` is unset.
 *
 * It is deliberately a HOST, not another service's variable. Until 2026-09-12 each service fell back to
 * `NW_MONGO_URI` (`?? base.mongoUri`), i.e. to metaserver's login — and on the deployed stack that login's
 * grants covered every database, so while the fallback was taken the credential isolation of ADR-090 did
 * not exist at all. A fallback to localhost cannot borrow anyone's grants: off a developer's machine there
 * is nothing on this address, and the service dies on a connection refusal instead of quietly reading
 * someone else's data. Production supplies the real per-service strings, and docker-compose.cloud.yml
 * requires all seven rather than defaulting any of them.
 */
export const DEV_MONGO_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0';

/** One required environment variable, with an optional development default. */
export function requiredEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

export function loadServerEnv(): ServerEnv {
  return {
    // Development defaults; must be overridden via env in production.
    jwtSecret: requiredEnv('NW_JWT_SECRET', 'dev-insecure-secret-change-me'),
    mongoUri: requiredEnv('NW_MONGO_URI', DEV_MONGO_URI),
    mongoDb: requiredEnv('NW_MONGO_DB', 'notebook_wars'),
    internalKey: requiredEnv('NW_INTERNAL_KEY', 'dev-insecure-internal-key-change-me'),
  };
}
