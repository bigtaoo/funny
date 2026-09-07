// F3 public bootstrap + feature-flag evaluation + targeted client log / full-coverage anomaly
// collection → Loki (FEATURE_FLAGS_DESIGN §9). Also the analytics stubs: those operations exist in
// openapi.yml so MetaService satisfies MetaHandlers, but analyticsvc is a separate process → 501 here.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FlagContext, FlagPlatform } from '@nw/shared';
import { ok, FLAG_KEYS, flagDefault, extractBearer, verifyToken, FLAG_PLATFORMS } from '@nw/shared';
import { ErrorCode, err } from '@nw/shared';
import { buildLokiPayload, buildAnomalyLokiPayload, pushToLoki, type ClientLogEntry, type ClientAnomalyEvent, type ClientAnomalySession } from '../clientLog.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { clientPlatformOf, createRateLimiter, type RateLimiter, type MetaCore } from './base.js';

/** Clamp a client-supplied number into a sane range (telemetry is unauthenticated — see clientAnomaly). */
function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

type TelemetryHandlers = Pick<
  MetaHandlers,
  'bootstrap' | 'clientLog' | 'clientAnomaly' | 'getAnalyticsConfig' | 'postAnalyticsEvents'
>;

/**
 * accountId -> appAccountToken, process-local (see TelemetryService.appleAccountToken). Cleared
 * wholesale on overflow rather than evicting one entry: this is a cache of immutable values whose
 * only cost on a miss is one internal call, so LRU bookkeeping would buy nothing.
 */
const APPLE_ACCOUNT_TOKENS = new Map<string, string>();
const APPLE_ACCOUNT_TOKEN_CACHE_MAX = 10_000;

/** 4 client log level flags (ordered by verbosity; for documentation/guard use only). */
const CLIENT_LOG_KEYS = FLAG_KEYS.filter((k) => k.startsWith('client_log_'));

export class TelemetryService implements TelemetryHandlers {
  /** Rate limit for "full coverage" anomaly event uploads, keyed by IP: at most 30 POST /client/anomaly
   *  requests per IP per 60s (guards against Loki flooding). Redis-backed when configured (2026-07-27,
   *  precise across instances); in-process fallback otherwise — see createRateLimiter in base.ts. */
  private readonly anomalyRate: RateLimiter;

  constructor(private readonly core: MetaCore) {
    // Built in the constructor body, not as a field initializer — see save.ts's constructor comment for
    // why (target: ES2022 real class-fields semantics would read `this.core` as undefined here).
    this.anomalyRate = createRateLimiter(this.core.deps.redis, 'anomaly', 30, 60 * 1000);
  }

    /** Parse the flag evaluation context from the request: platform/publicId from query params + optional accountId from token. */
    private flagCtx(req: FastifyRequest): FlagContext {
      const q = (req.query ?? {}) as { platform?: unknown; publicId?: unknown };
      const ctx: FlagContext = {};
      if (typeof q.publicId === 'string' && q.publicId) ctx.publicId = q.publicId;
      if (typeof q.platform === 'string' && (FLAG_PLATFORMS as readonly string[]).includes(q.platform)) {
        ctx.platform = q.platform as FlagPlatform;
      }
      if (this.core.deps.region) ctx.region = this.core.deps.region;
      // Login state is optional: if a token is provided, parse the accountId for more precise evaluation; missing/invalid token is silently ignored (bootstrap is callable anonymously).
      const token = extractBearer(req.headers['authorization']);
      if (token) {
        try { ctx.accountId = verifyToken(token, this.core.deps.jwt); } catch { /* anonymous */ }
      }
      return ctx;
    }

    /**
     * Public bootstrap (§9.3): callable anonymously (a token injects accountId for more precise evaluation). Evaluates all flags individually,
     * **only returning flags that differ from their default** — the vast majority of players receive an empty map → zero overhead. Rules/allowlists are never sent down; only boolean results.
     * No flag source (admin not configured) → always returns an empty map.
     */
    async bootstrap(req: FastifyRequest) {
      const flags: Record<string, boolean> = {};
      const cache = this.core.deps.flags;
      const ctx = this.flagCtx(req);
      if (cache) {
        for (const key of FLAG_KEYS) {
          const resolved = cache.isOn(key, ctx);
          if (resolved !== flagDefault(key)) flags[key] = resolved;
        }
      }
      // Paddle.js client token (COMMERCIAL_DESIGN §IAP client): the web client needs this to open
      // the checkout overlay. It is a public, client-safe token (ptok_/live_/test_); only sent when
      // configured, so non-web / unconfigured deployments receive nothing extra.
      const paddleClientToken = process.env.NW_PADDLE_CLIENT_TOKEN;
      const appleAccountToken = await this.appleAccountToken(req, ctx.accountId);
      return ok({
        flags,
        ...(paddleClientToken ? { paddleClientToken } : {}),
        ...(appleAccountToken ? { appleAccountToken } : {}),
      });
    }

    /**
     * The `appAccountToken` an iOS client attaches to its next StoreKit 2 purchase (IOS_RELEASE.md
     * §6), or undefined for every other caller.
     *
     * Delivered here rather than through an endpoint of its own because the token must be in hand
     * BEFORE a purchase starts — and this is the one call the client already makes early, so it costs
     * no extra round trip client-side (the same reason paddleClientToken rides along above).
     *
     * Only for a logged-in iOS caller: an anonymous session has no account to attach, and no other
     * platform can use the value. Failures are swallowed — a bootstrap that cannot reach commercial
     * must still deliver feature flags, and a purchase with no token still resolves through
     * appleTransactionLinks (server/commercial/src/service/appleAccount.ts).
     *
     * "iOS" is read from the X-NW-Platform header (ADR-020), not from the `platform` query param the
     * flag context uses: the header is set by the shell itself for exactly this purpose, while the
     * query param carries the build target and knows nothing about which shell is running it.
     */
    private async appleAccountToken(
      req: FastifyRequest,
      accountId: string | undefined,
    ): Promise<string | undefined> {
      if (!accountId || clientPlatformOf(req) !== 'ios') return undefined;
      const { commercial } = this.core.deps;
      if (!commercial?.available) return undefined;
      const cached = APPLE_ACCOUNT_TOKENS.get(accountId);
      if (cached) return cached;
      try {
        const r = await commercial.appleAccountToken({ accountId });
        if (!r.ok) return undefined;
        // Bounded, and safe to cache indefinitely: the token is allocated once per account and never
        // changes, so a hit can never be stale. Without it, the client's 120-second bootstrap poll
        // (client/src/net/featureFlags.ts) would put a commercial round trip on every tick.
        if (APPLE_ACCOUNT_TOKENS.size >= APPLE_ACCOUNT_TOKEN_CACHE_MAX) APPLE_ACCOUNT_TOKENS.clear();
        APPLE_ACCOUNT_TOKENS.set(accountId, r.token);
        return r.token;
      } catch {
        return undefined;
      }
    }

    /** Whether this publicId is currently named in the allowPublicIds of any client_log_* flag (prevents arbitrary clients from flooding Loki with logs). */
    private isClientLogTargeted(publicId: string): boolean {
      const cache = this.core.deps.flags;
      if (!cache) return false;
      for (const key of CLIENT_LOG_KEYS) {
        if (cache.rawDoc(key)?.rollout?.allowPublicIds?.includes(publicId)) return true;
      }
      return false;
    }

    /**
     * Client log upload → Loki (§9.4). **Always returns 200** (never affects players). Abuse prevention: only forwards when this publicId is currently targeted
     * by a client_log_* flag; otherwise silently discarded (non-targeted clients receive an empty map from bootstrap and would not call this endpoint in the first place — this is a backstop).
     * Silently discarded if Loki is unreachable.
     */
    async clientLog(req: FastifyRequest, reply: FastifyReply) {
      const body = (req.body ?? {}) as { publicId?: unknown; platform?: unknown; logs?: unknown };
      const publicId = typeof body.publicId === 'string' ? body.publicId : '';
      if (!publicId || !Array.isArray(body.logs)) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing publicId / logs'));
      }
      // Not targeted → accept but discard (no 4xx to avoid leaking "who is being collected").
      if (!this.isClientLogTargeted(publicId)) return ok({ accepted: 0 });

      const platform = typeof body.platform === 'string' ? body.platform : undefined;
      // Safety cap: at most 1000 entries, each msg truncated to 2000 characters (Fastify bodyLimit already blocks oversized bodies).
      const entries: ClientLogEntry[] = (body.logs as unknown[]).slice(0, 1000).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const o = raw as Record<string, unknown>;
        const msg = typeof o.msg === 'string' ? o.msg.slice(0, 2000) : '';
        if (!msg) return [];
        const e: ClientLogEntry = {
          level: typeof o.level === 'string' ? o.level : 'info',
          msg,
          ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : this.core.deps.now(),
        };
        if (typeof o.tag === 'string' && o.tag) e.tag = o.tag.slice(0, 64);
        return [e];
      });

      const payload = buildLokiPayload(publicId, entries, platform, () =>
        (BigInt(this.core.deps.now()) * 1_000_000n).toString(),
      );
      if (payload) {
        // fire-and-forget: does not block the response; failures are silent (attach onError only when needed during debugging).
        void pushToLoki(this.core.deps.lokiPushUrl, payload);
      }
      return ok({ accepted: entries.length });
    }

    /**
     * "Full coverage" client anomaly event upload → Loki (complements targeted collection, **not subject to allowPublicIds constraints**:
     * any client's memory overrun / sustained CPU saturation / WebGL context loss / freeze / uncaught exception / last crash is reported directly, enabling field anomaly diagnosis across the entire player base).
     * Abuse prevention: rate-limited to 30 requests per IP per 60s (over-limit silently discarded, still returns 200 — never affects players); at most 200 events, all fields truncated.
     * **Always returns 200** (Loki unreachable / rate-limited / invalid input also does not affect players).
     */
    async clientAnomaly(req: FastifyRequest, reply: FastifyReply) {
      const body = (req.body ?? {}) as {
        publicId?: unknown; platform?: unknown; buildVersion?: unknown; events?: unknown;
        device?: unknown; dpr?: unknown; mem?: unknown;
      };
      if (!Array.isArray(body.events)) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing events'));
      }
      // IP rate limit: over-limit is silently discarded (no 4xx, to prevent clients from retrying based on the response / probing the rate limit threshold).
      if (!(await this.anomalyRate.allow(req.ip ?? 'unknown', this.core.deps.now()))) return ok({ accepted: 0 });

      // publicId is optional (anomalies can occur before login); defaults to 'anon' and is still reported to enable statistics on anonymous anomalies.
      // Length-capped (2026-08-03 fix, matching msg/type/buildVersion below): this endpoint is
      // deliberately exempt from isClientLogTargeted's allowPublicIds gate (anomalies must be reportable
      // before login/allowlisting), so without a cap here a client could submit an oversized publicId
      // that buildAnomalyLine then embeds verbatim into every one of up to 200 Loki lines per request.
      const publicId = typeof body.publicId === 'string' && body.publicId ? body.publicId.slice(0, 64) : 'anon';
      // Session envelope. `device`/`dpr`/`mem` are capped/clamped here for the same reason publicId is:
      // this endpoint is exempt from the allowPublicIds gate, so every field lands inline on up to 200
      // Loki lines per request. buildAnomalyLine additionally allowlists `device` by value.
      const session: ClientAnomalySession = {
        platform: typeof body.platform === 'string' ? body.platform.slice(0, 32) : undefined,
        buildVersion: typeof body.buildVersion === 'string' && body.buildVersion ? body.buildVersion.slice(0, 32) : undefined,
        device: typeof body.device === 'string' ? body.device.slice(0, 16) : undefined,
        dpr: typeof body.dpr === 'number' && Number.isFinite(body.dpr) ? clampNum(body.dpr, 0, 16) : undefined,
        mem: typeof body.mem === 'number' && Number.isFinite(body.mem) ? clampNum(body.mem, 0, 1024) : undefined,
      };
      const events: ClientAnomalyEvent[] = (body.events as unknown[]).slice(0, 200).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const o = raw as Record<string, unknown>;
        const msg = typeof o.msg === 'string' ? o.msg.slice(0, 500) : '';
        const type = typeof o.type === 'string' ? o.type.slice(0, 32) : '';
        if (!msg || !type) return [];
        // Defense-in-depth mirror of the client-side dev-build crash gate (client net/anomaly.ts initCrashSentinel):
        // drop crash events from unbaked dev builds (buildVersion '0.0.0') so a client that missed the fix can't
        // refill Loki with false "unclean exit" crashes from dev hot-reloads. Other anomaly types and real-build
        // crashes (including crashes with no buildVersion reported) pass through untouched.
        if (type === 'crash' && session.buildVersion === '0.0.0') return [];
        const e: ClientAnomalyEvent = {
          type,
          msg,
          ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : this.core.deps.now(),
        };
        if (typeof o.detail === 'string' && o.detail) e.detail = o.detail.slice(0, 1000);
        // Moment-level device context; buildAnomalyLine allowlists `orient` by value.
        if (typeof o.orient === 'string' && o.orient) e.orient = o.orient.slice(0, 16);
        if (typeof o.vp === 'string' && o.vp) e.vp = o.vp.slice(0, 16);
        if (typeof o.sinceRot === 'number' && Number.isFinite(o.sinceRot)) {
          // Clamped rather than dropped: a bogus value is still evidence the client rotated, and the
          // ceiling (24h) keeps a garbage number from reading as a plausible duration.
          e.sinceRot = clampNum(o.sinceRot, 0, 86_400_000);
        }
        return [e];
      });

      const payload = buildAnomalyLokiPayload(publicId, events, session, () =>
        (BigInt(this.core.deps.now()) * 1_000_000n).toString(),
      );
      if (payload) void pushToLoki(this.core.deps.lokiPushUrl, payload);
      return ok({ accepted: events.length });
    }

    // Analytics endpoints in openapi.yml are stubs here — analyticsvc is a separate process.
    // Defined so MetaService satisfies MetaHandlers (ADR-023 compile-time check); always returns 501.
    async getAnalyticsConfig(_req: FastifyRequest, reply: FastifyReply) {
      return reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'analytics config not served by metaserver' } });
    }

    async postAnalyticsEvents(_req: FastifyRequest, reply: FastifyReply) {
      return reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'analytics events not served by metaserver' } });
    }
}
