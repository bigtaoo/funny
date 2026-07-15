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

/** In-process sliding-window rate limiter keyed by IP/key. */
export class SlidingRateLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const win = this.windows.get(key)?.filter((t) => now - t < this.windowMs) ?? [];
    if (win.length >= this.limit) {
      this.windows.set(key, win);
      return false;
    }
    win.push(now);
    this.windows.set(key, win);
    return true;
  }
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

  /** C4/C5-b: Check account-level ban / soft-delete flags; if flagged, reject the request and return true. */
  protected async rejectIfBanned(cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply): Promise<boolean> {
    const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1, deletedAt: 1 } });
    if (doc?.deletedAt) {
      void reply.code(410).send(err(ErrorCode.ACCOUNT_DELETED, 'account deleted'));
      return true;
    }
    if (doc?.flags?.banned) {
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
    await getOrCreateSave(cols, accountId, now());
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
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
