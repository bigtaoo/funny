// ─────────────────────────────────────────────────────────────────────────────
// SLG nation-bonus "naked economy" check (B-track, SLG_ECONOMY_CHECK §4 first bullet).
//
// Question: does NATION_BONUS_PRODUCTION=0.10 create a gap between
//   "home-nation focus" and "cross-nation expansion" strategies > 20%?
//   (Judgment criterion per §4: gap ≤ 20% → PASS)
//
// Three-part analysis:
//   ① Province geometry (ADR-034 angle-sector ring model) — code-derived, no assumptions. How large is each nation?
//   ② Marginal break-even — at what foreign-tile average level does cross-expansion
//      yield equal per-tile output to a home tile? (pure math, no assumption)
//   ③ Strategy gap table — for combinations of home/foreign tile split and foreign
//      tile level premium, compute the seasonal output gap and PASS/FAIL verdict.
//      These use transparent, explicit assumptions (same discipline as A-track population).
//
// Nothing here enters the §6.1 monthly coin budget (purely intra-season, §0.1).
// ─────────────────────────────────────────────────────────────────────────────

import {
  NATION_BONUS_PRODUCTION,
  SEASON_LENGTH_DAYS,
  RESOURCE_YIELD_BASE,
  NATION_COUNT,
  provinceIdxAt,
  SLG_MAP_W,
  SLG_MAP_H,
  SLG_MAP_MAX_LEVEL,
  SLG_GEN,
} from '@nw/shared';

export const HOURS_PER_SEASON = SEASON_LENGTH_DAYS * 24;

// ── ① Province geometry (code-derived, ADR-034 angle-sector ring model) ──────────────────

/** Exact tile count for each province's angle-sector+ring region on the live SLG_MAP_W×SLG_MAP_H map. */
export function provinceTileCounts(): number[] {
  const counts = new Array<number>(NATION_COUNT).fill(0);
  for (let x = 0; x < SLG_MAP_W; x++) {
    for (let y = 0; y < SLG_MAP_H; y++) {
      const idx = provinceIdxAt(x, y);
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }
  return counts;
}

/** Map-level statistics used by strategy scenarios (code-derived, no assumptions). */
export interface MapLevelStats {
  /** Average tile level across entire map (SLG_MAP_MAX_LEVEL midpoint). */
  avgMapLevel: number;
  /** SLG_MAP_MAX_LEVEL (max tile level from shared). */
  maxLevel: number;
  /** Total resource tiles on the map at the design density. */
  resourceTileCount: number;
}

export function mapLevelStats(): MapLevelStats {
  return {
    avgMapLevel: (SLG_MAP_MAX_LEVEL + 1) / 2, // uniform-distribution midpoint for levels 1..max
    maxLevel: SLG_MAP_MAX_LEVEL,
    resourceTileCount: Math.round(SLG_MAP_W * SLG_MAP_H * SLG_GEN.resourceDensity),
  };
}

// ── ② Marginal break-even (pure math, no assumption) ─────────────────────────

/**
 * Returns the foreign tile level at which cross-expansion produces equal output per tile as a home tile.
 * Home tile value = base × homeLevel × (1 + bonus).
 * Foreign tile value = base × foreignLevel.
 * Break-even when foreignLevel = homeLevel × (1 + bonus).
 */
export function breakEvenForeignLevel(homeAvgLevel: number): number {
  return homeAvgLevel * (1 + NATION_BONUS_PRODUCTION);
}

// ── ③ Strategy gap table (explicit assumptions) ───────────────────────────────

/**
 * A strategy scenario.
 *
 * Both "Home" and "Cross" strategies hold the same total tile count (tileCap).
 * - Home strategy: all tileCap tiles in own province → all get +NATION_BONUS_PRODUCTION.
 * - Cross strategy: homeFrac × tileCap tiles in own nation (bonus) +
 *                  (1-homeFrac) × tileCap in foreign nations (no bonus, possibly different avg level).
 *
 * foreignLevelMult: foreign tile avgLevel = homeAvgLevel × mult.
 *   = 1.00 → level parity (most conservative for cross-expansion)
 *   = 1.10 → foreign tiles are 10% higher level (contested high-value zones)
 *   = 1.20 → foreign tiles are 20% higher level (peak high-value frontier)
 */
export interface StrategyScenario {
  label: string;
  tileCap: number;
  homeAvgLevel: number;
  foreignLevelMult: number; // foreign avgLevel = homeAvgLevel × mult
  crossHomeFrac: number;    // fraction of cross-strategy tiles still in own nation [0,1]
}

export interface StrategyResult {
  s: StrategyScenario;
  homeSeasonOutput: number;  // home strategy total season output (per unit base)
  crossSeasonOutput: number; // cross strategy total season output
  gapPct: number;            // (home - cross) / cross × 100%; negative = cross wins
  pass: boolean;             // |gapPct| implies home advantage ≤ 20%
}

/** Run a single strategy scenario and return the comparison. */
export function runScenario(s: StrategyScenario): StrategyResult {
  const foreignAvgLevel = s.homeAvgLevel * s.foreignLevelMult;
  const base = RESOURCE_YIELD_BASE;

  // Home strategy: all tiles in own nation with bonus
  const homePerHour = s.tileCap * base * s.homeAvgLevel * (1 + NATION_BONUS_PRODUCTION);

  // Cross strategy: homeFrac at bonus, rest at foreignLevel without bonus
  const crossPerHour =
    s.crossHomeFrac * s.tileCap * base * s.homeAvgLevel * (1 + NATION_BONUS_PRODUCTION) +
    (1 - s.crossHomeFrac) * s.tileCap * base * foreignAvgLevel;

  const homeSeasonOutput = homePerHour * HOURS_PER_SEASON;
  const crossSeasonOutput = crossPerHour * HOURS_PER_SEASON;
  const gapPct = ((homeSeasonOutput - crossSeasonOutput) / crossSeasonOutput) * 100;

  return {
    s,
    homeSeasonOutput,
    crossSeasonOutput,
    gapPct,
    // "PASS" = home advantage ≤ 20% (the criterion from SLG_ECONOMY_CHECK §4)
    // Negative gap means cross-expansion wins — also fine (bonus doesn't force everyone home).
    pass: gapPct <= 20,
  };
}

/**
 * Canonical scenario set.
 *
 * Covers the stress-test grid:
 *   - Three foreign-level premiums (parity / slight advantage / strong advantage)
 *   - Two cross-strategy tile splits (50/50 home/foreign; 20/80 mostly-foreign)
 *   - Two tile-cap assumptions (modest territory / large territory) — absolute output
 *     scales with cap but the gapPct is cap-independent (linear cancel), kept for readability
 *
 * The worst case for "home dominance" = level parity (foreignMult=1) + all tiles foreign (crossHomeFrac=0).
 * That gap = exactly NATION_BONUS_PRODUCTION = 10%, always ≤ 20% → criterion is structurally satisfied.
 */
export const CANONICAL_SCENARIOS: StrategyScenario[] = [
  // Parity: foreign tiles same average level as home
  { label: 'parity / 50-50 split',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.00, crossHomeFrac: 0.50 },
  { label: 'parity / 20-80 split',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.00, crossHomeFrac: 0.20 },
  { label: 'parity / pure foreign',  tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.00, crossHomeFrac: 0.00 },
  // Slight foreign advantage: cross-expansion reaches +10% better territory
  { label: '+10% foreign / 50-50',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.10, crossHomeFrac: 0.50 },
  { label: '+10% foreign / 20-80',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.10, crossHomeFrac: 0.20 },
  { label: '+10% foreign / pure',    tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.10, crossHomeFrac: 0.00 },
  // Strong foreign advantage: cross-expansion reaches high-value contested tiles (+20%)
  { label: '+20% foreign / 50-50',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.20, crossHomeFrac: 0.50 },
  { label: '+20% foreign / 20-80',   tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.20, crossHomeFrac: 0.20 },
  { label: '+20% foreign / pure',    tileCap: 50, homeAvgLevel: 3, foreignLevelMult: 1.20, crossHomeFrac: 0.00 },
  // High-level home tiles (center nation, high-value home territory)
  { label: 'high-home L4 / 50-50',  tileCap: 50, homeAvgLevel: 4, foreignLevelMult: 1.00, crossHomeFrac: 0.50 },
  { label: 'high-home L4 / pure',   tileCap: 50, homeAvgLevel: 4, foreignLevelMult: 1.00, crossHomeFrac: 0.00 },
];

export function runAllScenarios(): StrategyResult[] {
  return CANONICAL_SCENARIOS.map(runScenario);
}
