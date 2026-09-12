// analyticsvc environment variables (A9-1).
// Ninth process; not reachable by players (reverse proxy does not route to it; internal network only). Reuses the meta JWT for verifyToken signature verification only.
import { DEV_MONGO_URI, loadServerEnv, requiredEnv, type ServerEnv } from '@nw/shared';

export interface AnalyticssvcEnv extends ServerEnv {
  port: number;
  host: string;
  /** Mongo URI for `notebook_wars_analytics` — this service's OWN least-privilege login.
   *  Never falls back to another service's variable; unset means the local dev Mongo (ADR-090). */
  analyticsMongoUri: string;
  /** Dedicated database name (physically separate from meta/commercial/admin/world). */
  analyticsMongoDb: string;
}

export function loadAnalyticssvcEnv(): AnalyticssvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_ANALYTICS_PORT ?? 18085),
    host: process.env.NW_ANALYTICS_HOST ?? '0.0.0.0',
    analyticsMongoUri: requiredEnv('NW_ANALYTICS_MONGO_URI', DEV_MONGO_URI),
    analyticsMongoDb: process.env.NW_ANALYTICS_MONGO_DB ?? 'notebook_wars_analytics',
  };
}
