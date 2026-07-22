// ─────────────────────────────────────────────────────────────────────────────
// Stronghold track model (SLG_ECONOMY_CHECK §21.4 "stronghold STRONGHOLD_* density/garrison/rewards").
//
// Strongholds (G8 §3.1) are the ONE stronghold-related economy face the A-track
// aggregation never counted: on capture, `applyStrongholdSiege` grants a PERSISTENT
// progression material via `meta.grantMaterial` (worldsvc/src/service.ts:1789-1790):
//
//     const matLoot = strongholdMaterialLoot(proc.level);          // binding, 4×level
//     meta.grantMaterial(ownerId, matLoot.material, matLoot.qty, …) // -> SaveData.materials
//
// That is a persistent `binding` faucet outside SETTLE_REWARDS + trickle, so it belongs
// in the A-track dilution/inflation judgement. The season-resource loot (5000×level to
// one resType) and the NPC garrison (360×level) are season-internal / battle concerns,
// reported here for a one-pass sanity check.
//
// The count itself is PROCEDURAL: `proceduralTile(world,x,y)` decides stronghold cells via a
// per-tile hash gate (`rand2(x,y,seed^K) > strongholdThreshold=0.997`, i.e. Bernoulli(p≈0.003) —
// this replaced an earlier smooth-value-noise design that clumped into blobs and swung wildly
// seed-to-seed, see SLG_DESIGN_LOG.md §19.5, CLOSED 2026-07-02). We count strongholds by running
// the REAL generator over the REAL map (SLG_MAP_W×SLG_MAP_H) for many world seeds — no
// hand-assumed density.
// ─────────────────────────────────────────────────────────────────────────────

import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  SLG_MAP_MAX_LEVEL,
  strongholdGarrison,
  strongholdMaterialLoot,
  STRONGHOLD_LOOT_PER_LEVEL,
  STRONGHOLD_LOOT_MATERIAL,
  SLG_WORLD_CAPACITY_TARGET,
  RESOURCE_CAP,
  TROOP_CAP_BASE,
  provinceIdxAt,
  NATION_KIND_BY_IDX,
  type NationKind,
} from '@nw/shared';
import { MATERIAL_COIN_VALUE, REGULAR_MONTHLY_MATERIAL, type MaterialKey } from './valuation';

export const MAP_TILES = SLG_MAP_W * SLG_MAP_H;
/** Strongholds always spawn at the map max level (proceduralTile: type 'stronghold' → level SLG_MAP_MAX_LEVEL). */
export const STRONGHOLD_LEVEL = SLG_MAP_MAX_LEVEL;
export const BINDING_PER_STRONGHOLD = strongholdMaterialLoot(STRONGHOLD_LEVEL).qty; // 4×level persistent material
export const SEASON_RES_PER_STRONGHOLD = STRONGHOLD_LOOT_PER_LEVEL * STRONGHOLD_LEVEL; // one-time season resource
export const STRONGHOLD_NPC_GARRISON = strongholdGarrison(STRONGHOLD_LEVEL); // 360×level troops
export const LOOT_MATERIAL = STRONGHOLD_LOOT_MATERIAL as MaterialKey;

/** Count strongholds by running the real procedural generator over the full map for one world seed. */
export function countStrongholds(world: string): number {
  let n = 0;
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (proceduralTile(world, x, y).type === 'stronghold') n++;
    }
  }
  return n;
}

/**
 * Connected-component (flood-fill, 4-neighbour) analysis of stronghold cells for one seed.
 * Kept as a regression check: the old smooth-value-noise generator used to yield CONTIGUOUS blobs
 * instead of isolated points (fixed 2026-07-02, see the per-tile hash gate note above) — this quantifies
 * that the current generator still produces isolated points, not a re-litigation of the old bug.
 */
export function strongholdBlobs(world: string): { count: number; components: number; maxBlob: number; meanBlob: number } {
  const mask = new Uint8Array(MAP_TILES);
  let count = 0;
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      if (proceduralTile(world, x, y).type === 'stronghold') { mask[y * SLG_MAP_W + x] = 1; count++; }
    }
  }
  const seen = new Uint8Array(MAP_TILES);
  let components = 0, maxBlob = 0;
  const stack: number[] = [];
  for (let i = 0; i < MAP_TILES; i++) {
    if (!mask[i] || seen[i]) continue;
    components++;
    let size = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const cx = c % SLG_MAP_W, cy = (c / SLG_MAP_W) | 0;
      const nb: Array<[number, number]> = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
        const ni = ny * SLG_MAP_W + nx;
        if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (size > maxBlob) maxBlob = size;
  }
  return { count, components, maxBlob, meanBlob: components ? count / components : 0 };
}

export interface Percentiles {
  min: number; p10: number; median: number; mean: number; p90: number; max: number; sd: number; zeroSeedPct: number;
}

/** Stronghold-count distribution across N world seeds (`world-0`..`world-{N-1}`). */
export function countDistribution(nSeeds: number): { counts: number[]; stats: Percentiles } {
  const counts: number[] = [];
  for (let i = 0; i < nSeeds; i++) counts.push(countStrongholds(`world-${i}`));
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  const zeroSeedPct = (100 * counts.filter((c) => c === 0).length) / counts.length;
  return {
    counts,
    stats: { min: sorted[0] ?? 0, p10: at(0.1), median: at(0.5), mean, p90: at(0.9), max: sorted[sorted.length - 1] ?? 0, sd, zeroSeedPct },
  };
}

const RING_KINDS: readonly NationKind[] = ['outer', 'resource', 'core'];

/** Ring-kind (outer/resource/core, ADR-034 §2.1) each map tile belongs to, precomputed once (geometry only, seed-independent). */
function _tileRingKinds(): Uint8Array {
  const ringOf = new Uint8Array(MAP_TILES);
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      const kind = NATION_KIND_BY_IDX[provinceIdxAt(x, y)]!;
      ringOf[y * SLG_MAP_W + x] = RING_KINDS.indexOf(kind);
    }
  }
  return ringOf;
}

export interface RingStats {
  tileCount: number;
  counts: number[];
  mean: number; sd: number; cv: number;
  /** strongholds per tile in this ring type — the fair way to compare rings of very different sizes. */
  hitRatePerTile: number;
}

/**
 * Stronghold-count distribution broken down by ring kind (outer/resource/core, ADR-034), across N world seeds.
 * §2.4's "~0.3% of map" intent was only ever checked at the whole-map level (SLG_DESIGN_LOG §19.5, CLOSED
 * 2026-07-02); this answers the follow-up: does a smaller ring type (e.g. one 60° outer sector vs the whole
 * resource ring) end up systematically stronghold-starved or stronghold-flooded per tile?
 */
export function countDistributionByRing(nSeeds: number): Record<NationKind, RingStats> {
  const ringOf = _tileRingKinds();
  const tileCount: Record<NationKind, number> = { outer: 0, resource: 0, core: 0 };
  for (let i = 0; i < MAP_TILES; i++) tileCount[RING_KINDS[ringOf[i]!]!]++;

  const counts: Record<NationKind, number[]> = { outer: [], resource: [], core: [] };
  for (let s = 0; s < nSeeds; s++) {
    const world = `world-${s}`;
    const seedCounts: Record<NationKind, number> = { outer: 0, resource: 0, core: 0 };
    for (let y = 0; y < SLG_MAP_H; y++) {
      for (let x = 0; x < SLG_MAP_W; x++) {
        if (proceduralTile(world, x, y).type === 'stronghold') {
          seedCounts[RING_KINDS[ringOf[y * SLG_MAP_W + x]!]!]++;
        }
      }
    }
    for (const k of RING_KINDS) counts[k].push(seedCounts[k]);
  }

  const out = {} as Record<NationKind, RingStats>;
  for (const k of RING_KINDS) {
    const arr = counts[k];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    out[k] = { tileCount: tileCount[k], counts: arr, mean, sd, cv: sd / Math.max(1, mean), hitRatePerTile: mean / Math.max(1, tileCount[k]) };
  }
  return out;
}

export const SEASON_MONTHS = 60 / 30; // SLG season = 60 days ≈ 2 months (§2.2)

/** Per-season persistent-binding faucet from strongholds for a world with `strongholds` count. */
export function bindingFaucet(strongholds: number, captureRate: number) {
  const capturesPerSeason = strongholds * captureRate; // one binding grant per stronghold capture (idempotent per march)
  const worldBinding = capturesPerSeason * BINDING_PER_STRONGHOLD;
  const perCapitaSpread = worldBinding / SLG_WORLD_CAPACITY_TARGET; // if spread across the whole world
  const worldCoinEq = worldBinding * MATERIAL_COIN_VALUE[LOOT_MATERIAL];
  return { capturesPerSeason, worldBinding, perCapitaSpread, worldCoinEq };
}

/** Player's regular per-SEASON binding grind income (A-track dilution denominator, §2.3/§3). */
export const GRIND_BINDING_PER_SEASON = REGULAR_MONTHLY_MATERIAL[LOOT_MATERIAL] * SEASON_MONTHS;

export const NUMBERS = {
  MAP_W: SLG_MAP_W,
  MAP_H: SLG_MAP_H,
  MAP_TILES,
  STRONGHOLD_LEVEL,
  BINDING_PER_STRONGHOLD,
  SEASON_RES_PER_STRONGHOLD,
  STRONGHOLD_NPC_GARRISON,
  LOOT_MATERIAL,
  WORLD_CAPACITY_TARGET: SLG_WORLD_CAPACITY_TARGET,
  RESOURCE_CAP,
  TROOP_CAP_BASE,
  BINDING_COIN_VALUE: MATERIAL_COIN_VALUE[LOOT_MATERIAL],
  GRIND_BINDING_PER_SEASON,
};
