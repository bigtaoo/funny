// gateway environment variables (reuses @nw/shared ServerEnv: jwtSecret verifies client tokens, internalKey for inter-service auth).
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface GatewayEnv extends ServerEnv {
  /** Public control-plane WS port (reverse proxy /gw → this port). */
  port: number;
  host: string;
  /** Internal HTTP port (matchsvc pushes events back via /gw/push → this port; not exposed to the public internet). */
  internalPort: number;
  /** meta REST base URL (fetch ELO: GET {metaBaseUrl}/internal/elo). Absent means ranked is unavailable. */
  metaBaseUrl: string | null;
  /** matchsvc internal HTTP base URL (forwards player control commands). null = multiplayer unavailable. */
  matchsvcInternalUrl: string | null;
  /** Redis connection string (S8-4b, subscribes to GW_PUSH_REDIS_CHANNEL for sect channel fan-out); absent = real-time push degraded. */
  redisUrl: string | undefined;
  /** socialsvc internal base URL (P3: presence events POST /internal/presence/online|offline); absent = gateway handles online-friend broadcast directly. */
  socialsvcInternalUrl: string | null;
}

export function loadGatewayEnv(): GatewayEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GW_PORT ?? 8082),
    host: process.env.NW_GW_HOST ?? '0.0.0.0',
    internalPort: Number(process.env.NW_GW_INTERNAL_PORT ?? 8090),
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    matchsvcInternalUrl: process.env.NW_MATCHSVC_INTERNAL_URL ?? null,
    redisUrl: process.env.NW_GW_REDIS_URL || undefined,
    socialsvcInternalUrl: process.env.NW_SOCIALSVC_INTERNAL_URL ?? null,
  };
}
