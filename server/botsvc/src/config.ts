// botsvc env loading. Unlike the other services, botsvc owns no database and verifies no player JWTs —
// it is itself a fleet of clients, so it only needs the public base URLs it dials out to plus the
// internal key it presents when calling commercial's/gateway's internal-only endpoints (BOTSVC_DESIGN §7).
export interface BotsvcEnv {
  /** Internal admin API (status/scale/pause), never exposed publicly. Default 18087 (next free slot after auctionsvc 18086). */
  port: number;
  host: string;
  /** Total account pool size (BOTSVC_DESIGN §3.1). */
  poolSize: number;
  /** Steady-state concurrent-online target before any capacity shedding kicks in. */
  targetOnline: number;
  /** Assumed total server capacity (BOTSVC_DESIGN §4); botsvc treats this as configuration, not something it measures. */
  capacityCap: number;
  /** Online count (across all players, incl. bots) at which botsvc starts shedding sessions early. */
  shedStartAt: number;
  /** Online count at which botsvc has shed down to zero bots. Between shedStartAt and shedFullAt, target ramps down linearly. */
  shedFullAt: number;
  metaBaseUrl: string;
  socialBaseUrl: string;
  worldBaseUrl: string;
  gatewayInternalUrl: string;
  /** Gateway control-plane WS (`/gw`), used only when device-login doesn't return its own gatewayUrl. */
  gatewayWsUrl: string;
  commercialInternalUrl: string;
  internalKey: string;
  /** Probability a lobby_idle bot enters ranked matchmaking on any given scheduler tick (BOTSVC_DESIGN §3.2). */
  battleChancePerTick: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export function loadBotsvcEnv(): BotsvcEnv {
  return {
    port: num('NW_BOT_PORT', 18087),
    host: process.env.NW_BOT_HOST || '127.0.0.1',
    poolSize: num('NW_BOT_POOL_SIZE', 1000),
    targetOnline: num('NW_BOT_TARGET_ONLINE', 100),
    capacityCap: num('NW_BOT_CAPACITY_CAP', 3000),
    shedStartAt: num('NW_BOT_SHED_START_AT', 2500),
    shedFullAt: num('NW_BOT_SHED_FULL_AT', 2800),
    metaBaseUrl: process.env.NW_META_BASE_URL || 'http://127.0.0.1:18080',
    socialBaseUrl: process.env.NW_SOCIAL_BASE_URL || 'http://127.0.0.1:8085',
    worldBaseUrl: process.env.NW_WORLD_BASE_URL || 'http://127.0.0.1:18084',
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL || 'http://127.0.0.1:8090',
    gatewayWsUrl: process.env.NW_GATEWAY_WS_URL || 'ws://127.0.0.1:8086/gw',
    commercialInternalUrl: process.env.NW_COMMERCIAL_INTERNAL_URL || 'http://127.0.0.1:18082',
    internalKey: process.env.NW_INTERNAL_KEY || 'dev-insecure-internal-key-change-me',
    battleChancePerTick: Number(process.env.NW_BOT_BATTLE_CHANCE ?? 0.05),
  };
}
