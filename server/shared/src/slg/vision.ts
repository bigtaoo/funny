// SLG vision / fog of war (G5, §8.2 / §2.1 / §15.2) — pure geometry, no DB, computable on either end.
//
// Split out of `siege.ts` (2026-08-25, "单文件 500 行收敛"): that file's own header listed five concerns
// (siege settlement, vision, the playable siege-defense level, the CC-3 card troop system, ADR-026 building
// HP) and ADR-074 P0's doc comments pushed it past 500 lines. Vision is the one with no coupling at all to
// the rest — it never touches a garrison, a card or a durability number — so it is the clean
// independent-function-module cut (split-priority order: independent modules > composition > chain).
// `index.ts` re-exports it, so every `@nw/shared` import site is unchanged.
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
/** In-transit march vision radius (DRAFT). */
export const VISION_MARCH_RADIUS = 2;
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
