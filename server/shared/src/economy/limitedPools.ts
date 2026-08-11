// Economy config — limited-time gacha pools (GACHA_DESIGN §2.2/§7). 2026-08-11 split (independent
// function modules form, see ../economy.ts's header). Depends on gacha.ts (GACHA_POOLS/GachaPoolDef —
// buildLimitedPool derives a limited pool's content from the standard pool so there is no drift); zero
// other cross-file dependency within economy/*.
//
// Config lives in commercial DB (admin-created); the pool content is *derived* here (pure) from the
// standard pool so there is no drift.
import { GACHA_POOLS, type GachaPoolDef } from './gacha';

/** Admin-authored limited-pool config (stored in commercial `gachaPools`). Content derives from the standard pool. */
export interface LimitedPoolConfig {
  id: string; // unique pool id (e.g. 'limited_01'); pity is tracked independently under this id
  name: string; // display name (banner title)
  featuredLegendary: string; // banner legendary itemId (delivered as a skin); off-banner legendary → Fate Point (§7)
  startAt: number; // open timestamp (ms)
  endAt: number; // close timestamp (ms)
  /** Off-banner legendary fillers (default = standard pool's cosmetic/equipment legendaries; excludes character cards). */
  fillerLegendaries?: string[];
}

/** Standard-pool legendary items used as limited-pool off-banner filler (cosmetics + equipment; character cards excluded so limited pools never dilute progression). */
export const DEFAULT_LIMITED_FILLER_LEGENDARIES = ['skin_l1', 'wp_highlighter', 'ar_foil', 'tk_seal'];

/**
 * Build a full GachaPoolDef from a limited-pool config (pure). Common/rare/epic tiers copy the standard pool;
 * the legendary tier is the featured banner (weighted to ~50% via slot repetition) plus off-banner fillers.
 * Hitting an off-banner legendary is the "off-target" pull that awards a Fate Point (commercial.gachaDraw §7).
 */
export function buildLimitedPool(cfg: LimitedPoolConfig): GachaPoolDef {
  const std = GACHA_POOLS[0]!; // standard pool = content template
  const fillers = cfg.fillerLegendaries ?? DEFAULT_LIMITED_FILLER_LEGENDARIES;
  // Featured occupies as many slots as there are fillers → featured ≈ 50% of legendary rolls.
  const featuredSlots = Math.max(1, fillers.length);
  const legendary = [...Array(featuredSlots).fill(cfg.featuredLegendary), ...fillers];
  return {
    id: cfg.id,
    costSingle: std.costSingle,
    costTen: std.costTen,
    pityThreshold: std.pityThreshold,
    tenFloor: std.tenFloor,
    softPityStart: std.softPityStart,
    softPityStep: std.softPityStep,
    dupePolicy: 'coins',
    limited: true,
    featuredLegendary: cfg.featuredLegendary,
    startAt: cfg.startAt,
    endAt: cfg.endAt,
    itemsByRarity: {
      common: std.itemsByRarity.common,
      rare: std.itemsByRarity.rare,
      epic: std.itemsByRarity.epic,
      legendary,
    },
  };
}

/** A limited pool is open when now ∈ [startAt, endAt). */
export function isLimitedPoolActive(cfg: { startAt: number; endAt: number }, now: number): boolean {
  return now >= cfg.startAt && now < cfg.endAt;
}
