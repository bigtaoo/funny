// SLG prosperity (G2 / §8.1 / SLG_DESIGN §17.1), season settlement rewards (§8.3), and G6 multi-shard allocation (§17.8).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

/** Prosperity score weights (verified: ECONOMY_NUMBERS §13-SLG-E, econ-sim E-track CLOSED 2026-06-30). */
export const PROSPERITY_W_TERRITORY = 10;   // per territory tile
export const PROSPERITY_W_MEMBER    = 50;   // per member
export const PROSPERITY_W_ACTIVITY  = 5;    // per point of season activity (new occupations + battles, source §17.4)
/** Inactivity decay: fraction decayed per calendar day (settled lazily at read time, analogous to resource yield). */
export const PROSPERITY_DECAY_PER_DAY = 0.05; // 5%/day
/** Minimum prosperity to found a sect (§8.2, §16.5 A7 decision): 30 members + 30 tiles = 1800 base, plus some activity required.
 *  Reachability/decay verified via econ-sim E-track (server/tools/econ-sim/src/prosperityRun.ts) — ECONOMY_NUMBERS §13-SLG-E,
 *  CLOSED 2026-06-30: active-median family (20 start members, 3.5 tiles/day, 4 activity/day) founds by day 9 (7–14 day window). */
export const SECT_FOUND_PROSPERITY_MIN = 2000;

/** Family prosperity pure function: unit-testable, computable on either end, integer result. activity = cumulative season activity points (§17.4). */
export function familyProsperity(territoryCount: number, memberCount: number, activity: number): number {
  return Math.floor(
    territoryCount * PROSPERITY_W_TERRITORY +
    memberCount * PROSPERITY_W_MEMBER +
    activity * PROSPERITY_W_ACTIVITY,
  );
}
/** Decay: value of base after dtDays days of inactivity (shrinks without activity), floored to integer. */
export function decayProsperity(base: number, dtDays: number): number {
  return Math.floor(base * Math.pow(1 - PROSPERITY_DECAY_PER_DAY, Math.max(0, dtDays)));
}

// ── Season settlement rewards (§8.3, DRAFT → ECONOMY_NUMBERS §13-SLG) ─────
/** Settlement tier (bucketed by each sect's rank in number of nations controlled). */
export type SettleTier = 'champion' | 'top3' | 'top10' | 'participant';
export function settleTier(rank: number): SettleTier {
  if (rank === 1) return 'champion';
  if (rank <= 3) return 'top3';
  if (rank <= 10) return 'top10';
  return 'participant';
}
/** Per-tier rewards (material items / skins / title). Placeholder values pending economic simulation. */
export interface SettleReward {
  items: Record<string, number>;     // materials: { scrap: N, lead: M, binding: K }
  skins: string[];                   // skin ids (limited edition)
  /** Season-title key (the {key} in slg.s{N}.{key}); settlement stamps the season → slgTitleId(season, key). Absent = no title for this tier. */
  titleKey?: string;
  coins?: number;                    // optional coins (must be included in the overall economic budget, OVERVIEW §3.3)
}
export const SETTLE_REWARDS: Record<SettleTier, SettleReward> = {
  champion:    { items: { scrap: 500, lead: 200, binding: 50 }, skins: ['slg_champion_frame'], titleKey: 'champion', coins: 0 },
  top3:        { items: { scrap: 300, lead: 120, binding: 25 }, skins: [], titleKey: 'top3' },
  top10:       { items: { scrap: 150, lead: 60,  binding: 10 }, skins: [] },
  participant: { items: { scrap: 50,  lead: 20,  binding: 0  }, skins: [] },
};

/**
 * SLG regional season length (SEASON_OVERVIEW §2: SLG 大区赛季 = 2 个月). Drives WorldDoc.settleAt (= openAt + this)
 * so the scheduler can auto-run settlement at season end (§17.11). Displayed as "预计结束"; also an admin can settle early.
 * [可调 → ECONOMY_NUMBERS §13-SLG]
 */
export const SLG_SEASON_DURATION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
/** Battle-pass resource production multiplier (S8-8): hourly yield ×BP_YIELD_MULT for holders. Applied in recomputeYield after all other multipliers. */
export const BP_YIELD_MULT = 1.1;
/** Extra settlement reward dispatched to every battle-pass holder at season end, regardless of tier (S8-8). */
export const BP_SETTLE_EXTRA: Readonly<{ items: Record<string, number>; skins: string[] }> = {
  items: { scrap: 50, lead: 20, binding: 5 },
  skins: [],
};

// ── G6 multi-shard allocation (data foundation + pure algorithm; runtime deferred, §17.8) ─────
/**
 * Capacity per shard (default value for openSeason capacity; replaces hard-coded value).
 * ADR-032: a 500×500 map holds ~500 active players per shard; a new shard opens past this.
 * (Matches SLG_WORLD_CAPACITY_MAX in slg/core.ts; the former 10000 value was retired 2026-07-07.)
 */
export const WORLD_CAPACITY = 500;
/** Batch size for bulk deletes during resetSeason (§17.6). */
export const RESET_DELETE_BATCH = 2000;

/** "Overall strength" input for a sect (sourced from last season's seasonResults + current size/prosperity). */
export interface SectStrength {
  sectId: string;
  lastSeasonRank?: number;   // last season's rank (absent = new sect)
  memberFamilyCount: number;
  prosperity: number;        // current aggregated prosperity
}
/** Strength score (higher = stronger): primarily based on historical rank (lower rank number = stronger), with size/prosperity as secondary factors.
 *  Weight sensitivity verified: ECONOMY_NUMBERS §13-SLG-D, CLOSED 2026-06-30. */
export function sectStrengthScore(s: SectStrength): number {
  const rankScore = s.lastSeasonRank ? Math.max(0, 100 - s.lastSeasonRank) * 100 : 500; // new sect gets median score
  return rankScore + s.memberFamilyCount * 50 + Math.floor(s.prosperity / 100);
}
/**
 * Snake-draft balanced allocation: sorts sects by score descending, then deals them snake-style to shardCount shards
 * so that the sum of strengths across shards is as balanced as possible (pairing strong sects with weak ones, SLG3). Returns sectId→shardIndex.
 * shardCount is pre-computed as ceil(∑member_count / shard_capacity) (§17.8); caller guarantees ≥ 1.
 */
export function allocateSectsToShards(sects: SectStrength[], shardCount: number): Map<string, number> {
  const out = new Map<string, number>();
  const n = Math.max(1, Math.floor(shardCount));
  const sorted = [...sects].sort((a, b) => sectStrengthScore(b) - sectStrengthScore(a));
  // Snake cursor: 0,1,..,n-1,n-1,..,1,0,0,.. (direction reverses every n items).
  for (let i = 0; i < sorted.length; i++) {
    const cycle = Math.floor(i / n);
    const pos = i % n;
    const shard = cycle % 2 === 0 ? pos : n - 1 - pos;
    out.set(sorted[i]!.sectId, shard);
  }
  return out;
}

// ── G6 runtime scheduling (§20): id format + shard count derivation ─────────────
/** Authoritative world id format (= WorldDoc._id); replaces client-side hard-coding. */
export function worldShardId(season: number, shard: number): string {
  return `s${season}-${shard}`;
}
/** Population → required shard count (§17.8 step 2; ceil, minimum 1). Unit-testable. */
export function shardCountForPopulation(totalPlayers: number, capacity: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalPlayers) / Math.max(1, capacity)));
}
