// SLG core: error type, enums, deterministic ID derivation, capacity/map dimensions, main-base footprint,
// procedural distribution knobs, and general numeric constants — single source of truth (SLG_DESIGN.md §14, S8-0).
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).
// Pure data + pure functions; no DB / no PIXI. worldsvc uses this as the authoritative server-side source for maps/territory/marches/families.
//
// ★ Procedural generation (§14.2 "sparse storage + procedural defaults"): the DB only stores tiles that have been claimed or modified.
//   Untouched neutral tiles are computed on-the-fly by the pure function proceduralTile() derived from worldId — never persisted; this is the key to scalability.
//   The same worldId + the same (x,y) always yields the same tile (computable on either end).

import { ErrorCode, type ErrorCode as ErrorCodeT } from '../api';

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
  | 'bridge' // capturable river crossing (bridge): passable by the occupying faction & allies, treated as obstacle if unoccupied; siege target with an NPC garrison (ADR gate→bridge/plankway migration)
  | 'plankway' // capturable mountain crossing (plankway): same passage/siege semantics as `bridge` but spans mountain obstacle instead of river
  | 'stronghold'; // stronghold (G8 §3.1): high-strategic-value tile guarded by an overwhelmingly powerful system NPC; cannot be directly occupied — must be conquered via a siege attack

/**
 * SLG season resources (SLG_DESIGN §3.4, naming locked 2026-06-30; stationery theme, aligned with Three-Kingdoms grain/wood/stone/iron/copper).
 * - ink:      sustain — troop training / troop cap / march upkeep (was `food`). Shares the "ink is life" world-symbol with battle `ink` but is a fully separate pool.
 * - paper:    basic building material (was `wood`).
 * - graphite: advanced building material (4th land resource; map faucet via biomeAt's provincial-bias per-tile draw, sink via high-level building upgrades, SLG_CITY_DESIGN / ADR-022).
 * - metal:    military / equipment forging (was `iron`).
 * - sticker:  universal flexible resource (copper-coin slot: recruit / tech / small instant actions). NOT a global currency — season-scoped, cleared at season end, non-auctionable, not directly purchasable. Faucet = level-gated copper-mine map tiles (`resource` tiles at level ≥ SLG_GEN.copperMinLevel, Three-Kingdoms-Strategy rule) + home-city stickerShop self-production (residential-model); sink = building upgrades.
 * All five are season resources (cleared at season end, banned from the auction house); the only global currency is `coins` (ECONOMY_BALANCE).
 */
export type ResourceType = 'ink' | 'paper' | 'graphite' | 'metal' | 'sticker';
/**
 * River vs mountain: both are fully impassable `obstacle` tiles (ADR-034 §2.2 "both are fully impassable terrain"),
 * so this NEVER affects gameplay/pathfinding — it only tags which hand-drawn doodle (terrain_river vs
 * terrain_mountain) the tile renders with, so a painted/generated river reads as a river instead of the
 * old position-hash coin-flip between the two art variants. Optional: when absent, renderers fall back to
 * the deterministic per-tile hash (procedurally-generated obstacles that predate this tag stay unchanged).
 */
export type ObstacleKind = 'river' | 'mountain';
// 'move' (S8-2 relocate, 2026-07-23): send a team to an own tile or an empty neutral tile with NO combat;
// on arrival the team STANDS on the tile (stationed, idle) instead of vanishing — the "idle out in the field"
// half of the team lifecycle (the other being "idle at home"). Distinct from reinforce (which dumps troops
// into a tile's faceless garrison stat and frees the team) — a move keeps the whole team parked on the tile.
export type MarchKind = 'attack' | 'reinforce' | 'occupy' | 'sweep' | 'scout' | 'return' | 'move';
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
 * Map dimensions (ADR-032; enlarged 500→1500 on 2026-07-22): 1500×1500 (2.25M tiles), matching the scale
 * common to mainstream SLG titles so the 10-province ring layout + PvE stronghold/capital content has room to
 * breathe (the old 500×500 read as only ~3 screens at the coarsest zoom and left no headroom for the province spread).
 * Everything downstream is ratio-based off these dims (province rings, capital positions, resource/stronghold
 * density via per-tile Bernoulli), so all content scales proportionally — density is preserved, only the canvas grows.
 * Sparse storage: dimensions only affect the pace of expansion and the feel of march distances; they do not affect
 * storage (only occupied tiles are persisted) and there is no full-map iteration hotspot (vision/render are viewport-
 * bounded Mongo queries + on-demand proceduralTile).
 */
export const SLG_MAP_W = 1500;
export const SLG_MAP_H = 1500;
/** Tile level cap (ADR-032): aligned with Three Kingdoms Strategy Edition's real land-level cap (see SGZ_LAND_REFERENCE.md). */
export const SLG_MAP_MAX_LEVEL = 10;

// ── Main-base 3×3 footprint (ADR-025) ─────────────────────────────────────────
// The player home city is a real multi-tile building occupying a 3×3 block centered on its
// anchor (PlayerWorldDoc.mainBaseTile). All 9 cells are written as type:'base' with the same
// ownerId — indivisible (an enemy cannot occupy/abandon a single corner), block enemy marches
// (§ findMarchPath blockedBaseKeys), and all count toward territory/prosperity.
/** Base footprint side length (3 → 3×3 = 9 cells). */
export const BASE_FOOTPRINT = 3;
/** Half-extent: the anchor spans ±this on each axis (1 for a 3×3 footprint). */
export const BASE_FOOTPRINT_R = (BASE_FOOTPRINT - 1) / 2;

/** All tile coordinates a base anchored (centered) at (ax,ay) occupies — BASE_FOOTPRINT² cells. */
export function baseFootprintCells(ax: number, ay: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let dy = -BASE_FOOTPRINT_R; dy <= BASE_FOOTPRINT_R; dy++) {
    for (let dx = -BASE_FOOTPRINT_R; dx <= BASE_FOOTPRINT_R; dx++) {
      cells.push({ x: ax + dx, y: ay + dy });
    }
  }
  return cells;
}

/** True if the whole 3×3 block anchored at (ax,ay) fits inside [0,mapW) × [0,mapH). */
export function baseFootprintInBounds(ax: number, ay: number, mapW: number, mapH: number): boolean {
  return ax - BASE_FOOTPRINT_R >= 0 && ay - BASE_FOOTPRINT_R >= 0
      && ax + BASE_FOOTPRINT_R < mapW && ay + BASE_FOOTPRINT_R < mapH;
}

// ── City size + art tiering (ADR-034 §3 + 2026-07-06 user decision) ─────────────
// A city's LEVEL (1..10) drives two orthogonal things: how many tiles it occupies (footprint, a size
// gradient) and which hand-drawn image it shows. Both the game client and the map editor derive city
// visuals from these two pure functions so "what the editor shows" and "what the game renders" stay in lock-step.
/**
 * City footprint (square side length in tiles) by level: tier1 (lv1-2)=3×3, tier2 (lv3-5)=5×5,
 * tier3 (lv6-8)=7×7, tier4 (lv9-10)=9×9 — higher-level cities read as physically bigger settlements.
 * The top tier equals {@link WORLD_CENTER_FOOTPRINT} (9), so the world-center mega-city sits naturally at the max size.
 */
export function cityFootprint(level: number): number {
  if (level <= 2) return 3;
  if (level <= 5) return 5;
  if (level <= 8) return 7;
  return 9;
}

/** City art tier (1..4) by level — 4 tier bands span the 10 levels (design/product/city-image-prompts.md). */
export function cityTier(level: number): 1 | 2 | 3 | 4 {
  if (level <= 2) return 1;
  if (level <= 5) return 2;
  if (level <= 8) return 3;
  return 4;
}

// ── City sprite placement geometry — single source of truth for client + map-editor. This math used to
// be hand-copied across 4 call sites (client base-city / node-city branches × map-editor's own two
// branches); a coefficient tweak in one left the other three stale, which is why the city-sprite
// fill/overflow bug kept resurfacing across several "fixes" instead of converging. Both renderers must
// call these instead of re-deriving the formula locally.
/**
 * On-screen sprite width, in tile-widths, for a city with this footprint — LINEAR so every city fills
 * its own plot the same way a 3×3 base fills its `baseSpriteTiles`-wide sprite (footprint===BASE_FOOTPRINT
 * → unchanged). Sub-linear (sqrt) scaling under-fills large plots badly.
 */
export function citySpriteTiles(footprint: number, baseSpriteTiles: number): number {
  return (footprint / BASE_FOOTPRINT) * baseSpriteTiles;
}

/**
 * Forward offset (screen px, along the plot's center→front-vertex axis) for a city sprite's bottom-center
 * anchor. An isometric N×N plot narrows to a POINT at its front vertex — a roughly-rectangular building
 * silhouette anchored short of that point (as a `< 1.0` fraction does) leaves a real, footprint-scaled gap
 * of bare plot exposed in front of the building; anchoring past the plot's own vertex would spill the
 * foot onto a neighbouring tile it doesn't own. 1.0 (exactly the front vertex) is therefore the only
 * value that both fully plants the building on its own land and never bleeds onto a neighbour's — do not
 * re-tune this to a fraction again without re-deriving the plot's actual vertex geometry (see
 * design/tools/map-editor/DESIGN.md).
 */
export function cityGroundFwdPx(footprint: number, tp: number, isoRatio: number): number {
  return (footprint * tp * isoRatio) / 2;
}

/**
 * Clip polygon (flat [x,y,...] pairs, relative to the sprite's bottom-center anchor origin — i.e. the
 * plot's own front vertex, since {@link cityGroundFwdPx} anchors there) that keeps a city sprite's
 * silhouette from ever bleeding past its OWN plot into a neighbouring tile. A city sprite is
 * `citySpriteTiles()` tiles wide — deliberately ~7% wider than the footprint so the art reads as filling
 * its plot — but a rectangular sprite is wider than the plot's own N×N *diamond* everywhere except at its
 * exact horizontal midline, so without clipping that extra width (plus the diamond's front-taper down to
 * a point) shows up as the building visibly overlapping an adjacent resource tile, which reads to a player
 * as "can I still capture that tile?" ambiguity. This polygon: tapers from the front tip (this function's
 * origin) up to the plot's own left/right vertices (matching the diamond exactly, so nothing behind that
 * edge is cut), then runs straight up at that fixed half-width for `tallPx` (comfortably taller than the
 * tallest sprite) so upper storeys/towers are never clipped — only sideways bleed at or below the
 * midline is. Above the plot's OWN back vertex a tall building legitimately overlaps tiles further back
 * (normal isometric depth-occlusion, not ambiguous — see {@link cityGroundFwdPx} docs), so this
 * deliberately does not taper the top back down to a point.
 */
export function cityPlotMaskPoints(footprint: number, tp: number, isoRatio: number, tallPx: number): number[] {
  const half = (footprint * tp) / 2;
  const gf = cityGroundFwdPx(footprint, tp, isoRatio);
  return [0, 0, half, -gf, half, -tallPx, -half, -tallPx, -half, -gf];
}

// ── Procedural distribution knobs (U6 initial DRAFT; centralized here for easy tuning) ────────
export const SLG_GEN = {
  /** Resource tile density: fraction of non-neutral tiles classified as resource tiles (ADR-032: raised to 1.0 — no pure no-yield neutral land; every non-blocking/keep/stronghold/center tile is some level of resource land). */
  resourceDensity: 1.0,
  /** familyKeep noise threshold; higher = sparser. */
  keepThreshold: 0.86,
  /** Minimum distance ratio from a tile's own province capital for strategic points (ADR-034: distance is now to the tile's own province's capital, angle-sector-derived — prevents keeps from spawning too close to any capital). */
  keepMinDistRatio: 0.12,
  /** Level noise frequency (higher = more fragmented patches; feeds the ADR-034 §4 per-ring cumulative-distribution level lookup, not a distance falloff). */
  levelFreq: 1 / 14,
  /** Strategic point noise frequency. */
  keepFreq: 1 / 22,
  /**
   * Provincial bias for the per-tile land-resource draw (ADR-022 provincial-bias model, rewritten
   * 2026-07-15 — see {@link ../mapgen.ts#biomeAt}). Every resource tile independently draws one of the
   * four land resources (ink/paper/graphite/metal) — NOT a spatial zone noise field — with its own
   * province's `leaning` type favored by this fraction over the uniform 1/4 baseline: e.g. 0.15 →
   * leaning type ≈ 40% of that province's tiles, the other three ≈ 20% each. `sticker` (copper-coin
   * slot) is NOT a biome land resource so it has no bias here; instead it has a LEVEL-GATED copper-mine
   * map faucet (copperMinLevel/copperShare below) plus home-city stickerShop self-production.
   * ⚠ ADR-022 caveat: this changes the procedural map (unclaimed tiles only — claimed tiles persist resType in the DB). Pre-launch, so applied
   * globally; once a season is live, gate behind a season-version flag instead of mutating live maps. DRAFT — tune in the balance pass.
   */
  biomeProvinceBias: 0.15,
  /**
   * copper mine = LEVEL-GATED `sticker` map faucet (Three-Kingdoms-Strategy rule: copper mine only on level-6 tiles and above, see SGZ_LAND_REFERENCE §3 /
   * SLG_DESIGN §3.4). On a `resource` tile at level ≥ copperMinLevel, a per-tile hash draw < copperShare overrides the
   * biome land resource with `sticker`; below that level sticker never appears on the map (matches the art, which ships
   * sticker frames l6–10 only — slg-resource-art §5.7-sticker).
   * COEXISTS with the home-city stickerShop faucet (decided 2026-07-07): stickerShop (STICKER_SELF_BASE/h/level, city.ts) is
   * the reliable BASELINE every player has and covers the building-upgrade sticker sink; map copper mine is a scarce EXPANSION
   * BONUS gated behind contested ≥6 tiles. recomputeYield adds both faucets (additive, no double-count). Hence copperShare
   * is kept low: 0.25 → copper mine ≈ 22% of ≥6 resource tiles ≈ 2.5% of all resource tiles (a clear minority even among high
   * tiles — "special, must be fought for"). DRAFT — validate in the balance pass (econ-sim does not yet model the map faucet).
   */
  copperMinLevel: 6,
  copperShare: 0.25,
  /** Level cap for neutral open land (keeps neutral tiles low-value). */
  neutralLevelCap: 2,
  // ── S8-6.6 blocking terrain + crossings: obstacle placement is geometric (ring/river/branch bands,
  // ADR-034 §2.2/§2.3, see TERRAIN_BAND_WIDTH_*/*_CROSSING_*/BRANCH_COUNT below), not noise-threshold-based.
  // Crossings over a band are capturable bridge/plankway tiles (gate→bridge/plankway migration).
  // ── G8 strongholds (§3.1) ──────────────────────────
  /**
   * Stronghold per-tile hash threshold (ECONOMY_NUMBERS §13-SLG-STRONGHOLD). Strongholds are isolated
   * strategic points at ~0.3% of the map — NOT contiguous zones — so they use a per-tile uniform hash
   * gate `rand2(x,y,seed^0x0555) > strongholdThreshold` (a Bernoulli(1-threshold) draw per tile), NOT
   * smooth value-noise. On a 300×300 map a low-frequency noise field has only ~18 lattice points, so a
   * `noise > threshold` gate swings the count 0→thousands across seeds (CV≈1.0, 14% of worlds get ZERO)
   * and clumps cells into large blobs. A per-tile Bernoulli(p=1-0.997=0.003) over 90,000 tiles gives
   * count ≈ 270 ± √(90000·0.003·0.997) ≈ ±16 (CV ≈ 0.06), isolated points, hitting the "~0.3% extremely
   * sparse" intent deterministically. Higher = sparser.
   */
  strongholdThreshold: 0.997,
  /** Minimum distance ratio from a tile's own province capital for strongholds (ADR-034: distance is now to the tile's own province's capital — preserves a safe zone for new players in every province). */
  strongholdMinDistRatio: 0.25,
} as const;

// ── Numeric constants (U6 DRAFT; tune after launch) ────────────────────
// Base city troop pool cap (drillYard adds +DRILL_TROOPCAP_STEP/level on top). Set to the
// new-player join grant so a fresh capital holds its whole starting reserve (unified troop pool,
// CHARACTER_CARDS_DESIGN §6.3/§6.5 — troops = 基地兵力池, distributed to cards from here).
export const TROOP_CAP_BASE = 10000;
export const MARCH_SPEED_SEC_PER_TILE = 6; // seconds of march time per tile
export const MARCH_MIN_TROOPS = 1; // minimum troops required to send a march
/** Morale ceiling for a fresh march (out of 100). Bound to the march instance — resets to full on every departure. */
export const MARCH_MORALE_MAX = 100;
/** Combat-power multiplier floor at zero morale — a long-distance march still fights at 70% strength, never worse. */
export const MARCH_MORALE_COMBAT_FLOOR = 0.7;
export const RESOURCE_CAP = 200_000;
export const RESOURCE_YIELD_BASE = 100; // base yield per tile per hour (× level multiplier)
export const PROTECTION_SEC = 8 * 3600; // protection duration for new players / after home-city is destroyed
export const FAMILY_CAP = 30; // S8-4 decision: max family size 30 members
/**
 * Family / sect name limits, measured in DISPLAY WIDTH (see orgNameWidth): a full-width
 * (CJK/全角) character counts as 2, everything else as 1. Cap 12 → at most 6 汉字 or 12 letters.
 * TAG is validated separately (2–5 uppercase alphanumerics).
 */
export const ORG_NAME_WIDTH_MIN = 2;
export const ORG_NAME_WIDTH_MAX = 12;
/**
 * Display width of an org (family/sect) name: full-width characters (CJK ideographs, kana,
 * full-width forms, etc.) count as 2, all others as 1. Iterates by code point so astral
 * characters (emoji) are counted once (as width 2, since they fall outside the ASCII/half-width range).
 */
export function orgNameWidth(name: string): number {
  let w = 0;
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    // Half-width: ASCII printable + Latin-1 + half-width forms → width 1; everything else → width 2.
    w += cp <= 0x2e7f || (cp >= 0xff61 && cp <= 0xffdc) || (cp >= 0xffe8 && cp <= 0xffee) ? 1 : 2;
  }
  return w;
}
/** Truncate `name` to at most `maxWidth` display units (orgNameWidth), never splitting a code point. */
export function truncateOrgName(name: string, maxWidth: number = ORG_NAME_WIDTH_MAX): string {
  let w = 0;
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    const cw = cp <= 0x2e7f || (cp >= 0xff61 && cp <= 0xffdc) || (cp >= 0xffe8 && cp <= 0xffee) ? 1 : 2;
    if (w + cw > maxWidth) break;
    w += cw;
    out += ch;
  }
  return out;
}
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

export const GARRISON_PER_TILE = 500;
/** Minimum garrison required to occupy a tile (becomes that tile's garrison upon arrival; march is rejected if insufficient). */
export const OCCUPY_MIN_TROOPS = GARRISON_PER_TILE;
/**
 * Occupation hold countdown (§5.4, ADR-037, DRAFT placeholder — tune after economy validation): after an occupy
 * march wins its PvE battle against the target tile's system garrison, the surviving troops hold the tile for
 * this many seconds before `TileDoc.ownerId` is actually written. Mirrors ADR-026's `SLG_SIEGE_DAMAGE_DELAY_MS`
 * delayed-settlement pattern (same 5-minute placeholder, different semantics — that one deducts building HP,
 * this one finalizes territory ownership). The tile can be expelled by another attack/occupy march during the hold.
 */
export const OCCUPY_HOLD_SEC = 5 * 60;
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
export const TROOP_TRAIN_BATCH_MAX = 5000;
/** Maximum concurrent training batches (training queue slots). */
export const TROOP_TRAIN_QUEUE_MAX = 2;
/** Speed-up rate: seconds of training time per coin spent (DRAFT, 60 s/coin). */
export const TROOP_SPEEDUP_SECS_PER_COIN = 60;
