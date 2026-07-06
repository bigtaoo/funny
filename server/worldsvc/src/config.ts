// worldsvc environment variables (S8-0, seventh workspace + dedicated database).
// SLG_DESIGN §14.1: worldsvc exposes a public REST API (/world/*; /auction/* moved to auctionsvc, §9 任务6),
// reuses meta JWT for verifyToken signature verification only (does not connect to the accounts database).
// Internal events are pushed back to clients via gateway /gw/push.
// Note: /family/* routes have been migrated to socialsvc (fifth public face /social/*); worldsvc no longer proxies family requests.
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface WorldsvcEnv extends ServerEnv {
  /** Public REST port (reverse-proxied /world → this port). Default 18084 (avoids Windows reserved port range). */
  port: number;
  host: string;
  /** worldsvc dedicated MongoDB URI (defaults to the same instance as meta). */
  worldMongoUri: string;
  /** worldsvc dedicated database name (physically isolated from meta/commercial/admin). */
  worldMongoDb: string;
  /** Redis connection URL (introduced in S8-0); if absent, no Redis — march scheduling/channel falls back to degraded mode (truly required by S8-1/S8-4). */
  redisUrl: string | undefined;
  /** gateway internal HTTP base URL (worldsvc → /gw/push for real-time event delivery); if absent, no push (REST polling only). */
  gatewayInternalUrl: string | undefined;
  /** commercial internal HTTP base URL (SLG coin sinks: speedups / sect creation / world chat / relocation); if absent, coin spend not supported. */
  commercialInternalUrl: string | undefined;
  /** meta internal HTTP base URL (stronghold loot material grants / owner profiles / siege save-fields); if absent, those degrade. */
  metaInternalUrl: string | undefined;
  /** socialsvc internal HTTP base URL (channel push delegation); if absent, no delegation. */
  socialsvcInternalUrl: string | undefined;
}

export function loadWorldsvcEnv(): WorldsvcEnv {
  const base = loadServerEnv();
  return {
    ...base,
    port: Number(process.env.NW_WORLD_PORT ?? 18084),
    host: process.env.NW_WORLD_HOST ?? '0.0.0.0',
    worldMongoUri: process.env.NW_WORLD_MONGO_URI ?? base.mongoUri,
    worldMongoDb: process.env.NW_WORLD_MONGO_DB ?? 'notebook_wars_world',
    redisUrl: process.env.NW_WORLD_REDIS_URL || undefined,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL || undefined,
    commercialInternalUrl: process.env.NW_COMMERCIAL_INTERNAL_URL || undefined,
    metaInternalUrl: process.env.NW_META_INTERNAL_URL || undefined,
    socialsvcInternalUrl: process.env.NW_SOCIALSVC_INTERNAL_URL || undefined,
  };
}
