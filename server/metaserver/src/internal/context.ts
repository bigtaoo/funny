// Shared context passed to each internal/* route module — avoids re-deriving `authed` and re-threading deps per file.
import type { Collections, RedisLike } from '@nw/shared';
import type { GatewayClient } from '../gatewayClient.js';
import type { CommercialClient } from '../commercialClient.js';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';

export interface InternalCtx {
  cols: Collections;
  now: () => number;
  gateway: GatewayClient;
  commercial: CommercialClient;
  socialsvc: MetaSocialsvcClient;
  /** Verifies X-Internal-Key (timing-safe, strict per-caller + legacy shared-key fallback). */
  authed: (key: unknown) => boolean;
  /** Active-match Redis client (login-reconnect-prompt); null = feature disabled (nothing to clear). */
  redis: RedisLike | null;
}
