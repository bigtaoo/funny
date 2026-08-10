// Split from mapgen.ts (2026-08-10, independent function module range 6, part 2/7).
// Per-tile land-resource draw (ADR-022 provincial-bias model) + the copper-mine level gate.
import { SLG_GEN, type ResourceType } from '../core';
import { rand2 } from '../noise';
import { provinceIdxAt } from '../province';

const _BIOME_ORDER: readonly ResourceType[] = ['ink', 'paper', 'graphite', 'metal'];

/**
 * The land-resource type a given province leans toward (ADR-022 provincial-bias model, rewritten
 * 2026-07-15 — see design/game/SLG_DESIGN.md resource-distribution section). One deterministic draw
 * per (provinceIdx, worldId): this is NOT the province's only resource — see {@link biomeAt}, which
 * still draws every tile independently — it only skews that per-tile draw's odds toward this type.
 */
export function leaningResourceForProvince(provinceIdx: number, seed: number): ResourceType {
  const n = rand2(provinceIdx, 0, seed ^ 0x0d55);
  return _BIOME_ORDER[Math.floor(n * _BIOME_ORDER.length) % _BIOME_ORDER.length]!;
}

/** Two categories + a blend factor (a→b); kept for {@link biomeGroundTint} call-site compatibility
 * (client/map-editor tileStyle.ts) — see {@link biomeMixAt}. */
export interface BiomeMix { a: ResourceType; b: ResourceType; t: number }

/**
 * Land-resource type for a tile (ADR-022 provincial-bias model, rewritten 2026-07-15): every resource
 * tile independently draws one of the four land resources (ink/paper/graphite/metal) — resource types
 * are meant to be MIXED within a province, not partitioned into large single-resource zones — with a
 * mild bias toward the tile's own province's {@link leaningResourceForProvince} (`SLG_GEN.biomeProvinceBias`,
 * e.g. 0.15 → the leaning type is drawn ~40% of the time, the other three ~20% each).
 *
 * Replaces the previous low-frequency-noise quad-partition (large contiguous same-resource zones cut
 * by fixed noise thresholds), which read as abrupt hard-edged regions unrelated to province borders
 * and didn't match the intended "mostly mixed, one type only mildly favored" design (map-editor
 * DESIGN.md §8, 2026-07-15 entry).
 */
export function biomeAt(x: number, y: number, seed: number): ResourceType {
  const leaning = leaningResourceForProvince(provinceIdxAt(x, y), seed);
  const base = 1 / _BIOME_ORDER.length;
  const leaningWeight = base + SLG_GEN.biomeProvinceBias;
  const otherWeight = (1 - leaningWeight) / (_BIOME_ORDER.length - 1);
  const roll = rand2(x, y, seed ^ 0x0444);
  let acc = 0;
  for (const t of _BIOME_ORDER) {
    acc += t === leaning ? leaningWeight : otherWeight;
    if (roll < acc) return t;
  }
  return _BIOME_ORDER[_BIOME_ORDER.length - 1]!;
}

/**
 * Ground-tint helper for {@link biomeGroundTint} (client/map-editor tileStyle.ts): resource types are
 * now drawn per-tile (see {@link biomeAt}), so there is no resource-zone boundary left to blend across
 * — the only region boundary left on the map is the province's own border, which is already a hard
 * political line (ADR-034) and is fine to render as a hard tint change. Always returns `a === b`,
 * `t === 0` (solid tint = the tile's own province's leaning type); the `w` param is accepted only for
 * call-site compatibility and is unused.
 */
export function biomeMixAt(x: number, y: number, seed: number, _w?: number): BiomeMix {
  const leaning = leaningResourceForProvince(provinceIdxAt(x, y), seed);
  return { a: leaning, b: leaning, t: 0 };
}

/**
 * Resource type for a `resource` tile, with the copper-mine level gate: `sticker` appears ONLY on tiles at
 * level ≥ SLG_GEN.copperMinLevel (Three-Kingdoms-Strategy rule: copper mine is a level-6-and-above special, SGZ_LAND_REFERENCE §3). On an eligible
 * tile a per-tile hash draw < copperShare overrides the biome land resource with `sticker`; otherwise the four biome
 * land resources apply. The gate MUST hold — the art ships sticker frames l6–10 only (slg-resource-art §5.7-sticker),
 * so a sub-l6 sticker tile would fall back to the raw motif. Applied to plain resource tiles only (strategic tiles —
 * stronghold/familyKeep/center — keep their biome land resource and render as buildings, not resource motifs).
 */
export function resTypeFor(x: number, y: number, seed: number, level: number): ResourceType {
  if (level >= SLG_GEN.copperMinLevel && rand2(x, y, seed ^ 0x0c0e) < SLG_GEN.copperShare) return 'sticker';
  return biomeAt(x, y, seed);
}
