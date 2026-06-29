// Fastify application assembly (separated from process bootstrap for testability/inject).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import openapiGlue from 'fastify-openapi-glue';
import type { Collections, JwtConfig, FeatureFlagCache } from '@nw/shared';
import { createLogger, internalKeysFromEnv } from '@nw/shared';
import { MetaService } from './service.js';
import { registerAdCallbackRoutes } from './ads.js';

const log = createLogger('meta');
import { makeSecurityHandlers } from './auth.js';
import { registerInternalRoutes } from './internal.js';
import { HttpCommercialClient, type CommercialClient } from './commercialClient.js';
import { HttpGatewayClient, type GatewayClient } from './gatewayClient.js';
import { HttpMetaSocialsvcClient, nullMetaSocialsvcClient } from './socialsvcClient.js';

const here = dirname(fileURLToPath(import.meta.url));
// Both dist/app.js and src/app.ts are two levels below metaserver → contracts.
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
}

export async function buildApp(opts: BuildAppOpts): Promise<FastifyInstance> {
  // bodyLimit set to 4MB (default is only 1MB): state-stream share upload compressed blob (capped at 2MB in service.ts).
  // Fastify's body-size gate must be ≥ the application-layer cap; otherwise a legitimate blob >1MB is rejected by
  // Fastify first with 413 (FST_ERR_CTP_BODY_TOO_LARGE) and the application's graceful 400 "replay too large" never fires.
  // Other endpoints have bodies well below this limit and are unaffected.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // Human-readable request/response log (for debugging, replacing pino JSON). One line per request on completion: method path status elapsed.
  // Health probes are excluded from logging (polling noise).
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return;
    const ms = Math.round(reply.elapsedTime ?? 0);
    log.info(`${req.method} ${req.url} -> ${reply.statusCode}`, { ms });
  });

  // Unified error envelope: validation failures and security-handler throws are all converted to ApiResp.
  // Must be set before glue route registration — Fastify binds the error handler into the route context at
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

  // Liveness probe (not in openapi.yml; glue does not take it over): reverse-proxy strips /api prefix and routes to /health.
  // Used for compose / load-balancer / C-3 deployment smoke tests.
  app.get('/health', async () => ({ ok: true }));

  const now = opts.now ?? (() => Date.now());
  const commercial =
    opts.commercial ?? new HttpCommercialClient(opts.commercialUrl ?? null, opts.internalKey);
  const gateway =
    opts.gateway ?? new HttpGatewayClient(opts.gatewayUrl ?? null, opts.internalKey);
  const socialsvc =
    opts.socialsvc ?? (opts.socialsvcUrl ? new HttpMetaSocialsvcClient(opts.socialsvcUrl, opts.internalKey) : nullMetaSocialsvcClient);
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
  });

  // Ad platform SSV callbacks (platform-initiated; bypass openapi glue; no player authentication).
  registerAdCallbackRoutes(app, { cols: opts.cols, commercial, now });

  // Internal routes (not visible to players; X-Internal-Key auth; bypass openapi glue): fetch ELO + end-of-match reporting + peer judge.
  registerInternalRoutes(app, {
    cols: opts.cols,
    internalKey: opts.internalKey,
    internalKeys: internalKeysFromEnv(),
    now,
    gateway,
    commercial,
  });

  await app.register(openapiGlue, {
    specification: SPEC_PATH,
    serviceHandlers: service,
    securityHandlers: makeSecurityHandlers(opts.jwt),
  });

  return app;
}
