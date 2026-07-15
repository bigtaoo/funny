// SLG shop items (S8-8, §8).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

export interface SlgShopItem {
  id: string;
  /** Coin price. */
  cost: number;
  kind: 'troop_speedup' | 'resource_pack' | 'protection' | 'battle_pass';
  /** Effect parameters (duration_sec / resource_each / pass_season). */
  effect: Record<string, number | string>;
  description: string;
  /**
   * Max purchases per UTC calendar day (SLG_DESIGN §7.2, 2026-07-15 fix — previously unlimited, letting a
   * paying player compress the B-track city/army pacing (ECONOMY_NUMBERS §13-SLG-CITY) to zero with no cap
   * on spend). Undefined = unlimited (battle_pass is once-per-season already; protection's value is
   * self-limiting via stacked duration, so neither needs a count cap).
   */
  dailyLimit?: number;
}

export const SLG_SHOP_ITEMS: readonly SlgShopItem[] = [
  // training speed-ups
  { id: 'slg_speedup_1h',    cost: 200,   kind: 'troop_speedup', effect: { duration_sec: 3600 },  description: 'Speed up training by 1 hour', dailyLimit: 10 },
  { id: 'slg_speedup_8h',    cost: 1400,  kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: 'Speed up training by 8 hours', dailyLimit: 10 },
  { id: 'slg_speedup_24h',   cost: 3600,  kind: 'troop_speedup', effect: { duration_sec: 86400 }, description: 'Speed up training by 24 hours', dailyLimit: 10 },
  // resource packs (equal amounts of every season resource)
  { id: 'slg_res_s',  cost: 300,   kind: 'resource_pack', effect: { each: 20000 },  description: 'Small resource pack (20k each)', dailyLimit: 5 },
  { id: 'slg_res_m',  cost: 1000,  kind: 'resource_pack', effect: { each: 80000 },  description: 'Medium resource pack (80k each)', dailyLimit: 5 },
  { id: 'slg_res_l',  cost: 3000,  kind: 'resource_pack', effect: { each: 200000 }, description: 'Large resource pack (200k each)', dailyLimit: 5 },
  // protection shields (no count cap: value is self-limiting via stacked duration)
  { id: 'slg_shield_8h',  cost: 500,  kind: 'protection', effect: { duration_sec: 28800 }, description: 'Capital protection shield 8 hours' },
  { id: 'slg_shield_24h', cost: 1200, kind: 'protection', effect: { duration_sec: 86400 }, description: 'Capital protection shield 24 hours' },
  // season battle pass (no count cap: already once-per-season in practice)
  { id: 'slg_battle_pass', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: 'Season battle pass (valid for current season)' },
] as const;

export type SlgShopItemId = (typeof SLG_SHOP_ITEMS)[number]['id'];

export function isSlgShopItemId(v: unknown): v is SlgShopItemId {
  return typeof v === 'string' && SLG_SHOP_ITEMS.some((i) => i.id === v);
}

export function slgShopItemDefault(id: SlgShopItemId): SlgShopItem {
  // Non-null: id is only ever a valid SlgShopItemId (guarded by isSlgShopItemId at every call site).
  return SLG_SHOP_ITEMS.find((i) => i.id === id)!;
}

// ── Admin-configurable price overrides (ops runs price adjustments without a redeploy) ──────────
// Same shape as the feature-flags override pattern (see featureFlags.ts): admin owns the only
// collection + writer; database-less backends (worldsvc) poll admin's internal endpoint for the
// raw override docs and merge them onto the code defaults locally via resolveSlgShopItem.

/** Price/effect override document (admin slgShopPrices collection; _id = shop item id). Only fields present here are overridden — everything else falls back to the SLG_SHOP_ITEMS default. */
export interface SlgShopItemOverrideDoc {
  _id: SlgShopItemId;
  cost?: number;
  effect?: Record<string, number | string>;
  updatedAt: number;
  updatedBy: string;
}

/** Merges an override doc onto the code-default item (doc fields, if present, win; everything else keeps the default). */
export function resolveSlgShopItem(base: SlgShopItem, doc: SlgShopItemOverrideDoc | null | undefined): SlgShopItem {
  if (!doc) return base;
  return {
    ...base,
    ...(typeof doc.cost === 'number' ? { cost: doc.cost } : {}),
    ...(doc.effect ? { effect: { ...base.effect, ...doc.effect } } : {}),
  };
}

/**
 * Validates and normalises a raw override document (from the admin internal endpoint / database).
 * Fault-tolerance first, mirroring sanitizeFlagDoc: any missing/invalid field is silently dropped
 * (no throw) so a dirty doc can never crash the shop purchase path — it just falls back to the default.
 */
export function sanitizeSlgShopItemOverrideDoc(raw: unknown): SlgShopItemOverrideDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isSlgShopItemId(o._id)) return null;
  let effect: Record<string, number | string> | undefined;
  if (o.effect && typeof o.effect === 'object') {
    const out: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(o.effect as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string') out[k] = v;
    }
    if (Object.keys(out).length > 0) effect = out;
  }
  return {
    _id: o._id,
    ...(typeof o.cost === 'number' && Number.isFinite(o.cost) && o.cost > 0 ? { cost: Math.floor(o.cost) } : {}),
    ...(effect ? { effect } : {}),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : '',
  };
}

export interface SlgShopPriceCacheOpts {
  /** Function to fetch all raw override docs (typically polling admin GET /admin/internal/slg-shop-prices). */
  fetchAll: () => Promise<unknown[]>;
  /** Refresh interval in ms. Default 30000. */
  ttlMs?: number;
  /** Callback on refresh failure (defaults to silent — gracefully falls back to stale cache / code defaults). */
  onError?: (err: unknown) => void;
}

/**
 * Price-override cache for backends without DB access (mirrors FeatureFlagCache): triggers one
 * refresh on start → refreshes every ttl → exposes resolveItem/resolveItems (merge doc onto default).
 * Degradation strategy: admin unreachable → last cached value; never fetched on cold start → code defaults.
 */
export class SlgShopPriceCache {
  private docs = new Map<SlgShopItemId, SlgShopItemOverrideDoc>();
  private timer: NodeJS.Timeout | null = null;
  private loadedOnce = false;
  private readonly fetchAll: () => Promise<unknown[]>;
  private readonly ttlMs: number;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: SlgShopPriceCacheOpts) {
    this.fetchAll = opts.fetchAll;
    this.ttlMs = opts.ttlMs ?? 30_000;
    if (opts.onError) this.onError = opts.onError;
  }

  async refresh(): Promise<void> {
    try {
      const raw = await this.fetchAll();
      const next = new Map<SlgShopItemId, SlgShopItemOverrideDoc>();
      for (const r of raw) {
        const doc = sanitizeSlgShopItemOverrideDoc(r);
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

  /** Resolved item for a single id (default merged with the cached override, if any). */
  resolveItem(id: SlgShopItemId): SlgShopItem {
    return resolveSlgShopItem(slgShopItemDefault(id), this.docs.get(id) ?? null);
  }

  /** Full resolved catalog, in SLG_SHOP_ITEMS order (for client display). */
  resolveItems(): SlgShopItem[] {
    return SLG_SHOP_ITEMS.map((item) => resolveSlgShopItem(item, this.docs.get(item.id) ?? null));
  }

  /** Whether at least one successful fetch has completed (false = still falling back to code defaults). */
  get hasLoaded(): boolean {
    return this.loadedOnce;
  }
}
