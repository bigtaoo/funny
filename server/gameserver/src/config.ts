// gameserver environment variables (reuses @nw/shared ServerEnv). After slimming (M16) it no longer connects to Mongo:
// identity is established by the ticket (verified with internalKey); end-of-match results are POSTed to meta (metaBaseUrl).
import { loadServerEnv, type ServerEnv } from '@nw/shared';
import { randomUUID } from 'crypto';

export interface GameEnv extends ServerEnv {
  port: number;
  host: string;
  /** meta REST internal base URL (end-of-match report POSTed to {metaBaseUrl}/internal/match/report). null = no reporting. */
  metaBaseUrl: string | null;
  /** Public WS address of this instance exposed to clients (written into ticket.game_url; used when registering with matchsvc). */
  publicWsUrl: string | null;
  /** matchsvc internal HTTP base URL (startup registration + heartbeat). null = no registration (matchsvc falls back to a static address). */
  matchsvcInternalUrl: string | null;
  /** This instance's id (registration identifier). */
  gameId: string;
  /** Concurrent match capacity (allocation weight). */
  capacity: number;
}

export function loadGameEnv(): GameEnv {
  return {
    ...loadServerEnv(),
    port: Number(process.env.NW_GAME_PORT ?? 8081),
    host: process.env.NW_GAME_HOST ?? '0.0.0.0',
    metaBaseUrl: process.env.NW_META_BASE_URL ?? null,
    publicWsUrl: process.env.NW_GAME_PUBLIC_WS_URL ?? null,
    matchsvcInternalUrl: process.env.NW_MATCHSVC_INTERNAL_URL ?? null,
    gameId: process.env.NW_GAME_ID ?? randomUUID(),
    capacity: Number(process.env.NW_GAME_CAPACITY ?? 100),
  };
}
