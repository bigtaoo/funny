// SLG open-world constants / enums / IDs / procedural map generation — single source of truth (SLG_DESIGN.md §14, S8-0).
// Pure data + pure functions; no DB / no PIXI. worldsvc uses this as the authoritative server-side source for maps/territory/marches/families.
// Collection document shapes (TileDoc/PlayerWorldDoc/MarchDoc…) live in mongo.ts (or worldsvc's own db.ts).
//
// ★ Procedural generation (§14.2 "sparse storage + procedural defaults"): the DB only stores tiles that have been claimed or modified.
//   Untouched neutral tiles are computed on-the-fly by the pure function proceduralTile() derived from worldId — never persisted; this is the key to scalability.
//   The same worldId + the same (x,y) always yields the same tile (computable on either end).

import { ErrorCode, type ErrorCode as ErrorCodeT } from './api';

/**
 * worldsvc endpoint error: carries an SLG ErrorCode (httpApi maps it to HTTP via ERROR_HTTP_STATUS).
 * code is restricted to valid values from api.ts ErrorCode (including the SLG range + generic BAD_REQUEST/NOT_FOUND/…).
 */
export class SlgError extends Error {
  readonly code: ErrorCodeT;
  constructor(code: keyof typeof ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SlgError';
    this.code = ErrorCode[code];
  }
}

// ── Enums (§14.7) ─────────────────────────────────────
export type TileType =
  | 'neutral' // neutral open land (low-level, claimable, minimal yield)
  | 'resource' // resource tile (produces ink/paper/metal)
  | 'territory' // player-claimed territory (only exists after runtime DB write; not generated as this type)
  | 'familyKeep' // strategic point / family stronghold (sparse, high-level, high-value)
  | 'center' // world center (sect ownership contest point; unique)
  | 'base' // player home-city placement (written to DB at runtime)
  | 'obstacle' // blocking terrain (mountains/rivers; fully impassable, S8-6.6)
  | 'gate' // pass/bridge (embedded in blocking zone; passable by occupying faction and allies; treated as obstacle if unoccupied, S8-6.6)
  | 'stronghold'; // stronghold (G8 §3.1): high-strategic-value tile guarded by an overwhelmingly powerful system NPC; cannot be directly occupied — must be conquered via a siege attack

/**
 * SLG season resources (SLG_DESIGN §3.4, naming locked 2026-06-30; stationery theme, aligned with Three-Kingdoms grain/wood/stone/iron/copper).
 * - ink:      sustain — troop training / troop cap / march upkeep (was `food`). Shares the "ink is life" world-symbol with battle `ink` but is a fully separate pool.
 * - paper:    basic building material (was `wood`).
 * - graphite: advanced building material (4th land resource; map faucet via biomeAt quad-partition, sink via high-level building upgrades, SLG_CITY_DESIGN / ADR-022).
 * - metal:    military / equipment forging (was `iron`).
 * - sticker:  universal flexible resource (copper-coin slot: recruit / tech / small instant actions). NOT a global currency — season-scoped, cleared at season end, non-auctionable, not directly purchasable. Faucet = home-city stickerShop self-production (民居模型); sink = building upgrades.
 * All five are season resources (cleared at season end, banned from the auction house); the only global currency is `coins` (ECONOMY_BALANCE).
 */
export type ResourceType = 'ink' | 'paper' | 'graphite' | 'metal' | 'sticker';
export type MarchKind = 'attack' | 'reinforce' | 'occupy' | 'sweep' | 'scout' | 'return';
export type SiegeOutcome = 'attacker_win' | 'defender_win' | 'draw';
export type FamilyRole = 'leader' | 'elder' | 'member';
export type WorldStatus = 'open' | 'active' | 'settling' | 'resetting' | 'closed';
export type AuctionStatus = 'open' | 'sold' | 'expired' | 'cancelled';

export const RESOURCE_TYPES: readonly ResourceType[] = ['ink', 'paper', 'graphite', 'metal', 'sticker'];

// ── Deterministic ID derivation (§14.7; no lookup table required; computable on either end) ──────────
/** World ID: `s{season}-{shard}`; one season-sect world = one map instance. */
export function worldId(season: number, shard: number): string {
  return `s${season}-${shard}`;
}
/** Tile ID: `{worldId}:{x}:{y}`. */
export function tileId(world: string, x: number, y: number): string {
  return `${world}:${x}:${y}`;
}
/** ID of the player's state document in a given world. */
export function playerWorldId(world: string, accountId: string): string {
  return `${world}:${accountId}`;
}
/** Family member document ID. */
export function familyMemberId(world: string, accountId: string): string {
  return `${world}:${accountId}`;
}
/** Family ID (S8-4): `f:{worldId}:{TAG}`; TAG is an uppercase unique abbreviation (3–4 characters). */
export function familyId(worldId: string, tag: string): string {
  return `f:${worldId}:${tag.toUpperCase()}`;
}
/** Sect ID (S8-4b): `s:{worldId}:{TAG}`; TAG is an uppercase unique abbreviation (2–5 characters), unique within a worldId. */
export function sectId(worldId: string, tag: string): string {
  return `s:${worldId}:${tag.toUpperCase()}`;
}
/** Auction ID (S8-5): `a:{worldId}:{sellerId}:{ts}:{seq}`; prevents key collisions when multiple listings are created within the same millisecond. */
export function auctionId(worldId: string, sellerId: string, ts: number, seq: number): string {
  return `a:${worldId}:${sellerId}:${ts}:${seq}`;
}
/**
 * March ID (S8-2): `m:{worldId}:{ownerId}:{departAt}:{seq}`.
 * Marches are transient documents (unlike tile/playerWorld which are globally deterministic); departAt(ms) + a process-local monotonic seq
 * ensures no key collisions when multiple marches depart within the same millisecond. worldsvc is a non-deterministic engine and can safely use real timestamps.
 */
export function marchId(world: string, ownerId: string, departAt: number, seq: number): string {
  return `m:${world}:${ownerId}:${departAt}:${seq}`;
}
/** Siege ID (S8-3): `g:{worldId}:{attackerId}:{ts}:{seq}`; transient battle-report record; uses the same key-collision prevention as marchId. */
export function siegeId(world: string, attackerId: string, ts: number, seq: number): string {
  return `g:${world}:${attackerId}:${ts}:${seq}`;
}

// ── Capacity / map dimensions (U4/U2 finalized, 2026-06-16; SLG_DESIGN §14.10) ──
/** Target capacity for a single server (one season-sect world): medium-sized, 300–500 players. */
export const SLG_WORLD_CAPACITY_MIN = 300;
export const SLG_WORLD_CAPACITY_TARGET = 400;
export const SLG_WORLD_CAPACITY_MAX = 500;

/**
 * Map dimensions: scaled to capacity; back-calculated from ~150–300 developable tiles per player → ~400 players locks in 300×300 (90k tiles).
 * Sparse storage: dimensions only affect the pace of expansion and the feel of march distances; they do not affect storage (only occupied tiles are persisted).
 */
export const SLG_MAP_W = 300;
export const SLG_MAP_H = 300;
export const SLG_MAP_MAX_LEVEL = 5;

// ── Procedural distribution knobs (U6 initial DRAFT; centralized here for easy tuning) ────────
export const SLG_GEN = {
  /** Resource tile density: fraction of non-neutral tiles classified as resource tiles. */
  resourceDensity: 0.34,
  /** familyKeep noise threshold; higher = sparser. */
  keepThreshold: 0.86,
  /** Minimum distance ratio from center for strategic points (prevents keeps from spawning too close to the center). */
  keepMinDistRatio: 0.12,
  /** Level noise frequency (higher = more fragmented patches). */
  levelFreq: 1 / 14,
  /** Biome (resource type) noise frequency (lower = larger patches → large same-resource zones encourage specialization and trade). */
  biomeFreq: 1 / 40,
  /** Strategic point noise frequency. */
  keepFreq: 1 / 22,
  /**
   * Biome quad-partition thresholds (ink < t0 < paper < t1 < graphite < t2 < metal). Four "land-mined" resources are biome-generated
   * (SLG_CITY_DESIGN D-CITY-2, ADR-022): graphite is the 4th land resource, given a map faucet here so the building system can sink it.
   * `sticker` (copper-coin slot) is NOT a land resource — it is self-produced by the home-city stickerShop (民居模型), so it has no biome threshold.
   * ⚠ ADR-022 caveat: this changes the procedural map (unclaimed tiles only — claimed tiles persist resType in the DB). Pre-launch, so applied
   * globally; once a season is live, gate behind a season-version flag instead of mutating live maps. Thresholds are DRAFT, tune in the balance pass.
   */
  biomeInkMax: 0.30,
  biomePaperMax: 0.55,
  biomeGraphiteMax: 0.78,
  /** Level cap for neutral open land (keeps neutral tiles low-value). */
  neutralLevelCap: 2,
  // ── S8-6.6 blocking terrain + gates ──────────────────────────
  /** Obstacle terrain noise frequency (medium-scale continuous mountain/river zones). */
  obstacleFreq: 1 / 40,
  /** Obstacle terrain noise threshold (above this → obstacle; ~12% of tiles). */
  obstacleThreshold: 0.88,
  /**
   * Obstacles only generate in regions where dr ≤ this ratio (outer plains remain obstacle-free, ensuring passability in player starting corners).
   * Areas near corners (dr > obstacleMaxDr) are obstacle-free safe zones.
   */
  obstacleMaxDr: 0.87,
  /** Gate noise frequency (large-scale; sparse strategic corridors). */
  gateFreq: 1 / 60,
  /** Gate noise threshold: gates (strategic corridors) generate inside obstacle zones above this value; extremely sparse. */
  gateThreshold: 0.99,
  // ── G8 strongholds (§3.1) ──────────────────────────
  /** Stronghold noise frequency (large-scale; higher-value points even sparser than strategic keeps). */
  strongholdFreq: 1 / 70,
  /** Stronghold noise threshold: only above this value is a stronghold generated; extremely sparse (~0.3% of map, ~16× sparser than familyKeep). */
  strongholdThreshold: 0.92,
  /** Minimum distance ratio from center for strongholds (prevents strongholds from spawning too close to center; preserves a safe zone for new players). */
  strongholdMinDistRatio: 0.25,
} as const;

// ── Numeric constants (U6 DRAFT; tune after launch) ────────────────────
export const TROOP_CAP_BASE = 2000;
export const MARCH_SPEED_SEC_PER_TILE = 6; // seconds of march time per tile
export const MARCH_MIN_TROOPS = 1; // minimum troops required to send a march
export const RESOURCE_CAP = 200_000;
export const RESOURCE_YIELD_BASE = 100; // base yield per tile per hour (× level multiplier)
export const PROTECTION_SEC = 8 * 3600; // protection duration for new players / after home-city is destroyed
export const FAMILY_CAP = 30; // S8-4 decision: max family size 30 members
/** Family channel message retention duration (seconds); TTL anchor field must be a BSON Date (see FamilyMessageDoc note in db.ts). */
export const FAMILY_MSG_RETENTION_SEC = 7 * 24 * 3600; // 7 days
/** Maximum body length for a single family channel message. */
export const FAMILY_MSG_BODY_MAX = 500;
// ── Sect (S8-4b, §2.1 / §8.2) ──────────────────────────────
/** Maximum number of families in a sect (≤30 families → ≤900 players). */
export const SECT_FAMILY_CAP = 30;
/** Coin cost to found a sect (U5: 5000 coins + prosperity threshold). */
export const SECT_CREATE_COST = 5000;
/** Maximum number of other sects a sect can ally with (alliance cap: ≤3 sects = self + 2 allies). */
export const SECT_ALLY_CAP = 2;
/** Fraction of current resources lost by all sect members when the sect leader's home city is destroyed (§8.2 major penalty). */
export const SECT_LEADER_PENALTY_RATE = 0.5;
/** Vote threshold to remove the sect leader (family-leader votes / number of families ≥ this ratio; §8.2 requires >2/3). */
export const SECT_REMOVAL_VOTE_RATIO = 2 / 3;
export const AUCTION_TAX_RATE = 0.1; // U1 deferred to S8-5; placeholder for now
export const AUCTION_MAX_LISTINGS = 20;
export const AUCTION_DURATIONS_SEC: readonly number[] = [6 * 3600, 12 * 3600, 24 * 3600];

// ── Auction house anti-RMT gates (AUCTION_DESIGN §4; DRAFT values — tune after launch) ──────────────
/** C daily cap: maximum new listing count per account per day (reset at server UTC day boundary). */
export const AUCTION_DAILY_LIST_CAP = 30;
/** C daily cap: maximum buy/bid count per account per day. */
export const AUCTION_DAILY_BUY_CAP = 30;
/** C daily cap counter document TTL (seconds): expires after 2 days for natural cleanup (isolated by dayKey; buffer for cross-day boundary). */
export const AUCTION_DAILY_TTL_SEC = 2 * 24 * 3600;
/**
 * E banned bound materials: materials in this set cannot be listed on the auction house (account-bound / season-event exclusive).
 * Empty initially — the mechanism is in place; the ban list will be populated by economic operations over time (AUCTION_DESIGN §4.E).
 */
export const AUCTION_BANNED_MATERIALS: ReadonlySet<string> = new Set<string>();
/**
 * G price guardrail (dynamic sliding window, AUCTION_DESIGN §4.G): maintains a window of the N most recent sale unit prices per category to compute refPrice;
 * listing/bid unit price must fall within [refPrice×FLOOR, refPrice×CEIL]; falls back to static reference price if samples are insufficient; passes through if no static value (cold-start: no false positives, no nakedly unguarded).
 */
export const AUCTION_PRICE_WINDOW_N = 20; // retain N most recent sale unit prices in the window
export const AUCTION_PRICE_WINDOW_MIN_SAMPLES = 5; // fall back to static reference if fewer than this many samples
export const AUCTION_PRICE_FLOOR_RATIO = 0.5; // unit price floor = refPrice × 0.5 (prevents dumping below floor)
export const AUCTION_PRICE_CEIL_RATIO = 2.0; // unit price ceiling = refPrice × 2.0 (prevents price-ceiling money laundering)
/** G cold-start static reference unit price (per item, DRAFT): used when the sliding window has insufficient samples; calibration figures go in ECONOMY_NUMBERS. Categories not listed are passed through. */
export const AUCTION_STATIC_REF_PRICE: Readonly<Record<string, number>> = {
  scrap: 10,
  lead: 30,
  binding: 80,
};
// ── B Bidding (AUCTION_DESIGN §4.B, DRAFT) ──────────────────────────────────────
/** Minimum bid increment = current highest bid × this ratio (falls back to the absolute starting price if the increment is too small). */
export const AUCTION_MIN_INCREMENT_RATIO = 0.05;
/** Anti-snipe window (seconds): if a new bid arrives within this window before expiry → expireAt is extended by the same window duration, preventing last-second sniping. */
export const AUCTION_ANTI_SNIPE_WINDOW_SEC = 5 * 60;

// ── Anomalous trade auditing (D / G7, anti-RMT, SLG_DESIGN §17.7 / AUCTION_DESIGN §4.D, DRAFT) ──
// Gates C/E/F/G are hard guardrails at order time (rate-limiting / listing bans / freezes / price bands), but they cannot catch
// the money-laundering / item-funneling pattern of "two colluding accounts repeatedly trading directionally within the price band" — that only surfaces after the fact.
// This is the offline detection layer: it scans completed trade records, aggregates suspicious seller→buyer pairs into anomalies,
// and pushes them to the admin audit queue for operators to adjudicate. Pure functions + numeric thresholds; unit-testable and tunable.
/** Default look-back window for audit scans (seconds): only recent trades are considered, avoiding noise from stale cross-season data. */
export const AUDIT_WINDOW_SEC = 7 * 24 * 3600;
/** Number of completed trades between the same seller→buyer pair within the window that triggers a "repeated wash-trading" signal. */
export const AUDIT_PAIR_MIN_TRADES = 5;
/** Number of "designated bid" trades (seller designated this specific buyer) within a pair that triggers a "directed funneling" signal (strong RMT indicator). */
export const AUDIT_PAIR_MIN_DESIGNATED = 3;
/** Cumulative coins traded between the same pair within the window that triggers a "large transfer" signal. */
export const AUDIT_PAIR_MIN_COINS = 50000;

/** A single completed trade record (minimal input for detectAuctionAnomalies; projected from sold auction documents by worldsvc). */
export interface AuctionTradeRecord {
  sellerId: string;
  buyerId: string;
  /** Whether this trade used "designated bid" (the seller specified this buyer when listing). Directed funneling is a strong RMT indicator. */
  designated: boolean;
  /** Gross trade amount (coins = sale unit price × qty, before tax). */
  coins: number;
  ts: number;
}

/** A detected anomalous pair (aggregated in the seller→buyer direction). */
export interface AuctionAnomaly {
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  /** Triggered signals: repeated (wash-trading) / designated (directed funneling) / high_value (large transfer). */
  reasons: Array<'repeated' | 'designated' | 'high_value'>;
}

/** Tunable thresholds for detectAuctionAnomalies (defaults to the constants above; admin/worldsvc can pass overrides for tuning). */
export interface AuctionAuditThresholds {
  minTrades?: number;
  minDesignated?: number;
  minCoins?: number;
}

/**
 * Anomalous trade detection (pure function, D/G7): aggregates completed trade records by directed seller→buyer pair; reports an anomaly if any signal is triggered.
 * - repeated: pair trade count ≥ minTrades (repeated wash-trading / self-buy loop).
 * - designated: designated-bid trades ≥ minDesignated (seller repeatedly naming the same buyer = directed funneling).
 * - high_value: cumulative coins ≥ minCoins (large unidirectional transfer).
 * severity=high when both "directed funneling" and "large transfer" are triggered simultaneously (strongest RMT indicator); otherwise medium.
 * Results are sorted by cumulative coins descending so operators can prioritize large-value cases first.
 */
export function detectAuctionAnomalies(
  trades: readonly AuctionTradeRecord[],
  thresholds: AuctionAuditThresholds = {},
): AuctionAnomaly[] {
  const minTrades = thresholds.minTrades ?? AUDIT_PAIR_MIN_TRADES;
  const minDesignated = thresholds.minDesignated ?? AUDIT_PAIR_MIN_DESIGNATED;
  const minCoins = thresholds.minCoins ?? AUDIT_PAIR_MIN_COINS;

  interface Agg {
    sellerId: string;
    buyerId: string;
    trades: number;
    designatedTrades: number;
    totalCoins: number;
    firstTs: number;
    lastTs: number;
  }
  const byPair = new Map<string, Agg>();
  for (const r of trades) {
    if (!r.sellerId || !r.buyerId || r.sellerId === r.buyerId) continue; // self-trade is impossible; defensive guard
    const key = `${r.sellerId} ${r.buyerId}`;
    let a = byPair.get(key);
    if (!a) {
      a = { sellerId: r.sellerId, buyerId: r.buyerId, trades: 0, designatedTrades: 0, totalCoins: 0, firstTs: r.ts, lastTs: r.ts };
      byPair.set(key, a);
    }
    a.trades += 1;
    if (r.designated) a.designatedTrades += 1;
    a.totalCoins += Math.max(0, r.coins);
    if (r.ts < a.firstTs) a.firstTs = r.ts;
    if (r.ts > a.lastTs) a.lastTs = r.ts;
  }

  const out: AuctionAnomaly[] = [];
  for (const a of byPair.values()) {
    const reasons: AuctionAnomaly['reasons'] = [];
    if (a.trades >= minTrades) reasons.push('repeated');
    if (a.designatedTrades >= minDesignated) reasons.push('designated');
    if (a.totalCoins >= minCoins) reasons.push('high_value');
    if (reasons.length === 0) continue;
    const severity: AuctionAnomaly['severity'] =
      reasons.includes('designated') && reasons.includes('high_value') ? 'high' : 'medium';
    out.push({ ...a, severity, reasons });
  }
  out.sort((x, y) => y.totalCoins - x.totalCoins);
  return out;
}
export const GARRISON_PER_TILE = 500;
/** Minimum garrison required to occupy a tile (becomes that tile's garrison upon arrival; march is rejected if insufficient). */
export const OCCUPY_MIN_TROOPS = GARRISON_PER_TILE;
export const SEASON_LENGTH_DAYS = 60; // U3: 2 months
/** Coin cost to voluntarily relocate the home city (§3.4 / §8.2 home-city relocation: choose a new site + pay to move; applies to all players, not exclusive to the sect leader). */
export const RELOCATE_COST = 500;

/**
 * Resource cost to build a watchtower (§18 G5 V2 remaining item "fixed-radius persistent vision source", DRAFT).
 * Built on a player's own territory (not the home city); the tile is upgraded to a large-radius vision source (VISION_WATCHTOWER_RADIUS), persisted in the DB with the tile (lost if the tile is lost). Costs resources, not coins.
 */
export const WATCHTOWER_COST: Readonly<Record<ResourceType, number>> = { ink: 0, paper: 3000, graphite: 0, metal: 2000, sticker: 0 };

/**
 * Gateway horizontal-scale push channel (SOC9 / §8.4): worldsvc publishes "one message + recipient list" to this Redis
 * pub/sub channel; each gateway instance subscribes and fans out to recipient sockets that are online on that instance.
 * This avoids O(n) direct HTTP pushes from worldsvc to sects of ≤900 players (too much traffic), and naturally supports routing across multiple gateway instances.
 */
export const GW_PUSH_REDIS_CHANNEL = 'nw:gw:push';

// ── Training queue (S8-2, §4 troop cycle) ──────────────────────────────
/** Ink cost per troop trained (sustain resource; DRAFT, tune after launch). */
export const TROOP_TRAIN_INK_COST = 10;
/** Training time per troop (seconds, DRAFT). */
export const TROOP_TRAIN_TIME_SEC = 5;
/** Maximum troops per training batch (single-batch queue size cap). */
export const TROOP_TRAIN_BATCH_MAX = 500;
/** Maximum concurrent training batches (training queue slots). */
export const TROOP_TRAIN_QUEUE_MAX = 2;
/** Speed-up rate: seconds of training time per coin spent (DRAFT, 60 s/coin). */
export const TROOP_SPEEDUP_SECS_PER_COIN = 60;

// ── SLG home-city building system (SLG_CITY_DESIGN, ADR-022; season-scoped, cleared on reset) ──────────
// 主城内政: a single hub (desk) gates a row of stationery buildings. Buildings inject ONLY into SLG economy / troop paths
// (recomputeYield / settleResources cap / troopCap + training); they NEVER feed buildPvpBlueprints (ladder red line, D-CITY-6).
// Pure data + pure functions (computable on either end, unit-testable). All numbers DRAFT — tune in the balance pass
// (SLG_ECONOMY_CHECK), register figures in ECONOMY_NUMBERS §13-SLG-CITY.

export type BuildingKey =
  | 'desk'         // hub: single total-level gate for every other building + base durability / build-queue slots
  | 'inkPot'       // ink global yield multiplier
  | 'paperTray'    // paper global yield multiplier
  | 'graphiteMill' // graphite global yield multiplier
  | 'metalForge'   // metal global yield multiplier
  | 'stickerShop'  // sticker home-city self-production (民居模型; copper-coin faucet)
  | 'cabinet'      // storage cap (RESOURCE_CAP multiplier) + loot protection (P2)
  | 'drillYard'    // troopCap growth + training speed + training queue slots
  | 'wall'         // P2: home-city siege defense
  | 'academy';     // P2: season-scoped blueprint buff

export const BUILDING_KEYS: readonly BuildingKey[] = [
  'desk', 'inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop', 'cabinet', 'drillYard', 'wall', 'academy',
];
/** P1-implemented building keys (wall/academy are P2 placeholders, not yet buildable). */
export const BUILDING_KEYS_P1: readonly BuildingKey[] = [
  'desk', 'inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop', 'cabinet', 'drillYard',
];
/** Which land resource each resource-building boosts (recomputeYield multiplier). stickerShop is self-production, handled separately. */
export const BUILDING_YIELD_RES: Readonly<Partial<Record<BuildingKey, ResourceType>>> = {
  inkPot: 'ink', paperTray: 'paper', graphiteMill: 'graphite', metalForge: 'metal',
};

export const DESK_MAX_LEVEL = 20;              // hub total-level cap (aligned with Three-Kingdoms 20)
export const BUILD_YIELD_STEP = 0.05;          // resource building: +5% land-resource yield per level
export const STICKER_SELF_BASE = 200;          // stickerShop: sticker self-produced per hour per level (民居模型 faucet)
export const CABINET_CAP_STEP = 0.10;          // cabinet: +10% storage cap per level
export const DRILL_TROOPCAP_STEP = 500;        // drillYard: +500 troopCap per level
export const DRILL_TRAIN_SPEED_STEP = 0.04;    // drillYard: -4% training time per level (floored)
export const DRILL_TRAIN_SPEED_FLOOR = 0.5;    // drillYard: training-time multiplier never below 0.5
export const DRILL_QUEUE_PER_LEVELS = 5;       // drillYard: +1 training queue slot per this many levels
export const BUILD_QUEUE_SLOTS = 1;            // concurrent build-queue slots (paid 2nd slot deferred, §6)
export const BUILD_SPEEDUP_SECS_PER_COIN = 60; // build speedup rate (aligned with TROOP_SPEEDUP_SECS_PER_COIN)
export const BUILD_TIME_BASE_SEC = 120;        // base build time per level; time(toLevel) = base × toLevel
export const DESK_BUILD_TIME_MULT = 5;         // desk upgrades take longer (hub)

/** Per-building base resource cost; buildCost(toLevel) = base × toLevel (DRAFT linear curve). High-tier keys eat graphite + sticker (sink). */
const BUILD_COST_BASE: Readonly<Record<BuildingKey, Partial<Record<ResourceType, number>>>> = {
  desk:         { paper: 2000, graphite: 800, sticker: 500 },
  inkPot:       { paper: 600, ink: 300 },
  paperTray:    { paper: 600 },
  graphiteMill: { paper: 800, graphite: 200 },
  metalForge:   { paper: 800, metal: 300 },
  stickerShop:  { paper: 700, graphite: 200 },
  cabinet:      { paper: 1000, graphite: 400, sticker: 200 },
  drillYard:    { paper: 900, metal: 400, sticker: 200 },
  wall:         { paper: 1200, graphite: 600, metal: 400 },
  academy:      { paper: 1000, graphite: 800, sticker: 400 },
};

/** Current level of a building: desk defaults to 1 (always present), every other building defaults to 0 (unbuilt). */
export function buildingLevel(buildings: Partial<Record<BuildingKey, number>> | undefined, key: BuildingKey): number {
  const lvl = buildings?.[key];
  if (lvl != null) return lvl;
  return key === 'desk' ? 1 : 0;
}
/** Desk (hub) current level. */
export function deskLevel(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return buildingLevel(buildings, 'desk');
}
/** Land-resource hourly-yield multiplier from the matching resource building (1 if none). */
export function buildingYieldMult(buildings: Partial<Record<BuildingKey, number>> | undefined, rt: ResourceType): number {
  for (const key of Object.keys(BUILDING_YIELD_RES) as BuildingKey[]) {
    if (BUILDING_YIELD_RES[key] === rt) return 1 + buildingLevel(buildings, key) * BUILD_YIELD_STEP;
  }
  return 1;
}
/** Home-city self-produced hourly yield for a resource (currently only sticker via stickerShop). */
export function buildingSelfYield(buildings: Partial<Record<BuildingKey, number>> | undefined, rt: ResourceType): number {
  if (rt === 'sticker') return buildingLevel(buildings, 'stickerShop') * STICKER_SELF_BASE;
  return 0;
}
/** Storage cap including cabinet bonus (settleResources cap). */
export function resourceCapFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.floor(RESOURCE_CAP * (1 + buildingLevel(buildings, 'cabinet') * CABINET_CAP_STEP));
}
/** Troop cap including drillYard growth (replaces the static TROOP_CAP_BASE). */
export function troopCapFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return TROOP_CAP_BASE + buildingLevel(buildings, 'drillYard') * DRILL_TROOPCAP_STEP;
}
/** Training-time multiplier from drillYard speed (floored at DRILL_TRAIN_SPEED_FLOOR). */
export function drillTrainMult(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.max(DRILL_TRAIN_SPEED_FLOOR, 1 - buildingLevel(buildings, 'drillYard') * DRILL_TRAIN_SPEED_STEP);
}
/** Training queue slot count including drillYard bonus. */
export function trainQueueMaxFor(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return TROOP_TRAIN_QUEUE_MAX + Math.floor(buildingLevel(buildings, 'drillYard') / DRILL_QUEUE_PER_LEVELS);
}
/** Resource cost to upgrade a building to `toLevel` (only positive entries returned). */
export function buildCost(key: BuildingKey, toLevel: number): Partial<Record<ResourceType, number>> {
  const base = BUILD_COST_BASE[key];
  const lvl = Math.max(1, Math.floor(toLevel));
  const out: Partial<Record<ResourceType, number>> = {};
  for (const rt of RESOURCE_TYPES) {
    const b = base[rt];
    if (b) out[rt] = b * lvl;
  }
  return out;
}
/** Build time (seconds) to upgrade a building to `toLevel` (desk is slower; = coin speedup variable point). */
export function buildTimeSec(key: BuildingKey, toLevel: number): number {
  const lvl = Math.max(1, Math.floor(toLevel));
  const baseT = key === 'desk' ? BUILD_TIME_BASE_SEC * DESK_BUILD_TIME_MULT : BUILD_TIME_BASE_SEC;
  return baseT * lvl;
}
/**
 * Desk gate (SLG_CITY_DESIGN §5 / D-CITY-6): desk grows up to DESK_MAX_LEVEL; every other building's target level must be ≤ current desk level.
 * Returns null if the upgrade is permitted, otherwise a short reason string.
 */
export function buildGateReason(
  buildings: Partial<Record<BuildingKey, number>> | undefined,
  key: BuildingKey,
  toLevel: number,
): string | null {
  if (!BUILDING_KEYS.includes(key)) return 'unknown building';
  if (!Number.isFinite(toLevel) || toLevel < 1) return 'invalid target level';
  if (key === 'desk') return toLevel > DESK_MAX_LEVEL ? 'desk at max level' : null;
  if (toLevel > deskLevel(buildings)) return 'desk level too low';
  return null;
}

// ── P2 building functions (wall / academy / cabinet loot-protect) ───────────────────────────────
/** DRAFT: wall building → +5% garrison HP per level on the defender's main base. */
export const WALL_DEFENSE_STEP = 0.05;
/** DRAFT: academy building → attacker siege-blueprint HP buff per level. */
export const ACADEMY_HP_STEP = 0.02;
/** DRAFT: academy building → attacker siege-blueprint damage buff per level. */
export const ACADEMY_DAMAGE_STEP = 0.015;
/** DRAFT: cabinet building → loot protection rate per level (stacks up to 40% at max). */
export const CABINET_PROTECT_STEP = 0.02;

/** Multiplier applied to defender garrison HP when the defender's main base (type:'base') is besieged (P2, SLG_CITY_DESIGN §5). */
export function wallDefenseMult(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return 1 + buildingLevel(buildings, 'wall') * WALL_DEFENSE_STEP;
}
/** Fraction of looted resources the cabinet protects (cabinetLootProtect × loot = protected, not transferred). */
export function cabinetLootProtect(buildings: Partial<Record<BuildingKey, number>> | undefined): number {
  return Math.min(0.8, buildingLevel(buildings, 'cabinet') * CABINET_PROTECT_STEP);
}
/** Academy seasonal blueprint buffs (HP + damage multiplier bonuses) for the attacker's siege army (P2, SLG_CITY_DESIGN §5). */
export function academyBuff(buildings: Partial<Record<BuildingKey, number>> | undefined): { hp: number; damage: number } {
  const lvl = buildingLevel(buildings, 'academy');
  return { hp: lvl * ACADEMY_HP_STEP, damage: lvl * ACADEMY_DAMAGE_STEP };
}

// ── Nation system (S8-6.5, §2.4) ──────────────────────────────────
/** Number of nations (10 capitals = 10 nations). */
export const NATION_COUNT = 10;
/** Nation bonus: resource production bonus within the player's own Voronoi nation zone (fraction, 0.10 = +10%, §16.5 A7 decision). */
export const NATION_BONUS_PRODUCTION = 0.10;
/** Nation bonus: defense combat bonus within the player's own Voronoi nation zone (fraction, 0.15 = +15%, §16.5 A7 decision). */
export const NATION_BONUS_DEFENSE = 0.15;
/**
 * Relative coordinates of the 10 capitals (fractions 0–1; multiply by mapW-1/mapH-1 to get actual tile coordinates).
 * Layout: 8 on the periphery (4 corners + 4 edge midpoints) + 1 interior offset + 1 central plains (map center).
 * Design doc §2.4: fixed coordinates, hardcoded in shared/slg.ts; Voronoi partitioning is derived from these.
 */
export const CAPITAL_FRACTIONS: readonly [number, number][] = [
  [0.14, 0.14], // 0: northwest corner
  [0.50, 0.10], // 1: due north
  [0.86, 0.14], // 2: northeast corner
  [0.10, 0.50], // 3: due west
  [0.90, 0.50], // 4: due east
  [0.14, 0.86], // 5: southwest corner
  [0.50, 0.90], // 6: due south
  [0.86, 0.86], // 7: southeast corner
  [0.32, 0.32], // 8: inner-ring northwest (ordinary capital)
  [0.50, 0.50], // 9: central plains capital (map center; season bonus objective)
] as const;

/** Convert relative fractional coordinates to actual integer map coordinates. */
export function capitalPositions(mapW: number, mapH: number): [number, number][] {
  return CAPITAL_FRACTIONS.map(([fx, fy]) => [
    Math.round(fx * (mapW - 1)),
    Math.round(fy * (mapH - 1)),
  ]);
}

/** Returns the index of the nearest capital to (x,y) (Voronoi partition, Euclidean distance). */
export function nearestCapitalIdx(
  x: number,
  y: number,
  capitals: readonly [number, number][],
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < capitals.length; i++) {
    const [cx, cy] = capitals[i]!;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Returns the capital index if (x,y) is a capital location, or -1 if it is not a capital. */
export function capitalIdxAt(
  x: number,
  y: number,
  capitals: readonly [number, number][],
): number {
  for (let i = 0; i < capitals.length; i++) {
    const [cx, cy] = capitals[i]!;
    if (cx === x && cy === y) return i;
  }
  return -1;
}

// ── SLG shop items (S8-8, §8) ──────────────────────────────────
export interface SlgShopItem {
  id: string;
  /** Coin price. */
  cost: number;
  kind: 'troop_speedup' | 'resource_pack' | 'protection' | 'battle_pass';
  /** Effect parameters (duration_sec / resource_each / pass_season). */
  effect: Record<string, number | string>;
  description: string;
}

export const SLG_SHOP_ITEMS: readonly SlgShopItem[] = [
  // training speed-ups
  { id: 'slg_speedup_1h',    cost: 200,   kind: 'troop_speedup', effect: { duration_sec: 3600 },  description: 'Speed up training by 1 hour' },
  { id: 'slg_speedup_8h',    cost: 1400,  kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: 'Speed up training by 8 hours' },
  { id: 'slg_speedup_24h',   cost: 3600,  kind: 'troop_speedup', effect: { duration_sec: 86400 }, description: 'Speed up training by 24 hours' },
  // resource packs (equal amounts of every season resource)
  { id: 'slg_res_s',  cost: 300,   kind: 'resource_pack', effect: { each: 20000 },  description: 'Small resource pack (20k each)' },
  { id: 'slg_res_m',  cost: 1000,  kind: 'resource_pack', effect: { each: 80000 },  description: 'Medium resource pack (80k each)' },
  { id: 'slg_res_l',  cost: 3000,  kind: 'resource_pack', effect: { each: 200000 }, description: 'Large resource pack (200k each)' },
  // protection shields
  { id: 'slg_shield_8h',  cost: 500,  kind: 'protection', effect: { duration_sec: 28800 }, description: 'Capital protection shield 8 hours' },
  { id: 'slg_shield_24h', cost: 1200, kind: 'protection', effect: { duration_sec: 86400 }, description: 'Capital protection shield 24 hours' },
  // season battle pass
  { id: 'slg_battle_pass', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: 'Season battle pass (valid for current season)' },
] as const;

// ── Prosperity (G2 / §8.1 / SLG_DESIGN §17.1) ────────────────────
/** Prosperity score weights (DRAFT; register in ECONOMY_NUMBERS §13-SLG). */
export const PROSPERITY_W_TERRITORY = 10;   // per territory tile
export const PROSPERITY_W_MEMBER    = 50;   // per member
export const PROSPERITY_W_ACTIVITY  = 5;    // per point of season activity (new occupations + battles, source §17.4)
/** Inactivity decay: fraction decayed per calendar day (settled lazily at read time, analogous to resource yield). */
export const PROSPERITY_DECAY_PER_DAY = 0.05; // 5%/day
/** Minimum prosperity to found a sect (§8.2, §16.5 A7 decision): 30 members + 30 tiles = 1800 base, plus some activity required. */
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
/** Per-tier rewards (material items / skins / titleId). Placeholder values pending economic simulation. */
export interface SettleReward {
  items: Record<string, number>;     // materials: { scrap: N, lead: M, binding: K }
  skins: string[];                   // skin ids (limited edition)
  titleId?: string;                  // title (grantTitle TODO S10; this round: email body only)
  coins?: number;                    // optional coins (must be included in the overall economic budget, OVERVIEW §3.3)
}
export const SETTLE_REWARDS: Record<SettleTier, SettleReward> = {
  champion:    { items: { scrap: 500, lead: 200, binding: 50 }, skins: ['slg_champion_frame'], titleId: 'slg.champion', coins: 0 },
  top3:        { items: { scrap: 300, lead: 120, binding: 25 }, skins: [], titleId: 'slg.top3' },
  top10:       { items: { scrap: 150, lead: 60,  binding: 10 }, skins: [] },
  participant: { items: { scrap: 50,  lead: 20,  binding: 0  }, skins: [] },
};
/** Battle-pass resource production multiplier (S8-8): hourly yield ×BP_YIELD_MULT for holders. Applied in recomputeYield after all other multipliers. */
export const BP_YIELD_MULT = 1.1;
/** Extra settlement reward dispatched to every battle-pass holder at season end, regardless of tier (S8-8). */
export const BP_SETTLE_EXTRA: Readonly<{ items: Record<string, number>; skins: string[] }> = {
  items: { scrap: 50, lead: 20, binding: 5 },
  skins: [],
};
/** Central plains capital (capitalIdx 9, §2.4) occupation bonus: reward materials for the tier are multiplied by CENTER_CAPITAL_MULT. */
export const CENTER_CAPITAL_IDX = 9;
export const CENTER_CAPITAL_MULT = 2;

// ── G6 multi-shard allocation (data foundation + pure algorithm; runtime deferred, §17.8) ─────
/** Capacity per shard (default value for openSeason capacity; replaces hard-coded value). */
export const WORLD_CAPACITY = 10000;
/** Batch size for bulk deletes during resetSeason (§17.6). */
export const RESET_DELETE_BATCH = 2000;

/** "Overall strength" input for a sect (sourced from last season's seasonResults + current size/prosperity). */
export interface SectStrength {
  sectId: string;
  lastSeasonRank?: number;   // last season's rank (absent = new sect)
  memberFamilyCount: number;
  prosperity: number;        // current aggregated prosperity
}
/** Strength score (higher = stronger): primarily based on historical rank (lower rank number = stronger), with size/prosperity as secondary factors. DRAFT weights. */
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

// ── Deterministic noise (pure functions, no random source; same input → same output) ─────────────
/** 32-bit integer hash (two coordinates + seed → uint32). */
function hash2(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
/** Coordinates → pseudo-random value in [0,1). */
function rand2(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}
/** String → 32-bit seed (worldId → world seed). */
export function worldSeed(world: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < world.length; i++) {
    h ^= world.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Value noise (bilinear interpolation + smoothstep), output [0,1], continuous and smooth — used for biome/level large-zone generation. */
function valueNoise(x: number, y: number, freq: number, seed: number): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = (t: number) => t * t * (3 - 2 * t); // smoothstep
  const v00 = rand2(x0, y0, seed);
  const v10 = rand2(x0 + 1, y0, seed);
  const v01 = rand2(x0, y0 + 1, seed);
  const v11 = rand2(x0 + 1, y0 + 1, seed);
  const sx = s(tx);
  const sy = s(ty);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

// ── Procedural map generation (core, §14.2 / U2 / U6 initial version) ──────────────
/** Default attributes for a procedural tile (in an unclaimed neutral world). Once claimed at runtime, the DB document takes precedence. */
export interface ProceduralTile {
  type: TileType;
  /** Resource/tile level 1..SLG_MAP_MAX_LEVEL (higher = more yield and stronger default NPC garrison). */
  level: number;
  /** Resource type (only present for resource / familyKeep tiles). */
  resType?: ResourceType;
}

/**
 * Biome: low-frequency noise divides the map into four large land-resource zones (ink/paper/graphite/metal), encouraging resource
 * specialization and cross-zone trade (geographic foundation for the U1 auction economy). graphite is the 4th land resource (ADR-022);
 * `sticker` is never biome-generated (home-city self-produced).
 */
function biomeAt(x: number, y: number, seed: number): ResourceType {
  const n = valueNoise(x, y, SLG_GEN.biomeFreq, seed ^ 0x0444);
  if (n < SLG_GEN.biomeInkMax) return 'ink';
  if (n < SLG_GEN.biomePaperMax) return 'paper';
  if (n < SLG_GEN.biomeGraphiteMax) return 'graphite';
  return 'metal';
}

/**
 * Computes the procedural default tile for (worldId, x, y). Pure function, deterministic, never persisted.
 * Distribution rules (U6 + S8-6.6): unique center tile at the map center; blocking terrain (mountains/rivers) + gates embedded in blocking zones;
 * level decreases from center to edge; sparse familyKeep strategic points; remaining tiles are classified as resource or neutral by density.
 */
export function proceduralTile(world: string, x: number, y: number): ProceduralTile {
  const seed = worldSeed(world);
  const cx = SLG_MAP_W / 2;
  const cy = SLG_MAP_H / 2;

  // world center (unique)
  if (x === Math.floor(cx) && y === Math.floor(cy)) {
    return { type: 'center', level: SLG_MAP_MAX_LEVEL };
  }

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const dr = dist / maxDist; // 0 = center .. 1 = corner

  // ── Blocking terrain + gates (S8-6.6) ────────────────────────────────
  // Only generated in the central region where dr ≤ obstacleMaxDr; outer plains (corners) remain obstacle-free to ensure player starting zones are passable.
  if (dr <= SLG_GEN.obstacleMaxDr) {
    const obstNoise = valueNoise(x, y, SLG_GEN.obstacleFreq, seed ^ 0x0888);
    if (obstNoise > SLG_GEN.obstacleThreshold) {
      // Gate: high-peak location within the blocking zone (strategic corridor) — even sparser than obstacles.
      const gateNoise = valueNoise(x, y, SLG_GEN.gateFreq, seed ^ 0x0999);
      if (gateNoise > SLG_GEN.gateThreshold) {
        return { type: 'gate', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) };
      }
      return { type: 'obstacle', level: 1 };
    }
  }

  // Level: high at center → low at edge (dominated by (1-dr)) + medium-frequency noise perturbation
  const lvlNoise = valueNoise(x, y, SLG_GEN.levelFreq, seed ^ 0x0111);
  let level = Math.round((1 - dr) * (SLG_MAP_MAX_LEVEL - 1) + 1 + (lvlNoise - 0.5) * 1.5);
  level = Math.max(1, Math.min(SLG_MAP_MAX_LEVEL, level));

  // Stronghold (G8 §3.1): extremely sparse high-strategic-value PvE tiles, guarded by overwhelmingly powerful system NPCs, only beyond a minimum distance from the center.
  // Sparser than familyKeep, always max level, has a resource type (rich yield after conquest). Evaluated before familyKeep (higher priority).
  const strongholdNoise = valueNoise(x, y, SLG_GEN.strongholdFreq, seed ^ 0x0555);
  if (strongholdNoise > SLG_GEN.strongholdThreshold && dr > SLG_GEN.strongholdMinDistRatio) {
    return { type: 'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(x, y, seed) };
  }

  // Strategic point / family stronghold: sparse high-peak, only beyond a minimum distance from center
  const keepNoise = valueNoise(x, y, SLG_GEN.keepFreq, seed ^ 0x0222);
  if (keepNoise > SLG_GEN.keepThreshold && dr > SLG_GEN.keepMinDistRatio) {
    return {
      type: 'familyKeep',
      level: Math.max(level, SLG_MAP_MAX_LEVEL - 1),
      resType: biomeAt(x, y, seed),
    };
  }

  // Resource tile vs neutral open land
  const occ = rand2(x, y, seed ^ 0x0333);
  if (occ < SLG_GEN.resourceDensity) {
    return { type: 'resource', level, resType: biomeAt(x, y, seed) };
  }
  return { type: 'neutral', level: Math.min(level, SLG_GEN.neutralLevelCap) };
}

// ── Territory yield (S8-1; per-tile contribution to lazy resource settlement, §14.3) ────────────
/**
 * Per-tile hourly yield (added to `playerWorld.yieldRate` after claiming). Pure function.
 * - `base` (home city): provides a starting ink trickle (`RESOURCE_YIELD_BASE`), ensuring new players always have yield to settle.
 * - Tiles with a `resType` (resource / familyKeep / territory after claiming): yield the corresponding resource at `RESOURCE_YIELD_BASE × level`.
 * - All others (neutral/territory without resType): no yield.
 */
export function tileYield(
  type: TileType,
  level: number,
  resType?: ResourceType,
): Partial<Record<ResourceType, number>> {
  if (type === 'base') return { ink: RESOURCE_YIELD_BASE };
  if (resType) return { [resType]: RESOURCE_YIELD_BASE * Math.max(1, level) };
  return {};
}

// ── March (S8-2, §14.4/§4) ────────────────────────────────
/**
 * March duration (seconds): Euclidean distance (ceiling) × MARCH_SPEED_SEC_PER_TILE; minimum 1 tile.
 * Pure function, computable on either end (client estimates ETA / server authoritatively sets arriveAt). Same-tile (distance 0) costs 1 tile.
 */
export function marchDurationSec(fx: number, fy: number, tx: number, ty: number): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const tiles = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  return tiles * MARCH_SPEED_SEC_PER_TILE;
}

// ── A* march pathfinding (S8-6.6, §4 "march pathfinding") ──────────────────────────
// 4-directional A* (up/down/left/right, no diagonals), Manhattan distance heuristic.
// Obstacle tiles are impassable; unoccupied gates are treated as obstacles ("unoccupied = obstacle");
// occupied gates are passable only by the occupying faction / allies (passableGateKeys is pre-fetched from the DB by the caller).

/** March path node. */
export interface PathCell {
  x: number;
  y: number;
}

/**
 * A* pathfinding from (fx,fy) to (tx,ty).
 * - Returns the full path (including start and end); returns a single node [{fx,fy}] for same-tile.
 * - Returns null if the destination is unreachable (obstacle / no path / out of bounds).
 * - passableGateKeys: set of gate tile keys that can be traversed (format "x:y"); the destination gate itself is always reachable regardless of passage rights.
 * - MAX_NODES safety cap (prevents worst-case on very large maps).
 */
export function findMarchPath(
  world: string,
  mapW: number,
  mapH: number,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  passableGateKeys: ReadonlySet<string>,
): PathCell[] | null {
  if (fx === tx && fy === ty) return [{ x: fx, y: fy }];
  if (!_slgInBounds(fx, fy, mapW, mapH) || !_slgInBounds(tx, ty, mapW, mapH)) return null;

  const walkable = (x: number, y: number, isDest: boolean): boolean => {
    if (!_slgInBounds(x, y, mapW, mapH)) return false;
    const p = proceduralTile(world, x, y);
    if (p.type === 'obstacle') return false; // obstacles always block, including the destination tile
    if (p.type === 'gate') return isDest || passableGateKeys.has(`${x}:${y}`);
    return true;
  };

  if (!walkable(tx, ty, true)) return null; // destination tile is an obstacle

  const MAX_NODES = 500_000;
  // g: shortest step count from start to this node; par: parent node flat index (for path reconstruction)
  const g = new Map<number, number>();
  const par = new Map<number, number>();
  // open set: min-heap, elements = [f, flatIdx]
  const heap: [number, number][] = [];

  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  const si = fy * mapW + fx;
  g.set(si, 0);
  _slgHeapPush(heap, [h(fx, fy), si]);

  const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const closed = new Set<number>();
  let explored = 0;

  while (heap.length > 0) {
    const [, cur] = _slgHeapPop(heap)!;
    if (closed.has(cur)) continue;
    closed.add(cur);

    const cx = cur % mapW;
    const cy = (cur / mapW) | 0;
    if (cx === tx && cy === ty) return _slgReconstructPath(par, mapW, si, cur);
    if (++explored > MAX_NODES) break;

    const cg = g.get(cur)!;
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      const isDest = nx === tx && ny === ty;
      if (!walkable(nx, ny, isDest)) continue;
      const ni = ny * mapW + nx;
      const ng = cg + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        par.set(ni, cur);
        _slgHeapPush(heap, [ng + h(nx, ny), ni]);
      }
    }
  }
  return null;
}

/** March path → duration (seconds): (path.length-1) steps × MARCH_SPEED_SEC_PER_TILE. */
export function marchDurationFromPath(path: PathCell[]): number {
  return Math.max(0, path.length - 1) * MARCH_SPEED_SEC_PER_TILE;
}

function _slgInBounds(x: number, y: number, mapW: number, mapH: number): boolean {
  return x >= 0 && y >= 0 && x < mapW && y < mapH;
}

function _slgReconstructPath(par: Map<number, number>, mapW: number, start: number, end: number): PathCell[] {
  const path: PathCell[] = [];
  let cur = end;
  while (cur !== start) {
    path.push({ x: cur % mapW, y: (cur / mapW) | 0 });
    cur = par.get(cur)!;
  }
  path.push({ x: start % mapW, y: (start / mapW) | 0 });
  return path.reverse();
}

function _slgHeapPush(heap: [number, number][], item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pi = heap[p]!; const ii = heap[i]!;
    if (pi[0] <= ii[0]) break;
    heap[p] = ii; heap[i] = pi;
    i = p;
  }
}

function _slgHeapPop(heap: [number, number][]): [number, number] | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
      if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
      if (m === i) break;
      const tmp = heap[i]!; heap[i] = heap[m]!; heap[m] = tmp;
      i = m;
    }
  }
  return top;
}

// ── Siege settlement (S8-3, §5.3) ────────────────────────────────
// worldsvc does not import the deterministic engine (M12); this **cheap linear numeric settlement** is used at arrival time to immediately resolve siege outcomes
// (territory transfer / home-city looting / NPC sweep); this is the design-sanctioned "non-critical / cheap numeric settlement" path (§5.3).
// The engine-replay path for "critical battles" (real player vs. player city assault) (buildSiegeBlueprints + judgeRunner siege branch) is already
// implemented and unit-tested on the client; S8-3b wires this in via worldsvc→gateway /gw/judge to replace the cheap settlement.

/** NPC garrison strength for neutral / resource tiles (defensive strength for the sweep march kind; linear by tile level). */
export const NPC_GARRISON_PER_LEVEL = 120;
/** Fraction of the target's resources looted on a successful siege (transferred from the defeated side to the attacker on territory transfer / home-city looting). */
export const SIEGE_LOOT_RATE = 0.25;
/** One-time resource captured from an NPC tile on a successful sweep (per tile level, per resource type). */
export const SWEEP_LOOT_PER_LEVEL = 200;

/** NPC garrison for a single tile (sweep defensive strength). */
export function npcGarrison(level: number): number {
  return NPC_GARRISON_PER_LEVEL * Math.max(1, level);
}

// ── G8 stronghold (§3.1) values (DRAFT; tune after launch) ────────────
/**
 * Stronghold system NPC garrison strength per level (max level 5 → 1800 troop equivalent). Far stronger than ordinary tile garrison (GARRISON_PER_TILE=500)
 * and sweep NPCs (NPC_GARRISON_PER_LEVEL=120); "extremely hard to conquer" (§3.1): with basic infantry, even a fully-loaded free-to-play player
 * (TROOP_CAP_BASE=2000) will nearly always lose due to the defender advantage (base + timeout = defender wins); conquering requires tech/equipment progression to strengthen the army lineup
 * (delivering on SLG7 selling combat power / U7 overwhelming tier). Max-level 1800 ÷ unit full HP ≈ 60 units (depth ~6 rows), plus attacker
 * ≤2000 troops ≈ 67 units (depth ~7 rows), total < 16-row board depth → normal-scale authoritative engine can run without falling back to the cheap fallback;
 * only whale-tier armies (>5000 troops) overflow the board and trigger the fallback.
 */
export const STRONGHOLD_GARRISON_PER_LEVEL = 360;
/** Stronghold system garrison (linear by tile level; §3.1 overwhelmingly strong default defensive config). */
export function strongholdGarrison(level: number): number {
  return STRONGHOLD_GARRISON_PER_LEVEL * Math.max(1, level);
}
/** One-time resource reward on stronghold conquest (per tile level, per resource type; §3.1 "large resource yield"). */
export const STRONGHOLD_LOOT_PER_LEVEL = 5000;

/**
 * Additional progression material drop on stronghold conquest (§19.5 "unified with G4 progression material flow"): single rare material `binding`
 * (gates rare/epic equipment; scarce through normal map routes), linear by tile level, delivered to SaveData.materials unified progression pool
 * (not a season resource; persists across seasons, SLG4). **DRAFT [tunable]**: quantity pending economic simulation (§16.5 same batch).
 */
export const STRONGHOLD_LOOT_MATERIAL = 'binding';
export const STRONGHOLD_LOOT_MATERIAL_PER_LEVEL = 4;
/** Stronghold material drop (pure function, computable on either end): {material, qty}; qty is linear by tile level. */
export function strongholdMaterialLoot(level: number): { material: string; qty: number } {
  return { material: STRONGHOLD_LOOT_MATERIAL, qty: STRONGHOLD_LOOT_MATERIAL_PER_LEVEL * Math.max(1, level) };
}

export interface SiegeResolution {
  outcome: SiegeOutcome;
  /** Attacker surviving troops (on attacker_win, can become new garrison or return; on defender_win = 0, wiped out). */
  attackerSurvivors: number;
  /** Defender surviving troops (on defender_win, remaining garrison; on attacker_win = 0). */
  defenderSurvivors: number;
}

/**
 * Linear (Lanchester-lite) siege settlement: if attacker troops > defender strength → attacker wins, survivors = difference;
 * otherwise defender wins (ties go to defender, consistent with "defender advantage"). Pure function, deterministic, computable on either end.
 */
export function resolveSiege(attackerTroops: number, defenseStrength: number): SiegeResolution {
  const atk = Math.max(0, Math.floor(attackerTroops));
  const def = Math.max(0, Math.floor(defenseStrength));
  if (atk > def) {
    return { outcome: 'attacker_win', attackerSurvivors: atk - def, defenderSurvivors: 0 };
  }
  return { outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: def - atk };
}

/**
 * Nation defense bonus (S8-6.5 / §2.4): when the defending garrison is within the Voronoi zone of a capital controlled by the defender's nation,
 * effective defense strength is ×(1+NATION_BONUS_DEFENSE); otherwise unchanged. Pure function, deterministic, integer result, computable on either end.
 */
export function nationDefenseStrength(garrison: number, inOwnNation: boolean): number {
  const g = Math.max(0, Math.floor(garrison));
  return inOwnNation ? Math.floor(g * (1 + NATION_BONUS_DEFENSE)) : g;
}

// ── Vision / fog of war (G5, §8.2 / §2.1 / §15.2) ─────────────────────────────────────
// Decision (2026-06-21): fog model 2a — terrain layer (procedural, deterministic) is always fully visible;
// dynamic layer (ownership / garrison / defense / protection shield / marches) is only shown within "current vision";
// tiles outside vision revert to the base terrain from proceduralTile (not even "this tile is occupied" is leaked).
// Vision is not persisted: computed live from vision sources at read time + short TTL cache.
// Vision sources = own territory (radius VISION_TERRITORY) + home city (radius VISION_BASE) + own/family marches in transit
// (radius VISION_MARCH, position linearly interpolated from departAt/arriveAt) + same-family member territories (shared, ≤30 members;
// §8.2 decision: downgraded to family-level rather than sect-level, to avoid 900-person union making fog of war meaningless). Vision shape uses Chebyshev
// (square) distance — simplest on a tile grid, computable on either end.

/** Own territory vision radius (Chebyshev, DRAFT). */
export const VISION_TERRITORY_RADIUS = 2;
/** Home city vision radius (larger than territory, DRAFT). */
export const VISION_BASE_RADIUS = 5;
/** In-transit march vision radius (source of scouting march value, DRAFT). */
export const VISION_MARCH_RADIUS = 2;
/**
 * Scout march (scout kind) vision radius (G5 V2 remaining item, DRAFT). Larger than ordinary marches — the value of scouting is
 * "seeing deeper": no combat, no occupation; send a small force to any non-obstacle tile, lighting up a larger vision area along the route and at the destination, then auto-return.
 */
export const VISION_SCOUT_RADIUS = 4;
/**
 * Watchtower vision radius (§18 G5 V2 remaining item, DRAFT). The largest fixed persistent vision source — farther than the home city (5);
 * building a tower on own territory upgrades that tile to a large-radius observation point, illuminating a deep area — the primary mechanism for proactively expanding vision.
 */
export const VISION_WATCHTOWER_RADIUS = 8;
/** Maximum radius across all vision sources (used as query pad for outward expansion; must cover the largest-radius source to avoid missing vision zone edges). */
export const VISION_MAX_RADIUS = Math.max(
  VISION_TERRITORY_RADIUS,
  VISION_BASE_RADIUS,
  VISION_MARCH_RADIUS,
  VISION_SCOUT_RADIUS,
  VISION_WATCHTOWER_RADIUS,
);

/** Vision source: a center point + radius (Chebyshev). */
export interface VisionSource {
  x: number;
  y: number;
  radius: number;
}

/**
 * Whether tile (x,y) falls within the Chebyshev radius of any vision source. Pure function, computable on either end.
 * The number of sources is bounded within the view area (own/family territory + home city + marches in transit); per-tile call cost is acceptable.
 */
export function isInVision(sources: readonly VisionSource[], x: number, y: number): boolean {
  for (const s of sources) {
    if (Math.abs(x - s.x) <= s.radius && Math.abs(y - s.y) <= s.radius) return true;
  }
  return false;
}

/**
 * Current march position (linear interpolation from fromTile to toTile; used for G5 vision — approximate since the actual path may detour around obstacles, but sufficient for vision circles).
 * frac is clamped to [0,1] from (now-departAt)/(arriveAt-departAt); degenerate case (arriveAt≤departAt) returns the destination.
 */
export function marchInterpPos(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  departAt: number,
  arriveAt: number,
  now: number,
): { x: number; y: number } {
  const span = arriveAt - departAt;
  const frac = span > 0 ? Math.max(0, Math.min(1, (now - departAt) / span)) : 1;
  return {
    x: Math.round(fromX + (toX - fromX) * frac),
    y: Math.round(fromY + (toY - fromY) * frac),
  };
}

// ── Playable siege defense level (S8-3b / C2) ─────────────────────────────────────────────
// Normalizes the stored defense config (DefenseConfig subset: garrison/defenderBuildings/defenderBaseLevel) into a
// complete LevelDefinition-shaped object "ready for the attacker to play" (objective=destroy_base, no scripted waves).
// The client uses it for live play / replay in GameScene siege mode; worldsvc re-computation (resolveSiegeWithJudge) uses the same object as
// the judge's defenseJson — both ends must be byte-for-byte identical for deterministic re-computation, hence centralized here as single source of truth.

/** Derives a deterministic seed from siegeId (FNV-1a 32-bit); shared by the siege level and re-computation. */
export function siegeSeedFromId(sid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sid.length; i++) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clampBaseLevel(n: number): number {
  return Math.max(0, Math.min(3, Math.floor(n) || 0));
}

/**
 * Siege battle hard time limit (ticks, §16.5 A7 decision): 10 minutes of game time × 60 × 30 Hz = 18000 ticks.
 * If both bases survive the timeout → defender wins (defender advantage) + headless re-computation compute budget cap.
 */
export const SIEGE_BATTLE_TIMEOUT_TICKS = 10 * 60 * 30;

/**
 * Overwhelming-tier cheap settlement ratio (§14.10 U7, §16.5 A7 decision): when attacker troops / effective defender garrison ≥ this value,
 * skip the deterministic engine and go directly to the cheap linear resolveSiege (outcome is guaranteed attacker_win; saves compute).
 * 10 corresponds to "attacker has 10× garrison" — under Lanchester linear, the gap is so large the outcome is nearly certain.
 * U7 "100:1 fully-equipped overwhelming" is the extreme upper bound; 10:1 is already safe enough to skip the engine.
 */
export const SIEGE_CHEAP_RATIO = 10;

/** Maximum number of attack lineup templates (teams) (§16.2; initial phase: 5 = number of saveable templates + concurrency cap). */
export const SIEGE_TEAM_CAP = 5;

// ── CC-3: card-based SLG troop system (CHARACTER_CARDS_DESIGN §6/§7/§8) ────────────────────

/** Maximum number of card instances per attack team (CHARACTER_CARDS_DESIGN §8.2). */
export const CARD_TEAM_MAX_SIZE = 12;

/** Initial baseTroopStock granted to a player when they first join a world season (CHARACTER_CARDS_DESIGN §6.5). */
export const BASE_TROOP_STOCK_INITIAL = 10_000;

/** Minimum surviving troop fraction when a card's HP reaches zero in battle (baseSurvival, CHARACTER_CARDS_DESIGN §7.1). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_BASE_SURVIVAL = 0.2;

/** Injury lock duration (ms) applied when a card's HP reaches zero in battle (CHARACTER_CARDS_DESIGN §7.2). */
export const CARD_INJURY_DURATION_MS = 5 * 60 * 1000;

/** Coins required for immediate card injury recovery (CHARACTER_CARDS_DESIGN §7.2). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_RECOVER_COIN_COST = 50;

/** Fraction of training resources refunded when a card is removed from a team (CHARACTER_CARDS_DESIGN §6.3). */
export const CARD_TROOP_REFUND_RATE = 0.8;
/** Paper cost per card troop trained into baseTroopStock (粮, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_PAPER_COST = 2;
/** Graphite cost per card troop (木材, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_GRAPHITE_COST = 2;
/** Metal cost per card troop (铁, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_METAL_COST = 1;

// ── Per-unit troop slider (§16.5 A7 tuning) ────────────────────────────────────────────
/**
 * Minimum HP fraction per unit in the lineup editor (§16.5): at least 25% of the blueprint's full HP must be assigned,
 * ensuring every unit contributes meaningful damage output and preventing the "1HP tile-filler abuse" exploit. The editor rounds this value up (≥1).
 */
export const SIEGE_UNIT_HP_MIN_FRACTION = 0.25;
/**
 * Number of HP steps per unit in the lineup editor (§16.5): 4 tiers (25% / 50% / 75% / 100%).
 * Each click on a tile cycles through the tiers; committed troops = sum of all unit HP values.
 */
export const SIEGE_UNIT_HP_STEPS = 4;

/**
 * Normalizes a defense config into a complete siege level object. `config` is the defender's customization (nullable); `tileLevel` is used to
 * derive a symbolic base-level defense when no customization is provided. Returns an object shaped like the client's LevelDefinition (loose object; avoids duplicating the engine schema in shared).
 * Pure function, deterministic, computable on either end.
 */
export function buildSiegeLevel(
  config: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
): Record<string, unknown> {
  const level: Record<string, unknown> = {
    id: `siege:${seed}`,
    chapter: 0,
    seed,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
  };
  if (config) {
    if (Array.isArray(config.garrison) && config.garrison.length > 0) level.garrison = config.garrison;
    if (Array.isArray(config.defenderBuildings) && config.defenderBuildings.length > 0) {
      level.defenderBuildings = config.defenderBuildings;
    }
    if (typeof config.defenderBaseLevel === 'number') {
      level.defenderBaseLevel = clampBaseLevel(config.defenderBaseLevel);
    }
  } else {
    // No custom defense → derive a symbolic base defense from tile level (deterministic; attacker wins by destroying the base).
    level.defenderBaseLevel = clampBaseLevel(Math.floor(tileLevel) - 1);
  }
  return level;
}

/**
 * Siege auto-battle level (G3-2a, §16.3): extends {@link buildSiegeLevel} (defender lineup + dual bases +
 * objective:destroy_base) with the **attacker's pre-deployed army** (`attackerArmy`, owner0 in the bottom half) +
 * **hard battle time limit** (`battleTimeoutTicks`; timeout = defender wins). No live commands → battle outcome is
 * uniquely determined by `seed + both lineups` (worldsvc runs authoritatively headless; client replays with the same seed for spectating).
 *
 * Pure function, deterministic, computable on either end. Returns a loose object shaped like the client's LevelDefinition
 * (including attackerArmy / battleTimeoutTicks, validated by levelSchema).
 *
 * @param attacker Attacker lineup (`army` = GarrisonEntry[]; each unit has initialHp = allocated troops).
 * @param defender Defender config (garrison / defenderBuildings / defenderBaseLevel); same as buildSiegeLevel.
 * @param tileLevel Used to derive a symbolic base level when no defender customization is present.
 * @param seed Level seed (same seed for siege + re-computation/replay; ensures consistency).
 * @param battleTimeoutTicks Hard battle time limit; defaults to {@link SIEGE_BATTLE_TIMEOUT_TICKS}.
 */
export function buildSiegeBattle(
  attacker: { army?: unknown } | null | undefined,
  defender: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
  battleTimeoutTicks: number = SIEGE_BATTLE_TIMEOUT_TICKS,
): Record<string, unknown> {
  // Reuse the defender normalization (dual bases + destroy_base already included); then layer on the attacker army + time limit.
  const level = buildSiegeLevel(defender, tileLevel, seed);
  level.battleTimeoutTicks = Math.max(1, Math.floor(battleTimeoutTicks));
  if (attacker && Array.isArray(attacker.army) && attacker.army.length > 0) {
    level.attackerArmy = attacker.army;
  }
  return level;
}

// ── Error codes: see the SLG range in api.ts ErrorCode (WORLD_FULL/TILE_OCCUPIED/…) ──
