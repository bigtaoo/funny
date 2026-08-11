// Shared foundation for the MetaService domain classes (see ../service.ts assembly).
// MetaCore holds `deps` + the genuinely cross-cutting helpers used by more than one domain; each
// business domain lives in its own sibling file as an independent class taking `(core: MetaCore)` in
// its constructor (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级" 形态②/
//独立类+组合). The methods below were `protected` on the old MetaServiceBase — that visibility was
// exactly why pve.ts/liveops.ts/economy.ts/auth.ts (2026-08-10) couldn't use independent-class-
// composition and had to fall back to a `.bind(this)`-into-a-plain-ctx-object workaround instead: a
// `protected` member can't be assigned to any wider/interface-shaped type from outside the class's own
// inheritance chain, no matter where the read happens. Now that MetaCore is a genuine sibling-holding
// pattern (not an inheritance chain), these are plain PUBLIC methods — `this.core.mutateSave(...)` etc.
// just work, no bind/ctx needed for the 5 domains converted directly in this batch (save/inventory/
// progression/social/telemetry). The 4 domains that already built their own ctx-bind + free-function
// split (auth/pve/economy/liveops) keep that shape unchanged for this batch — their ctx objects now bind
// to `this.core` instead of the inherited `this` — removing that scaffolding entirely (now that the
// protected-member wall it was built to route around no longer exists) is a follow-up simplification,
// not required for this batch's goal (mixin chain → composition, zero behavior change).
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SaveData, FeatureFlagCache, RedisLike, WordlistCache } from '@nw/shared';
import { ErrorCode, err, accrueRetentionTask, getActiveMatch } from '@nw/shared';
// Rate limiter (RateLimiter/SlidingRateLimiter/RedisSlidingRateLimiter/createRateLimiter) moved to
// @nw/shared 2026-07-29 (SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4: gateway needed the same in-process/
// Redis-backed pair for per-connection control-message limiting) — re-exported here so existing call
// sites (auth.ts/save.ts/telemetry.ts import from './base.js') don't need to change.
export { type RateLimiter, SlidingRateLimiter, RedisSlidingRateLimiter, createRateLimiter } from '@nw/shared';
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
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2). null = built-in REGION_WORDLISTS only, no ops-managed overlay. */
  wordlists: WordlistCache | null;
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

export class MetaCore {
  readonly deps: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
  }

  /** Public WebSocket address of the gateway (only sent if configured). Clients use this to connect to the control plane without hardcoding the gateway address. */
  get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  /**
   * Login-reconnect-prompt: surfaces the cached "resume this match?" ticket for an account, if any
   * (written by matchsvc at match start, cleared by /internal/match/report at match end). Absent when
   * Redis is unconfigured or there is no active match for this account.
   */
  async activeMatchFieldFor(accountId: string): Promise<{ activeMatch?: import('@nw/shared').ActiveMatchRecord }> {
    const record = await getActiveMatch(this.deps.redis, accountId);
    return record ? { activeMatch: record } : {};
  }

  /** Economy endpoints are unavailable when commercial is not configured (503). */
  ensureCommercial(reply: FastifyReply): boolean {
    if (this.deps.commercial.available) return true;
    reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    return false;
  }

  /** C4/C5-b/CM6: Check account-level ban / temp-ban / soft-delete flags; if flagged, reject the request and return true.
   *  Cached (2026-07-27, accountCache.ts) — a cache hit skips the Mongo round trip entirely. */
  async rejectIfBanned(cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply): Promise<boolean> {
    const status = await this.deps.accountCache.getBanStatus(cols, accountId);
    if (status.deletedAt) {
      void reply.code(410).send(err(ErrorCode.ACCOUNT_DELETED, 'account deleted'));
      return true;
    }
    if (status.banned) {
      void reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
      return true;
    }
    // CONTENT_MODERATION_DESIGN.md CM6: a temp ban auto-expires — no unban action needed once bannedUntil passes.
    if (status.bannedUntil && status.bannedUntil > this.deps.now()) {
      void reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account temporarily banned'));
      return true;
    }
    return false;
  }

  /** Optimistic-lock read-modify-write on the save document (rev guard + retry, same as applyPvp). transform returns the new save or a business error code string. */
  async mutateSave(
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
  async readStaminaSnapshot(
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
  async bumpRetentionTask(accountId: string, taskId: import('@nw/shared').DailyTaskId): Promise<void> {
    const tsMs = this.deps.now();
    await this.mutateSave(accountId, (s) => {
      const next = accrueRetentionTask(s.retention, taskId, tsMs);
      if (next === s.retention) return s; // already recorded today, no-op
      return { ...s, retention: next };
    }).catch(() => {/* retention recording failure does not affect the main flow */});
  }
}
