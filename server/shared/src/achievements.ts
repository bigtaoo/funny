// Single source of truth for achievement system mechanics: definitions + pure logic (canonical reference: ACHIEVEMENT_DESIGN.md).
// Pure data + pure functions; no DB / no PIXI. Server and client share the same source
// (client reuses the same definitions via mirror/codegen to compute tier state).
// Numbers (thresholds/coins) mirror ECONOMY_BALANCE.md §2.4 (DRAFT); changing an entry requires a release
// (§6.1 decision: hard-coded values are not operator-configurable).
import type { SaveData } from './types';

/**
 * StatKey: identifier for a lifetime-cumulative, monotonically increasing statistic. Named as "domain.subject.action".
 * **Once live, entries may only be added — never renamed or deleted**
 * (renaming = losing historical accumulation; §3.1). A single stat may be referenced by multiple achievements.
 */
export type StatKey =
  | 'kill.archer' // total archer kills
  | 'kill.guard' // total guard kills
  | 'cast.meteor' // total meteor casts
  | 'campaign.chaptersCleared' // chapters cleared (tracks maximum reached; increments only on first clear)
  | 'pvp.wins'; // total PvP wins (ranked only)

/** Achievement category (the achievement wall is tabbed by this, §7). */
export type AchCategory = 'pve' | 'pvp' | 'collection' | 'progression';

/** Achievement id (stable identifier; like StatKey, must not change after going live). */
export type AchId = string;

export interface AchTier {
  threshold: number; // stat value required to unlock this tier (strictly increasing: higher tier threshold ≥ lower)
  coins: number; // one-time coin reward for this tier (A1: strictly one-time, not farmable)
}

export interface Achievement {
  id: AchId;
  statKey: StatKey;
  category: AchCategory;
  tiers: AchTier[]; // typically 3 tiers (I/II/III), claimed one at a time
  /** Permanent title awarded when the top tier is reached (§0 added 2026-06-21; optional, most achievements have none). */
  titleId?: string;
  /** Hidden/easter-egg achievement (not shown on the wall until unlocked, §10 decision 9; reserved in the model, initially all false). */
  hidden?: boolean;
  /** Whether this statKey counts PvE replays (§10 decision 3; most kill.* stats accept replays). Documentation/audit semantics only — does not affect accumulation. */
  countsReplay?: boolean;
}

/**
 * Hard-coded achievement definition table (§3.1 five template initial values; thresholds/coins = ECONOMY_BALANCE §2.4 DRAFT).
 * A single fully-claimed achievement yields ~350 coins; expanding to ~25 entries later
 * gives a total one-time game-wide pool of ~8–9k coins (all one-time, not a sustained pump).
 */
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'ach.kill.archer',
    statKey: 'kill.archer',
    category: 'pvp',
    countsReplay: true,
    tiers: [
      { threshold: 100, coins: 50 },
      { threshold: 500, coins: 100 },
      { threshold: 2000, coins: 200 },
    ],
  },
  {
    id: 'ach.kill.guard',
    statKey: 'kill.guard',
    category: 'pvp',
    countsReplay: true,
    tiers: [
      { threshold: 100, coins: 50 },
      { threshold: 500, coins: 100 },
      { threshold: 2000, coins: 200 },
    ],
  },
  {
    id: 'ach.cast.meteor',
    statKey: 'cast.meteor',
    category: 'progression',
    countsReplay: true,
    tiers: [
      { threshold: 20, coins: 50 },
      { threshold: 100, coins: 100 },
      { threshold: 400, coins: 200 },
    ],
  },
  {
    id: 'ach.campaign.chapters',
    statKey: 'campaign.chaptersCleared',
    category: 'pve',
    countsReplay: false, // counts only on first clear; replays do not increment (§3.1 $max semantics)
    tiers: [
      { threshold: 1, coins: 100 },
      { threshold: 3, coins: 200 },
      { threshold: 9, coins: 400 }, // "all chapters" placeholder: currently 9 chapters; update in sync when chapters are added
    ],
    titleId: 'ach.all_chapters', // top tier (all chapters cleared) awards a permanent title (§7)
  },
  {
    id: 'ach.pvp.wins',
    statKey: 'pvp.wins',
    category: 'pvp',
    countsReplay: false,
    tiers: [
      { threshold: 10, coins: 50 },
      { threshold: 50, coins: 150 },
      { threshold: 200, coins: 300 },
    ],
    titleId: 'ach.pvp.veteran', // top tier (200 wins) awards a permanent title (§7)
  },
];

export function findAchievement(id: AchId): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

export interface TierState {
  tier: number; // 1-based
  threshold: number;
  coins: number;
  reached: boolean; // stat ≥ threshold
  claimable: boolean; // threshold reached and not yet claimed (badge dot source)
  claimed: boolean; // already claimed
  progress: number; // min(stat, threshold), used for the progress bar
}

/**
 * Derives the current state of each tier (stateless; computed identically on client and server, §4.1).
 * Unlocked tiers are always derived on the fly from stats and never persisted,
 * so changing definitions or adjusting thresholds requires no player-data migration.
 */
export function tierState(
  def: Achievement,
  stats: SaveData['stats'],
  claimedTiers: number[],
): TierState[] {
  const v = stats?.[def.statKey] ?? 0;
  return def.tiers.map((t, i) => {
    const tier = i + 1;
    const reached = v >= t.threshold;
    const claimed = claimedTiers.includes(tier);
    return {
      tier,
      threshold: t.threshold,
      coins: t.coins,
      reached,
      claimable: reached && !claimed,
      claimed,
      progress: Math.min(v, t.threshold),
    };
  });
}

/** Returns true if any achievement has a claimable tier → show entry-point badge dot (§4.1 badge aggregation). */
export function hasClaimable(
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  for (const def of ACHIEVEMENTS) {
    const claimed = achievements?.[def.id]?.claimedTiers ?? [];
    if (tierState(def, stats, claimed).some((s) => s.claimable)) return true;
  }
  return false;
}

export type ClaimError = 'BAD_REQUEST' | 'NOT_REACHED' | 'ALREADY_CLAIMED';

export interface ClaimOk {
  ok: true;
  coins: number; // coins granted in this claim
  tier: number;
}

/**
 * Pure validation function for claim requests (§4.3 steps 1–2): does not trust the client;
 * re-validates that stat ≥ threshold and that the tier has not already been claimed.
 * Returns the tier's coin amount on success, or an error code on failure.
 * Persistence ($addToSet + coin grant) is the caller's responsibility within a transaction.
 */
export function validateClaim(
  achId: AchId,
  tier: number,
  stats: SaveData['stats'],
  claimedTiers: number[],
): ClaimOk | { ok: false; error: ClaimError } {
  const def = findAchievement(achId);
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  if (!Number.isInteger(tier) || tier < 1 || tier > def.tiers.length) {
    return { ok: false, error: 'BAD_REQUEST' };
  }
  const t = def.tiers[tier - 1];
  if (!t) return { ok: false, error: 'BAD_REQUEST' };
  const v = stats?.[def.statKey] ?? 0;
  if (v < t.threshold) return { ok: false, error: 'NOT_REACHED' };
  if (claimedTiers.includes(tier)) return { ok: false, error: 'ALREADY_CLAIMED' };
  return { ok: true, coins: t.coins, tier };
}

// ─── PvP match-report stat counting (S9-6, §4.2 direct reporting + §4.4 L1 anomaly review) ─────────────────────

/**
 * StatKeys that can be fed in from a PvP match report (**ranked only**, §3.1).
 * `pvp.wins` is **not** in this list — it is computed server-side by meta from the verified winner_side (§4.2)
 * and is never trusted from client reports.
 * `campaign.chaptersCleared` is PvE-exclusive and is also excluded.
 */
export const PVP_REPORTED_STAT_KEYS: readonly StatKey[] = ['kill.archer', 'kill.guard', 'cast.meteor'];

/**
 * L1 per-match hard cap (§4.4): if a reported statKey value exceeds this limit it is "grossly out of bounds"
 * → the entire report is rejected and the account is flagged as suspicious.
 * These are **coarse upper bounds** (estimated from the engine's extreme-scale unit/spell play count per match);
 * precise derivation is a TODO in §6.2.
 * Values are far above normal per-match figures (normal: tens of kills, single-digit meteors)
 * and are only meant to catch obvious forgeries without affecting legitimate counts.
 */
export const PVP_STAT_MATCH_CAP: Readonly<Record<string, number>> = {
  'kill.archer': 200,
  'kill.guard': 200,
  'cast.meteor': 100,
};

/**
 * Sanitizes client-reported per-match PvP stats (L1, §4.4):
 * - **Unknown/non-reportable keys**: silently dropped (forward-compatibility version skew; does not reject the whole report).
 * - **Non-negative integer check + L1 hard cap**: if any **known reportable key** is invalid or out of range
 *   → returns `null` (reject all stats for this side; caller should skip kill/cast accumulation,
 *   but `pvp.wins`/ELO still proceed normally; escalation to suspicion is S9-7, this function only sanitizes).
 * - Zero values are omitted (lazy creation; zeros are not written).
 */
export function sanitizePvpReportedStats(
  reported: Record<string, number> | undefined,
): Partial<Record<StatKey, number>> | null {
  if (!reported) return {};
  const out: Partial<Record<StatKey, number>> = {};
  for (const [k, v] of Object.entries(reported)) {
    if (!PVP_REPORTED_STAT_KEYS.includes(k as StatKey)) continue; // unknown key → drop (do not reject the whole report)
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null; // invalid → L1 reject
    if (v > (PVP_STAT_MATCH_CAP[k] ?? 0)) return null; // L1 cap exceeded → reject
    if (v > 0) out[k as StatKey] = v;
  }
  return out;
}

/**
 * Accumulates a statKey delta into the player's lifetime `stats` (lazy creation: if the delta is empty,
 * returns prev unchanged without allocating a new object).
 * Called at authoritative server settlement points (PvP applyPvp / PvE settlement); pure function for easy unit testing.
 */
export function accrueStats(
  prev: SaveData['stats'],
  delta: Partial<Record<StatKey, number>>,
): SaveData['stats'] {
  const keys = Object.keys(delta) as StatKey[];
  if (keys.length === 0) return prev;
  const next: Record<string, number> = { ...(prev ?? {}) };
  for (const k of keys) next[k] = (next[k] ?? 0) + (delta[k] ?? 0);
  return next as SaveData['stats'];
}
