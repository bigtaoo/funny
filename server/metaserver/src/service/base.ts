// Shared foundation for the MetaService mixin chain (see ./index assembly in ../service.ts).
// MetaServiceBase holds `deps` + the genuinely cross-cutting helpers used by more than one domain
// mixin; each business domain lives in its own sibling file as an `XMixin(Base)` and is chained
// together into the final MetaService. Domain-local state/helpers stay in their own mixin file.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SaveData, FeatureFlagCache, RedisLike } from '@nw/shared';
import { ErrorCode, err, accrueRetentionTask, getActiveMatch } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import type { CommercialClient } from '../commercialClient.js';
import type { GatewayClient } from '../gatewayClient.js';
import type { AccountCache } from '../accountCache.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
  commercial: CommercialClient;
  /** Public WebSocket address of the gateway, sent down with auth/save responses; null = not sent (client falls back to its own config). */
  gatewayPublicUrl: string | null;
  /** Internal gateway client: PvE L1 replay spot-checks dispatch a third-party headless re-simulation via /gw/judge. If not configured, spot-checking is skipped (materials are delivered directly). */
  gateway: GatewayClient;
  /** Maximum auth attempts per IP within 15 minutes. 0 = disabled (for tests/CI). */
  authRateLimit: number;
  /** Feature flag cache (evaluated for the public /bootstrap endpoint; FEATURE_FLAGS_DESIGN §9.3). null = no flag source, bootstrap always returns an empty map. */
  flags: FeatureFlagCache | null;
  /** Deployment region (injected into flag evaluation context). */
  region: string | null;
  /** Loki push URL (POST /client/log forwards client logs; null = silently dropped). */
  lokiPushUrl: string | null;
  /** Internal socialsvc client (P2): friend/chat/mail routing proxy + atomic mail claim. null = routing is handled by metaserver itself. */
  socialsvc: import('../socialsvcClient.js').MetaSocialsvcClient | null;
  /** Active-match Redis client (login-reconnect-prompt): getSave() reads it to surface a "resume your match?" hint. null = feature disabled. */
  redis: RedisLike | null;
  /** Ban-status / publicId reverse-lookup cache (2026-07-27), shared with registerInternalRoutes so an
   *  admin ban/unban via the internal API is visible to this process's next rejectIfBanned check. */
  accountCache: AccountCache;
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type MetaBaseCtor = Constructor<MetaServiceBase>;

// ── Stamina system constants (A4) — shared by base.readStaminaSnapshot + PveMixin.deductStamina. ──
export const STAMINA_CAP = 120;
export const STAMINA_REGEN_MS = 6 * 60 * 1000; // 6 min per point

/** Retrieve the accountId written by the security handler (the handler guarantees the request is authenticated). */
export function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

/**
 * Client-declared request platform (X-NW-Platform header: 'ios' | 'android' | 'web' | 'wechat' | 'crazygames'),
 * forwarded verbatim to commercial as `clientPlatform` — determines which recharged-pool bucket (ADR-020,
 * server/commercial/src/spendChannel.ts) a wallet mutation may spend from / display alongside the free pool.
 * Absent/unrecognized header → undefined, which commercial defaults to the 'web' bucket (today's behavior for
 * every client that predates this header).
 */
export function clientPlatformOf(req: FastifyRequest): string | undefined {
  const h = req.headers['x-nw-platform'];
  return typeof h === 'string' && h ? h : undefined;
}

/** Sliding-window rate limiter keyed by an arbitrary string (IP, accountId, ...). Implementations may be
 *  in-process (single instance) or Redis-backed (precise across instances); see createRateLimiter below. */
export interface RateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

/**
 * In-process sliding-window rate limiter (fallback when Redis is unconfigured, and the sole implementation
 * before 2026-07-27). `allow` is async purely so callers don't need to branch on which implementation they
 * got back from createRateLimiter — the work itself is synchronous.
 *
 * Self-cleaning (2026-07-27 fix): the original version only ever filtered STALE TIMESTAMPS out of a key's
 * array on read — it never removed a key whose array had gone fully empty, so `windows` grew by one entry
 * per distinct key (IP for auth/anomaly limiters, accountId for the share limiter) ever seen, for the life
 * of the process — a real memory leak, independent of horizontal scaling (found during the 2026-07-27 audit
 * alongside the Redis migration, not the original reason Redis was flagged). `maybeSweep` piggybacks a full
 * cleanup pass onto normal traffic (at most once per windowMs) instead of a background timer — a timer would
 * leak across the many short-lived MetaService instances the test suite constructs per `buildApp()` call.
 */
export class SlidingRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private lastSweepAt = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [k, timestamps] of this.windows) {
      const fresh = timestamps.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.windows.delete(k);
      else if (fresh.length !== timestamps.length) this.windows.set(k, fresh);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async allow(key: string, now: number): Promise<boolean> {
    this.maybeSweep(now);
    const win = this.windows.get(key)?.filter((t) => now - t < this.windowMs) ?? [];
    if (win.length >= this.limit) {
      if (win.length > 0) this.windows.set(key, win);
      else this.windows.delete(key);
      return false;
    }
    win.push(now);
    this.windows.set(key, win);
    return true;
  }
}

/** Atomic sliding-window check via a single Lua script (prune-then-count-then-conditionally-add) — a plain
 *  ZCARD-then-ZADD would race two concurrent callers both passing the check before either records itself. */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local ttlSec = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  redis.call('EXPIRE', key, ttlSec)
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttlSec)
return 1
`;

/**
 * Redis-backed sliding-window rate limiter (2026-07-27): precise across instances (the original in-process
 * limiter's own doc comment already called this out as the thing Redis would fix — "in-process approximation
 * ... precise global limiting requires Redis"), unlike SlidingRateLimiter above which only ever sees traffic
 * that landed on the same process. One sorted set per key (`nw:ratelimit:{ns}:{key}`, score=timestamp);
 * TTL is a storage safety net only, refreshed on every call — the pass/fail decision is always the
 * ZREMRANGEBYSCORE prune against the caller-supplied `now`, never Redis's own clock.
 */
export class RedisSlidingRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly ns: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async allow(key: string, now: number): Promise<boolean> {
    const ttlSec = Math.ceil(this.windowMs / 1000) + 5;
    const member = `${now}-${Math.random()}`; // uniqueness only (avoids same-millisecond ZADD collisions), not a security token
    const res = await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      `nw:ratelimit:${this.ns}:${key}`,
      now,
      this.windowMs,
      this.limit,
      member,
      ttlSec,
    );
    return res === 1;
  }
}

/** Picks the Redis-backed limiter when configured, else the self-cleaning in-process fallback — same
 *  redis-or-fallback shape as shared/src/dailyCounter.ts, but here the fallback was always correct for a
 *  single instance (this is a genuine precision upgrade under future scale-out, not a correctness fix). */
export function createRateLimiter(redis: RedisLike | null, ns: string, limit: number, windowMs: number): RateLimiter {
  return redis ? new RedisSlidingRateLimiter(redis, ns, limit, windowMs) : new SlidingRateLimiter(limit, windowMs);
}

export class MetaServiceBase {
  protected readonly deps: ServiceDeps;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    this.deps = args[0] as ServiceDeps;
  }

  /** Public WebSocket address of the gateway (only sent if configured). Clients use this to connect to the control plane without hardcoding the gateway address. */
  protected get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  /**
   * Login-reconnect-prompt: surfaces the cached "resume this match?" ticket for an account, if any
   * (written by matchsvc at match start, cleared by /internal/match/report at match end). Absent when
   * Redis is unconfigured or there is no active match for this account.
   */
  protected async activeMatchFieldFor(accountId: string): Promise<{ activeMatch?: import('@nw/shared').ActiveMatchRecord }> {
    const record = await getActiveMatch(this.deps.redis, accountId);
    return record ? { activeMatch: record } : {};
  }

  /** Economy endpoints are unavailable when commercial is not configured (503). */
  protected ensureCommercial(reply: FastifyReply): boolean {
    if (this.deps.commercial.available) return true;
    reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    return false;
  }

  /** C4/C5-b: Check account-level ban / soft-delete flags; if flagged, reject the request and return true.
   *  Cached (2026-07-27, accountCache.ts) — a cache hit skips the Mongo round trip entirely. */
  protected async rejectIfBanned(cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply): Promise<boolean> {
    const status = await this.deps.accountCache.getBanStatus(cols, accountId);
    if (status.deletedAt) {
      void reply.code(410).send(err(ErrorCode.ACCOUNT_DELETED, 'account deleted'));
      return true;
    }
    if (status.banned) {
      void reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
      return true;
    }
    return false;
  }

  /** Optimistic-lock read-modify-write on the save document (rev guard + retry, same as applyPvp). transform returns the new save or a business error code string. */
  protected async mutateSave(
    accountId: string,
    transform: (s: SaveData) => SaveData | string,
  ): Promise<{ save: SaveData } | { error: string }> {
    const { cols, now } = this.deps;
    // Try the plain read first — by the time any mutateSave call happens the doc has almost always already
    // been created (GET /save's own getOrCreateSave runs first in practice), so this is the hot path.
    // getOrCreateSave is only reached on a genuine first-ever touch (2026-07-27 audit: this used to run
    // unconditionally, then the loop below immediately re-read the same doc it had just returned/created —
    // a guaranteed redundant read on every single call).
    let doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await getOrCreateSave(cols, accountId, now());
      doc = await cols.saves.findOne({ _id: accountId });
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!doc) return { error: 'NOT_FOUND' };
      const out = transform(doc.save);
      if (typeof out === 'string') return { error: out };
      const next: SaveData = { ...out, rev: doc.save.rev + 1, updatedAt: now() };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
        { returnDocument: 'after' },
      );
      if (res) return { save: res.save };
      // rev conflict (concurrent client PUT of equipped/flags or concurrent pve write) → re-read and retry
      doc = await cols.saves.findOne({ _id: accountId });
    }
    return { error: 'REV_CONFLICT' };
  }

  /** Read current stamina (including natural regen calculation), used to populate the SaveData.stamina snapshot in responses. */
  protected async readStaminaSnapshot(
    accountId: string,
    now: number,
  ): Promise<{ current: number; regenAt: number }> {
    const { cols } = this.deps;
    const CAP = STAMINA_CAP;
    const REGEN_MS = STAMINA_REGEN_MS;
    const doc = await cols.pveStamina.findOne({ _id: accountId });
    if (!doc) return { current: CAP, regenAt: 0 };
    let { current, regenAt } = doc;
    if (current < CAP && regenAt > 0 && now >= regenAt) {
      const ticks = Math.floor((now - regenAt) / REGEN_MS) + 1;
      current = Math.min(CAP, current + ticks);
      regenAt = current >= CAP ? 0 : regenAt + ticks * REGEN_MS;
    }
    return { current, regenAt };
  }

  /** B5: Idempotently record a daily task event (no-op if already recorded today, no error thrown). Callers fire-and-forget and ignore failures. */
  protected async bumpRetentionTask(accountId: string, taskId: import('@nw/shared').DailyTaskId): Promise<void> {
    const tsMs = this.deps.now();
    await this.mutateSave(accountId, (s) => {
      const next = accrueRetentionTask(s.retention, taskId, tsMs);
      if (next === s.retention) return s; // already recorded today, no-op
      return { ...s, retention: next };
    }).catch(() => {/* retention recording failure does not affect the main flow */});
  }
}
