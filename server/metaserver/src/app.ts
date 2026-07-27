// Fastify application assembly (separated from process bootstrap for testability/inject).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Collections, JwtConfig, FeatureFlagCache, RedisLike, SaveData } from '@nw/shared';
import { createLogger, internalKeysFromEnv } from '@nw/shared';
import { MetaService } from './service.js';
import { assembleEquipmentInv } from './equipment.js';
import { registerAdCallbackRoutes } from './ads.js';
import { registerPaddleRoutes } from './paddle.js';

const log = createLogger('meta');
import { makeSecurityHandlers } from './auth.js';
import { extractBearer, verifyToken } from '@nw/shared';
import { registerInternalRoutes } from './internal.js';
import { HttpCommercialClient, type CommercialClient } from './commercialClient.js';
import { HttpGatewayClient, type GatewayClient } from './gatewayClient.js';
import { HttpMetaSocialsvcClient, nullMetaSocialsvcClient } from './socialsvcClient.js';
import { registerRoutes } from './generated/routes.gen.js';

const here = dirname(fileURLToPath(import.meta.url));
// SPEC_PATH is exported for the openapi-response-schema.test.ts static schema guard.
// Routes are no longer loaded from this path at runtime (ADR-023: build-time codegen).
export const SPEC_PATH = resolve(here, '../../contracts/openapi.yml');

export interface BuildAppOpts {
  cols: Collections;
  jwt: JwtConfig;
  /** Internal service auth key (used by gateway to fetch ELO / gameserver to report match results / commercial calls). */
  internalKey: string;
  /** commercial internal base URL (null = economy endpoints return 503); or inject a client directly (for tests). */
  commercialUrl?: string | null;
  commercial?: CommercialClient;
  /** gateway internal base URL (peer judge /gw/judge; null = judge unavailable); or inject a client directly (for tests). */
  gatewayUrl?: string | null;
  gateway?: GatewayClient;
  /** gateway public WS URL, sent to the client in auth/save responses (null = not sent). */
  gatewayPublicUrl?: string | null;
  now?: () => number;
  logger?: boolean;
  /** Maximum auth attempts per IP within 15 minutes (0 = disabled, for tests). Default 20. */
  authRateLimit?: number;
  /** Feature flag cache (used for public /bootstrap evaluation). null/omitted = no flag source; bootstrap always returns an empty map. */
  flags?: FeatureFlagCache | null;
  /** Deployment region (injected into the flag evaluation context). */
  region?: string | null;
  /** Loki push URL (POST /client/log is forwarded here; null = silently discarded). */
  lokiPushUrl?: string | null;
  /** socialsvc internal base URL (P2: friend/chat/mail routing proxy); null = metaserver handles these itself. */
  socialsvcUrl?: string | null;
  socialsvc?: import('./socialsvcClient.js').MetaSocialsvcClient;
  /** Active-match Redis client (login-reconnect-prompt): getSave() surfaces a resume hint, /internal/match/report clears it. null/omitted = feature disabled. */
  redis?: RedisLike | null;
}

export async function buildApp(opts: BuildAppOpts): Promise<FastifyInstance> {
  // bodyLimit set to 4MB (default is only 1MB): state-stream share upload compressed blob (capped at 2MB in service.ts).
  // Fastify's body-size gate must be ≥ the application-layer cap; otherwise a legitimate blob >1MB is rejected by
  // Fastify first with 413 (FST_ERR_CTP_BODY_TOO_LARGE) and the application's graceful 400 "replay too large" never fires.
  // Other endpoints have bodies well below this limit and are unaffected.
  // maxParamLength raised from find-my-way's default 100: /mail/:id/claim's id is socialsvc's `${dispatchKey}:${to}`
  // mailId — for auction-returned/sold mail, dispatchKey embeds the full auctionId (itself `a:{sellerId-uuid}:{ts}:{n}`),
  // so `${dispatchKey}:${to}` routinely exceeds 100 chars. Past that length find-my-way doesn't match the route at
  // all (raw 404 "Route not found" from Fastify, never reaching claimMail) — surfaced to players as "claim failed"
  // with no attachment ever really invalid. 200 gives ~2x headroom over the longest realistic mailId.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024, routerOptions: { maxParamLength: 200 } });
  await app.register(cors, { origin: true });

  // Human-readable request/response log (for debugging, replacing pino JSON). One line per request on completion: method path status elapsed.
  // Health probes are excluded from logging (polling noise).
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return;
    const ms = Math.round(reply.elapsedTime ?? 0);
    log.info(`${req.method} ${req.url} -> ${reply.statusCode}`, { ms });
  });

  // Equipment storage split backstop (2026-07-26, perf — see equipment.ts header): equipment instances
  // live in their own collection now, not embedded in SaveData.equipmentInv. ~30 handlers across
  // auth/save/pve/economy/liveops/cards/ladderSeason return a `save: SaveData` (either nested under
  // `ok()`'s `{data:{save}}` envelope, or — putSave's 409 conflict case — at the top level); rather than
  // trust every one of those call sites to remember an explicit join, this single hook is the centralized
  // guarantee that no OTHER response can ever accidentally ship without the full map.
  // equipment.ts's own mutation endpoints (craft/enhance/salvage/reforge/equip) are the deliberate
  // exception (phase 2, EQUIPMENT_DESIGN §3.3): they set `equipmentInv: null` (via `leanSave`), not
  // `undefined` — this hook only backfills on `undefined` ("forgot to populate"), so `null` ("explicitly
  // omitted, caller already knows what changed") passes through untouched, and those endpoints skip the
  // `equipmentInstances.find({accountId})` entirely instead of paying for it just to throw it away.
  app.addHook('preSerialization', async (_req, _reply, payload) => {
    const p = payload as { save?: SaveData; data?: { save?: SaveData } } | null;
    const save = p?.data?.save ?? p?.save;
    // opts.cols.equipmentInstances may be absent in tests that build their own minimal fake Collections
    // (many unit-style suites drive buildApp() directly with a hand-rolled `{saves, accounts}` stub, not
    // the full interface) — skip gracefully rather than throwing, same defensive style as the rest of
    // this codebase's optional-dependency checks (e.g. `commercial.available`).
    if (save && typeof save === 'object' && save.accountId && save.equipmentInv === undefined && opts.cols.equipmentInstances) {
      save.equipmentInv = await assembleEquipmentInv(opts.cols, save.accountId, save);
    }
    return payload;
  });

  // Unified error envelope: validation failures and security-handler throws are all converted to ApiResp.
  // Must be set before route registration — Fastify binds the error handler into the route context at
  // registration time; calling setErrorHandler afterwards has no effect on already-registered routes.
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error.statusCode ?? 500;
    const code =
      status === 401 ? 'UNAUTHENTICATED' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL';
    // 5xx = real problem (include stack), 4xx = expected validation failure (single line only).
    if (status >= 500) log.error(`${req.method} ${req.url} ${status} ${code}`, { err: error.stack ?? error.message });
    else log.warn(`${req.method} ${req.url} ${status} ${code}`, { message: error.message });
    reply.code(status).send({ ok: false, error: { code, message: error.message } });
  });

  // Liveness probe (not in openapi.yml): reverse-proxy strips /api prefix and routes to /health.
  // Used for compose / load-balancer / C-3 deployment smoke tests.
  app.get('/health', async () => ({ ok: true }));

  const now = opts.now ?? (() => Date.now());
  const commercial =
    opts.commercial ?? new HttpCommercialClient(opts.commercialUrl ?? null, opts.internalKey);
  const gateway =
    opts.gateway ?? new HttpGatewayClient(opts.gatewayUrl ?? null, opts.internalKey);
  const socialsvc =
    opts.socialsvc ?? (opts.socialsvcUrl ? new HttpMetaSocialsvcClient(opts.socialsvcUrl, opts.internalKey) : nullMetaSocialsvcClient);
  const redis = opts.redis ?? null;
  const service = new MetaService({
    cols: opts.cols,
    jwt: opts.jwt,
    now,
    commercial,
    gatewayPublicUrl: opts.gatewayPublicUrl ?? null,
    gateway,
    authRateLimit: opts.authRateLimit ?? 20,
    flags: opts.flags ?? null,
    region: opts.region ?? null,
    lokiPushUrl: opts.lokiPushUrl ?? null,
    socialsvc,
    redis,
  });

  // Ad platform SSV callbacks (platform-initiated; no player authentication).
  registerAdCallbackRoutes(app, { cols: opts.cols, commercial, now });

  // Paddle Billing routes: player checkout session + Paddle webhook.
  registerPaddleRoutes(app, {
    cols: opts.cols,
    commercial,
    now,
    getAccountId(req) {
      const token = extractBearer(req.headers['authorization']);
      if (!token) return null;
      try {
        return verifyToken(token, opts.jwt);
      } catch {
        return null;
      }
    },
  });

  // Internal routes (not visible to players; X-Internal-Key auth): fetch ELO + end-of-match reporting + peer judge.
  registerInternalRoutes(app, {
    cols: opts.cols,
    internalKey: opts.internalKey,
    internalKeys: internalKeysFromEnv(),
    now,
    gateway,
    commercial,
    socialsvc,
    redis,
  });

  // Public REST routes — generated from openapi.yml at build time (ADR-023).
  // MetaService is structurally checked against MetaHandlers at compile time (missing method = tsc error).
  await registerRoutes(app, service, makeSecurityHandlers(opts.jwt));

  return app;
}
