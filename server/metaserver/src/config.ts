import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MetaEnv extends ServerEnv {
  port: number;
  host: string;
  /** Internal HTTP base URL for the commercial service (wallet / coin deduction / gacha / recharge / ads). null = economy endpoints unavailable (503). */
  commercialUrl: string | null;
  /** Internal HTTP base URL for the gateway service (peer judge /gw/judge). null = judge unavailable (ranked hash mismatch is voided directly). */
  gatewayInternalUrl: string | null;
  /**
   * Public control-plane WebSocket URL for the gateway (clients connect here for rooms/matchmaking), delivered to clients in auth/save responses.
   * Clients hard-code only the meta address; gateway and game addresses are fetched at runtime — gateway via this URL, game via match_found.
   * null = not delivered (client falls back to its own config/derivation). Example: ws://host:8082/gw or wss://host/gw.
   */
  gatewayPublicUrl: string | null;
  /** Achievement anti-cheat offline audit batch interval (ms). 0 = disabled (default 60000). Requires gatewayInternalUrl to be configured for judge re-computation. */
  auditIntervalMs: number;
  /** Number of candidate ranked matches inspected per audit batch (default 5). */
  auditSampleLimit: number;
  /**
   * Maximum auth attempts (register/login/oauth) per IP per 15 minutes.
   * 0 = rate limiting disabled (for test/CI environments). Default 20.
   */
  authRateLimit: number;
  /** Internal base URL for the admin service (polls GET /admin/internal/flags for raw feature flag rules; used to evaluate the public /bootstrap endpoint). null = flags not read (all defaults → bootstrap always returns an empty map). */
  adminInternalUrl: string | null;
  /** Internal HTTP base URL for the social service (P2: friend/DM/mail routing proxy + mail claim). null = not proxied (routes remain handled by metaserver itself). */
  socialsvcInternalUrl: string | null;
  /** Deployment region (injected into the feature flag evaluation context). Empty = no region-based targeting. */
  region: string | null;
  /**
   * Loki push API URL (POST /client/log forwards client logs here, FEATURE_FLAGS_DESIGN §9.4).
   * null = not forwarded (silently dropped). Example: http://loki:3100/loki/api/v1/push; requires the metaserver container to resolve
   * loki (the observability stack runs on an isolated network — see observability/README.md "network pitfalls"). Unreachable → silently dropped, never affects players.
   */
  lokiPushUrl: string | null;
  /** Redis URL for cross-login active-match tracking (login-reconnect-prompt). null = feature disabled (getSave never returns activeMatch). */
  redisUrl: string | null;
}

export function loadMetaEnv(): MetaEnv {
  return {
    ...loadServerEnv(),
    // Default 18080: Windows (Hyper-V/WSL) often reserves port 8080 in the netsh reserved port range, causing listen to fail with EACCES.
    port: Number(process.env.NW_META_PORT ?? 18080),
    host: process.env.NW_META_HOST ?? '0.0.0.0',
    commercialUrl: process.env.NW_COMMERCIAL_INTERNAL_URL ?? null,
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    gatewayPublicUrl: process.env.NW_GATEWAY_PUBLIC_WS_URL ?? null,
    auditIntervalMs: Number(process.env.NW_ACHIEVEMENT_AUDIT_INTERVAL_MS ?? 60000),
    auditSampleLimit: Number(process.env.NW_ACHIEVEMENT_AUDIT_SAMPLE_LIMIT ?? 5),
    authRateLimit: Number(process.env.NW_AUTH_RATE_LIMIT ?? 20),
    adminInternalUrl: process.env.NW_ADMIN_INTERNAL_URL ?? null,
    socialsvcInternalUrl: process.env.NW_SOCIALSVC_INTERNAL_URL ?? null,
    region: process.env.NW_REGION ?? null,
    lokiPushUrl: process.env.NW_LOKI_PUSH_URL ?? null,
    redisUrl: process.env.NW_REDIS_URL ?? null,
  };
}
