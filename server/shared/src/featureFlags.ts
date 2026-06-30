// Feature Flags core: type-safe allowlist + default fallback + unified pure evaluation function + process-level cache.
// Design reference: design/game/FEATURE_FLAGS_DESIGN.md.
//
// Single source of truth: the evaluation logic (evaluateFlag) is shared between frontend and backend —
//   • metaserver resolves flags to a boolean map for the client at /bootstrap (raw rules/allowlists are never sent down);
//   • backends without DB access (gateway/matchsvc/worldsvc…) poll admin for raw rules and call evaluateFlag locally.
// Flags are fully decoupled from SaveData.flags (player state) / AccountDoc.flags (account state) — these are operator-controlled global switches.

// ── Allowlist (registered in code; append new flags here) ───────────────────
/**
 * Registry of all feature flags. The key is the flag identifier; both frontend and backend reference it via {@link FlagKey} — a typo will cause a compile-time error.
 * - `default`: Fallback value when the flag is not found in the database or admin is unreachable. **Required.**
 * - `side`: `client | server | both` — documentation/validation hint indicating which side reads this flag.
 */
export const FEATURE_FLAGS = {
  /**
   * Bot fallback for ranked matchmaking: when enabled, if a player waits longer than the threshold (default 30s)
   * without finding a real opponent, the match is downgraded to a local AI match on the client. When disabled,
   * the player always waits for a real opponent.
   */
  match_bot_fallback: { default: false, desc: 'Matchmaking timeout fallback to AI', side: 'server' },

  // ── Client log targeting (FEATURE_FLAGS_DESIGN §9) ──────────────────────────
  // Log levels are encoded via multiple flags (each flag is only true/false): operators put target player
  // publicIds into the allowPublicIds of whichever flag corresponds to the desired level.
  // The client picks the most verbose enabled flag as the upload threshold (debug>info>warn>error)
  // and uploads logs at that level and above. No match = no reporting.
  // All defaults are false → the vast majority of players receive an empty map at bootstrap and never report.
  client_log_error: { default: false, desc: 'Client log upload - error', side: 'client' },
  client_log_warn: { default: false, desc: 'Client log upload - warn', side: 'client' },
  client_log_info: { default: false, desc: 'Client log upload - info', side: 'client' },
  client_log_debug: { default: false, desc: 'Client log upload - debug', side: 'client' },
} as const;

export type FlagKey = keyof typeof FEATURE_FLAGS;

/** All allowlisted keys (runtime enumeration: used by admin listings and full metaserver evaluation). */
export const FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FlagKey[];

export function isFlagKey(v: unknown): v is FlagKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, v);
}

/** Default value for a flag (fallback when the doc does not exist). */
export function flagDefault(key: FlagKey): boolean {
  return FEATURE_FLAGS[key].default;
}

// ── Platform / rule documents ────────────────────────────────────────────────
export type FlagPlatform = 'web' | 'wechat' | 'crazygames';
export const FLAG_PLATFORMS: readonly FlagPlatform[] = ['web', 'wechat', 'crazygames'];

/** Targeting rules (optional rollout sub-document in the admin featureFlags collection). */
export interface FlagRollout {
  /** 0-100, stable bucket assignment via hash(flagKey+accountId). */
  pct?: number;
  /** Matched deployment regions (see DEPLOY_TOPOLOGY). */
  regions?: string[];
  /** Matched platforms. */
  platforms?: FlagPlatform[];
  /** Allowlist: a match enables the flag (overrides pct/region/platform). */
  allowAccounts?: string[];
  /** Denylist: a match disables the flag (overrides everything except the allowlist). */
  denyAccounts?: string[];
  /**
   * publicId allowlist (FEATURE_FLAGS_DESIGN §9.1): a match enables the flag, same priority as allowAccounts.
   * The targeting key is AccountDoc.publicId (9-digit, player-visible), **not** the internal accountId —
   * operators enter it directly in ops (most human-readable form). The client sends its own publicId when
   * polling /bootstrap; it is injected as ctx.publicId at evaluation time, no DB lookup needed.
   * Client log targeting (client_log_*) uses this dimension to target individual players precisely.
   */
  allowPublicIds?: string[];
}

/** Flag rule document (admin featureFlags collection; _id = flag key). */
export interface FeatureFlagDoc {
  _id: FlagKey;
  /** Master switch: false → disabled for everyone (ignores all targeting). */
  enabled: boolean;
  rollout?: FlagRollout;
  desc?: string;
  updatedAt: number;
  /** Admin account ID. */
  updatedBy: string;
}

/** Evaluation context (for the current user / deployment environment). */
export interface FlagContext {
  /** Undefined when not logged in. */
  accountId?: string;
  /** Player-visible 9-digit publicId (used for §9.1 targeted log collection; sent by the client when polling /bootstrap). Undefined when unknown. */
  publicId?: string;
  /** Deployment region (injected by the process, which knows its own region). */
  region?: string;
  platform?: FlagPlatform;
}

// ── Stable hash (FNV-1a 32-bit) ────────────────────────────────────────────
// Rollout bucketing must be stable: the same player must always land in the same bucket for a given flag
// (otherwise the population drifts). FNV-1a is simple, dependency-free, and sufficiently uniform.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash; returns an unsigned 32-bit integer. */
export function fnv1a(input: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    // Math.imul performs 32-bit multiplication without overflow.
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Stable bucket assignment: returns a bucket number in [0,100) via hash(flagKey+accountId) % 100. */
export function rolloutBucket(key: string, accountId: string): number {
  return fnv1a(`${key}:${accountId}`) % 100;
}

// ── Evaluation (single source of truth for frontend and backend) ────────────
/**
 * Evaluates a flag. Short-circuit order (FEATURE_FLAGS_DESIGN §3):
 *  1. doc does not exist → default;
 *  2. enabled===false → false (master switch takes priority over everything);
 *  3. denyAccounts match → false;
 *  4. allowAccounts / allowPublicIds match → true (overrides region/platform/pct);
 *  5. regions constrained and current region not in list → false; same for platforms;
 *  6. pct constrained: bucket < pct → true, otherwise false; when not logged in (no accountId), only pct>=100 matches (conservative);
 *  7. all checks pass → true.
 */
export function evaluateFlag(key: FlagKey, doc: FeatureFlagDoc | null | undefined, ctx: FlagContext): boolean {
  if (!doc) return flagDefault(key);
  if (doc.enabled === false) return false;
  const r = doc.rollout;
  if (!r) return true; // Master switch on, no targeting rules → enabled for everyone.

  if (ctx.accountId && r.denyAccounts?.includes(ctx.accountId)) return false;
  if (ctx.accountId && r.allowAccounts?.includes(ctx.accountId)) return true;
  // publicId allowlist has the same priority as allowAccounts (§9.1): a match enables the flag, overriding region/platform/pct.
  if (ctx.publicId && r.allowPublicIds?.includes(ctx.publicId)) return true;

  if (r.regions && r.regions.length > 0) {
    if (!ctx.region || !r.regions.includes(ctx.region)) return false;
  }
  if (r.platforms && r.platforms.length > 0) {
    if (!ctx.platform || !r.platforms.includes(ctx.platform)) return false;
  }
  if (typeof r.pct === 'number') {
    const pct = Math.max(0, Math.min(100, r.pct));
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    // Not logged in, no accountId: cannot assign a stable bucket → only pct>=100 matches (already returned above), so return false here.
    if (!ctx.accountId) return false;
    return rolloutBucket(key, ctx.accountId) < pct;
  }
  return true;
}

// ── Process-level cache (backends without DB access: poll admin for raw rules + short TTL + local evaluation) ──────
/**
 * Validates and normalises a raw rule document (from the admin internal endpoint / database).
 * Drops keys not in the allowlist and any invalid fields.
 * Fault-tolerance first: any missing or out-of-range field is silently ignored (no throw) —
 * the distribution path must never crash due to dirty data.
 */
export function sanitizeFlagDoc(raw: unknown): FeatureFlagDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isFlagKey(o._id)) return null;
  const rolloutIn = o.rollout && typeof o.rollout === 'object' ? (o.rollout as Record<string, unknown>) : undefined;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  let rollout: FlagRollout | undefined;
  if (rolloutIn) {
    rollout = {};
    if (typeof rolloutIn.pct === 'number' && Number.isFinite(rolloutIn.pct)) {
      rollout.pct = Math.max(0, Math.min(100, Math.floor(rolloutIn.pct)));
    }
    const regions = strArr(rolloutIn.regions);
    if (regions) rollout.regions = regions;
    const platforms = strArr(rolloutIn.platforms)?.filter((p): p is FlagPlatform =>
      (FLAG_PLATFORMS as readonly string[]).includes(p),
    );
    if (platforms) rollout.platforms = platforms;
    const allow = strArr(rolloutIn.allowAccounts);
    if (allow) rollout.allowAccounts = allow;
    const deny = strArr(rolloutIn.denyAccounts);
    if (deny) rollout.denyAccounts = deny;
    const allowPublicIds = strArr(rolloutIn.allowPublicIds);
    if (allowPublicIds) rollout.allowPublicIds = allowPublicIds;
    if (Object.keys(rollout).length === 0) rollout = undefined;
  }
  return {
    _id: o._id,
    enabled: o.enabled !== false, // defaults to enabled (only an explicit false closes the master switch)
    ...(rollout ? { rollout } : {}),
    ...(typeof o.desc === 'string' ? { desc: o.desc } : {}),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : '',
  };
}

export interface FeatureFlagCacheOpts {
  /** Function to fetch all raw rules (typically polling admin GET /admin/internal/flags). */
  fetchAll: () => Promise<unknown[]>;
  /** Refresh interval in ms. Default 30000. */
  ttlMs?: number;
  /** Inject clock (for testing). Default Date.now. */
  now?: () => number;
  /** Region (the process knows its own region; injected as the default evaluation ctx value). */
  region?: string;
  /** Callback on refresh failure (defaults to silent — gracefully falls back to stale cache). */
  onError?: (err: unknown) => void;
}

/**
 * Flag cache for backends without DB access: triggers one refresh on start → refreshes every ttl → exposes isOn(key, ctx) (which internally calls evaluateFlag).
 * Degradation strategy: when admin is unreachable, uses the last cached value; if never fetched on cold start → falls back to default. Never blocks the main flow.
 */
export class FeatureFlagCache {
  private docs = new Map<FlagKey, FeatureFlagDoc>();
  private timer: NodeJS.Timeout | null = null;
  private loadedOnce = false;
  private readonly fetchAll: () => Promise<unknown[]>;
  private readonly ttlMs: number;
  private readonly region?: string;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: FeatureFlagCacheOpts) {
    this.fetchAll = opts.fetchAll;
    this.ttlMs = opts.ttlMs ?? 30_000;
    if (opts.region) this.region = opts.region;
    if (opts.onError) this.onError = opts.onError;
  }

  /** Fetches the full rule set and replaces the cache. On failure, retains the old cache (no throw). */
  async refresh(): Promise<void> {
    try {
      const raw = await this.fetchAll();
      const next = new Map<FlagKey, FeatureFlagDoc>();
      for (const r of raw) {
        const doc = sanitizeFlagDoc(r);
        if (doc) next.set(doc._id, doc);
      }
      this.docs = next;
      this.loadedOnce = true;
    } catch (e) {
      this.onError?.(e);
      // Retain old cache, graceful degradation.
    }
  }

  /** Starts periodic refresh (fetches once immediately, then on a timer). The timer is unref'd — it does not prevent process exit. */
  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.ttlMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Evaluates a flag (injects cache.region into ctx by default; callers may override). */
  isOn(key: FlagKey, ctx: FlagContext = {}): boolean {
    const merged: FlagContext = { ...ctx };
    if (merged.region === undefined && this.region !== undefined) merged.region = this.region;
    return evaluateFlag(key, this.docs.get(key) ?? null, merged);
  }

  /** Raw rule document for a flag in the current cache (for admin tooling/debugging; returns null if not present). */
  rawDoc(key: FlagKey): FeatureFlagDoc | null {
    return this.docs.get(key) ?? null;
  }

  /** Whether at least one successful fetch has completed (false = still falling back to defaults). */
  get hasLoaded(): boolean {
    return this.loadedOnce;
  }
}
