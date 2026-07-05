// meta internal routes (M17/M19, S1-M3) — not visible to players, authenticated via X-Internal-Key, bypasses openapi glue.
//   GET  /internal/elo            gateway fetches ELO before queuing (matchsvc stays DB-free, §8.5)
//   POST /internal/match/report   gameserver end-of-match report: reconcile + compute ELO, write saves.pvp + archive matches (§8.3)
//
// ELO settlement / archive logic migrated from gameserver (M19): ladder authority consolidated into meta. room_id is idempotent (matches unique).
//
// Route registration is split by domain under ./internal/* (accounts, mail, match report, economy transfers,
// ladder/season, event admin, promo+gacha admin) — this file only wires up the shared context and composes them.
import type { FastifyInstance } from 'fastify';
import type { Collections } from '@nw/shared';
import { createInternalAuth } from '@nw/shared';
import type { GatewayClient } from './gatewayClient.js';
import type { CommercialClient } from './commercialClient.js';
import { nullMetaSocialsvcClient, type MetaSocialsvcClient } from './socialsvcClient.js';
import type { InternalCtx } from './internal/context.js';
import { registerAccountRoutes } from './internal/accountRoutes.js';
import { registerMailRoutes } from './internal/mailRoutes.js';
import { registerMatchReportRoutes } from './internal/matchReport.js';
import { registerEconomyRoutes } from './internal/economyRoutes.js';
import { registerLadderRoutes } from './internal/ladderRoutes.js';
import { registerEventAdminRoutes } from './internal/eventAdminRoutes.js';
import { registerPromoGachaRoutes } from './internal/promoGachaRoutes.js';

export interface InternalDeps {
  cols: Collections;
  /** Single shared secret key (legacy fallback + ticket HMAC). */
  internalKey: string;
  /** Optional per-caller key registry (parsed from NW_INTERNAL_KEYS); if non-empty, enables strict per-caller authentication. */
  internalKeys?: Record<string, string>;
  now: () => number;
  /** Peer-judge client (Phase C). If unconfigured, available=false and ranked mismatches are voided directly. */
  gateway: GatewayClient;
  /** commercial client: sends ranked-victory coins by tier to the winner (§2.3b). If unconfigured, no coins are sent. */
  commercial: CommercialClient;
  /** socialsvc client (P2): sole mail write authority — system mail (comp tickets/season/event rewards) is written there, not in meta's own DB. */
  socialsvc?: MetaSocialsvcClient;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  const { cols, internalKey, internalKeys, now, gateway, commercial } = deps;
  const socialsvc = deps.socialsvc ?? nullMetaSocialsvcClient;

  // Centralized verifier: timing-safe + strict per-caller (NW_INTERNAL_KEYS) + single shared-key fallback.
  const auth = createInternalAuth({ keys: internalKeys, legacyKey: internalKey });
  const authed = (key: unknown): boolean =>
    auth.verify({ 'x-internal-key': typeof key === 'string' ? key : undefined }).ok;

  const ctx: InternalCtx = { cols, now, gateway, commercial, socialsvc, authed };

  registerAccountRoutes(app, ctx);
  registerMailRoutes(app, ctx);
  registerMatchReportRoutes(app, ctx);
  registerEconomyRoutes(app, ctx);
  registerLadderRoutes(app, ctx);
  registerEventAdminRoutes(app, ctx);
  registerPromoGachaRoutes(app, ctx);
}
