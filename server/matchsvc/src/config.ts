// matchsvc environment variables (S1-M5, standalone process). Only uses @nw/shared internalKey
// (for signing tickets + internal auth); connects to no database and does not validate client tokens
// (not reachable by players — only accepts internal HTTP from gateway / gameserver).
import { loadServerEnv, type ServerEnv } from '@nw/shared';

export interface MatchsvcEnv extends ServerEnv {
  /** Internal HTTP port (gateway control commands + gameserver registration/heartbeat → this port; not exposed publicly). */
  internalPort: number;
  host: string;
  /** gateway internal HTTP base URL (matchsvc pushes room state / match_found back to gateway → players). null = push unavailable. */
  gatewayInternalUrl: string | null;
  /** Static game fallback address (single-instance deployment: used directly when no game instance has registered). */
  gamePublicWsUrl: string | null;
  /** Ticket validity in seconds (tolerance window from match_found to connecting to gameserver). Default 30. */
  ticketTtlSec: number;
  /** admin internal base URL (polls GET /admin/internal/flags to fetch raw feature flag rules). null = flags not read (all default). */
  adminInternalUrl: string | null;
  /** Deployment region (injected into feature flag evaluation context). Empty = no region-based targeting. */
  region: string | null;
  /** If ranked matchmaking wait exceeds this many milliseconds, evaluate match_bot_fallback to decide whether to fall back to an AI opponent. Default 30000. */
  botFallbackMs: number;
  /** Redis URL for cross-login active-match tracking (login-reconnect-prompt). null = feature disabled (no persistence, resume prompt never fires). */
  redisUrl: string | null;
}

export function loadMatchsvcEnv(): MatchsvcEnv {
  return {
    ...loadServerEnv(),
    internalPort: Number(process.env.NW_MM_INTERNAL_PORT ?? 8091),
    host: process.env.NW_MM_HOST ?? '0.0.0.0',
    gatewayInternalUrl: process.env.NW_GATEWAY_INTERNAL_URL ?? null,
    gamePublicWsUrl: process.env.NW_GAME_PUBLIC_WS_URL ?? null,
    ticketTtlSec: Number(process.env.NW_TICKET_TTL_SEC ?? 30),
    adminInternalUrl: process.env.NW_ADMIN_INTERNAL_URL ?? null,
    region: process.env.NW_REGION ?? null,
    botFallbackMs: Number(process.env.NW_MM_BOT_FALLBACK_MS ?? 30000),
    redisUrl: process.env.NW_REDIS_URL ?? null,
  };
}
