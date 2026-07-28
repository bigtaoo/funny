// Shared context passed to each internal/* route module — avoids re-deriving `authed` and re-threading deps per file.
import type { Collections, RedisLike } from '@nw/shared';
import type { GatewayClient } from '../gatewayClient.js';
import type { CommercialClient } from '../commercialClient.js';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';
import type { AccountCache } from '../accountCache.js';

export interface InternalCtx {
  cols: Collections;
  now: () => number;
  gateway: GatewayClient;
  commercial: CommercialClient;
  socialsvc: MetaSocialsvcClient;
  /** Verifies X-Internal-Key (timing-safe, strict per-caller + legacy shared-key fallback). */
  authed: (headers: Record<string, string | string[] | undefined>) => boolean;
  /** Active-match Redis client (login-reconnect-prompt); null = feature disabled (nothing to clear). */
  redis: RedisLike | null;
  /** Ban-status / publicId reverse-lookup cache (2026-07-27, accountCache.ts), shared with MetaService. */
  accountCache: AccountCache;
}
