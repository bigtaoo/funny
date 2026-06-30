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

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

export function loadServerEnv(): ServerEnv {
  return {
    // Development defaults; must be overridden via env in production.
    jwtSecret: required('NW_JWT_SECRET', 'dev-insecure-secret-change-me'),
    mongoUri: required('NW_MONGO_URI', 'mongodb://127.0.0.1:27017/?replicaSet=rs0'),
    mongoDb: required('NW_MONGO_DB', 'notebook_wars'),
    internalKey: required('NW_INTERNAL_KEY', 'dev-insecure-internal-key-change-me'),
  };
}
