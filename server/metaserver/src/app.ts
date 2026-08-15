// Fastify application assembly (separated from process bootstrap for testability/inject).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Collections, JwtConfig, FeatureFlagCache, RedisLike, SaveData, WordlistCache } from '@nw/shared';
import { createLogger, internalKeysFromEnv } from '@nw/shared';
import { MetaService } from './service.js';
import { assembleEquipmentInv } from './equipment.js';
import { assembleCardInv } from './cards.js';
import { assembleSkinCounts } from './skin.js';
import { sanitizeEquippedAvatar } from './save.js';
import { registerAdCallbackRoutes } from './ads.js';
import { registerPaddleRoutes } from './paddle.js';

const log = createLogger('meta');
import { makeSecurityHandlers } from './auth.js';
import { extractBearer, verifyToken } from '@nw/shared';
import { registerInternalRoutes } from './internal.js';
import { AccountCache } from './accountCache.js';
import { HttpCommercialClient, type CommercialClient } from './commercialClient.js';
import { HttpGatewayClient, type GatewayClient } from './gatewayClient.js';
import { HttpMetaSocialsvcClient, nullMetaSocialsvcClient } from './socialsvcClient.js';
import { registerRoutes } from './generated/routes.gen.js';

const here = dirname(fileURLToPath(import.meta.url));
// SPEC_PATH is exported for the openapi-response-schema.test.ts static schema guard.
// Routes are no longer loaded from this path at runtime (ADR-023: build-time codegen).
export const SPEC_PATH = resolve(here, '../../contracts/openapi.yml');

// Request-body fields that must never reach a log line verbatim, matched case-insensitively against
// top-level keys (covers /auth/* password/newPassword, /*/buy receipt, any future token/secret field).
const SENSITIVE_BODY_KEYS = new Set(['password', 'newpassword', 'oldpassword', 'receipt', 'token', 'secret']);
const LOG_BODY_MAX_BYTES = 4000;

/**
 * Request body for an error/warn access-log line (2026-07-28): redacts known-sensitive fields and caps
 * the size before it's attached to a log entry — bodyLimit is 4MB (state-stream replay uploads), so an
 * unredacted/uncapped body could both leak credentials and blow up the log line. Returns undefined for
 * a missing/non-object body (e.g. a request that failed to parse at all) so the log field is omitted
 * rather than showing `body=null`.
 */
function redactedBodyForLog(body: unknown): unknown {
  if (body === null || body === undefined || typeof body !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SENSITIVE_BODY_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  let json: string;
  try {
    json = JSON.stringify(out);
  } catch {
    return '[unserializable body]';
  }
  return json.length > LOG_BODY_MAX_BYTES
    ? `[body omitted: ${json.length}B exceeds ${LOG_BODY_MAX_BYTES}B log cap]`
    : out;
}

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
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2). null/omitted = built-in REGION_WORDLISTS only. */
  wordlists?: WordlistCache | null;
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
  // trustProxy: 1 (2026-08-03 fix) — metaserver always sits behind exactly one reverse proxy (nginx in
  // dev/local-compose, Caddy in prod; both append the real client address as the last X-Forwarded-For
  // entry, see client/nginx.conf's `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`).
  // Without this, req.ip resolves to the proxy's own socket address for every request, collapsing
  // service/telemetry.ts's per-IP anomaly-flood rate limiter into one counter shared by the whole player
  // base. `1` (not `true`) trusts exactly one hop — the immediate proxy — rather than blindly trusting an
  // attacker-supplied X-Forwarded-For chain of arbitrary length.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024, routerOptions: { maxParamLength: 200 }, trustProxy: 1 });
  await app.register(cors, { origin: true });

  // Human-readable request/response log (for debugging, replacing pino JSON). One line per request on completion: method path status elapsed.
  // Health probes are excluded from logging (polling noise).
  // Level escalates with the status code (2026-07-28): 4xx → warn, 5xx → error, both carry the
  // (redacted, size-capped) request body — previously every response logged at `info` with no body at
  // all, so diagnosing a specific failed request (e.g. "which card id did this 404 CARD_NOT_FOUND
  // actually send?") required the reporter's own DevTools Network tab; the access log alone had nothing.
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return;
    const ms = Math.round(reply.elapsedTime ?? 0);
    const msg = `${req.method} ${req.url} -> ${reply.statusCode}`;
    if (reply.statusCode >= 500) log.error(msg, { ms, body: redactedBodyForLog(req.body) });
    else if (reply.statusCode >= 400) log.warn(msg, { ms, body: redactedBodyForLog(req.body) });
    else log.info(msg, { ms });
  });

  // Equipment/card storage split backstop (2026-07-26 equipmentInv, 2026-07-27 cardInv — see
  // equipment.ts/cards.ts headers): both instance types live in their own collections now, not embedded
  // in SaveData. ~30 handlers across auth/save/pve/economy/liveops/cards/ladderSeason return a
  // `save: SaveData` nested under `ok()`'s `{data:{save}}` envelope; rather than trust every one of
  // those call sites to remember an explicit join, this single hook is the centralized guarantee that
  // no OTHER response can ever accidentally ship without the full maps.
  // equipment.ts's own mutation endpoints (craft/enhance/salvage/reforge/equip) are the deliberate
  // exception (phase 2, EQUIPMENT_DESIGN §3.3): they set `equipmentInv: null` (via `leanSave`), not
  // `undefined` — this hook only backfills on `undefined` ("forgot to populate"), so `null` ("explicitly
  // omitted, caller already knows what changed") passes through untouched, and those endpoints skip the
  // `equipmentInstances.find({accountId})` entirely instead of paying for it just to throw it away.
  // cardInv got the same `null` opt-out on 2026-07-28, starting with gachaDraw (the highest-frequency
  // card-granting endpoint — see its `cardGrants` response field / shared/src/types.ts's cardInv doc
  // comment); other card-touching handlers still return `undefined` and get the full join here.
  app.addHook('preSerialization', async (_req, _reply, payload) => {
    const p = payload as { save?: SaveData; data?: { save?: SaveData } } | null;
    const save = p?.data?.save ?? p?.save;
    // opts.cols.equipmentInstances/cardInstances may be absent in tests that build their own minimal fake
    // Collections (many unit-style suites drive buildApp() directly with a hand-rolled `{saves, accounts}`
    // stub, not the full interface) — skip gracefully rather than throwing, same defensive style as the
    // rest of this codebase's optional-dependency checks (e.g. `commercial.available`).
    if (save && typeof save === 'object' && save.accountId) {
      // Avatar-category retirement migration shim (2026-08-15, save.ts's sanitizeEquippedAvatar doc
      // comment) — read-time-only, no DB write-back, same convention as the backfills below.
      const sanitized = sanitizeEquippedAvatar(save);
      if (sanitized !== save) save.equipped = sanitized.equipped;
      // `undefined` = "forgot to populate" (fully migrated accounts store no embedded field at all,
      // so this is the normal case) → full backfill from the split collection. `null` = "explicitly
      // opted out" (lean response, see leanSave doc comment) → left untouched. A present-but-non-null
      // value used to be treated as "already complete" and passed through as-is, but that's also the
      // shape of an account still mid-migration (CC-16 incident, 2026-07-29): some instances already
      // live only in the split collection (created after the app-code cutover), while the embedded
      // field still holds whatever hadn't been migrated yet — passing it through as-is silently
      // dropped every instance that already existed only in the split collection. Merge instead,
      // with the split collection's own reconstruction (the source of truth for anything already
      // moved) taking precedence over the possibly-stale embedded copy of the same id.
      if (opts.cols.equipmentInstances && save.equipmentInv !== null) {
        const fromInstances = await assembleEquipmentInv(opts.cols, save.accountId, save);
        save.equipmentInv = save.equipmentInv === undefined ? fromInstances : { ...save.equipmentInv, ...fromInstances };
      }
      if (opts.cols.cardInstances && save.cardInv !== null) {
        const fromInstances = await assembleCardInv(opts.cols, save.accountId, save);
        save.cardInv = save.cardInv === undefined ? fromInstances : { ...save.cardInv, ...fromInstances };
      }
      // Skin instance counts (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): same backfill-on-`undefined`,
      // skip-on-`null` convention as equipmentInv/cardInv above. Unlike those two, skinCounts has no
      // "mid-migration merge" concern (it's a brand-new field, nothing embedded to reconcile against) —
      // a plain assign is enough.
      if (opts.cols.skinInstances && save.skinCounts !== null) {
        save.skinCounts = await assembleSkinCounts(opts.cols, save.accountId, save);
      }
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
    // Body included (2026-07-28, redacted/size-capped — see redactedBodyForLog): this is the thrown-
    // exception path (schema validation, security-handler throws), a different code path from the
    // onResponse hook above, which only sees normally-returned (non-thrown) 4xx/5xx responses.
    if (status >= 500) log.error(`${req.method} ${req.url} ${status} ${code}`, { err: error.stack ?? error.message, body: redactedBodyForLog(req.body) });
    else log.warn(`${req.method} ${req.url} ${status} ${code}`, { message: error.message, body: redactedBodyForLog(req.body) });
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
  // Shared with registerInternalRoutes below so an admin ban/unban (internal API) invalidates the same
  // cache rejectIfBanned (public API) reads — one instance per buildApp call, see accountCache.ts.
  const accountCache = new AccountCache();
  const service = new MetaService({
    cols: opts.cols,
    jwt: opts.jwt,
    now,
    commercial,
    gatewayPublicUrl: opts.gatewayPublicUrl ?? null,
    gateway,
    authRateLimit: opts.authRateLimit ?? 20,
    flags: opts.flags ?? null,
    wordlists: opts.wordlists ?? null,
    region: opts.region ?? null,
    lokiPushUrl: opts.lokiPushUrl ?? null,
    socialsvc,
    redis,
    accountCache,
  });

  // Ad platform SSV callbacks (platform-initiated; no player authentication).
  registerAdCallbackRoutes(app, { cols: opts.cols, commercial, now, redis });

  // Paddle Billing routes: player checkout session + Paddle webhook.
  registerPaddleRoutes(app, {
    cols: opts.cols,
    commercial,
    now,
    socialsvc,
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
    accountCache,
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
