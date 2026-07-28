// commercial environment variables (S5-1, isolated process + isolated database). Not reachable by players; accepts only meta's internal HTTP.
// Reuses @nw/shared internalKey (shared with meta / gateway / matchsvc / game).
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface CommercialEnv extends ServerEnv {
  /** Internal HTTP port (meta → this port; not exposed publicly). Default: 18082 (avoids Windows reserved range 8082). */
  port: number;
  host: string;
  /** Mongo URI for the commercial dedicated database (defaults to the same instance as meta). */
  commMongoUri: string;
  /** commercial dedicated database name (physically separate from the meta database). */
  commMongoDb: string;
  /** Redis URL for the victoryDaily counter (2026-07-27, moved off Mongo — shared/src/dailyCounter.ts).
   *  null = unconfigured; falls back to a correct-for-single-instance in-process counter, not a disabled cap. */
  redisUrl: string | null;
}

export function loadCommercialEnv(): CommercialEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_COMM_PORT ?? 18082),
    host: process.env.NW_COMM_HOST ?? '0.0.0.0',
    commMongoUri: process.env.NW_COMM_MONGO_URI ?? base.mongoUri,
    commMongoDb: process.env.NW_COMM_MONGO_DB ?? 'notebook_wars_commercial',
    redisUrl: process.env.NW_REDIS_URL ?? null,
  };
}
