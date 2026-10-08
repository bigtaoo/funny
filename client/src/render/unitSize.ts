import { UnitType } from '@nw/engine/types';

/**
 * Unit height standard — the single source of truth in code for "how tall is a
 * character on screen". Design record/rationale: art-direction.md §4.5 (this is
 * the authority for the numbers; the doc references this file, not the reverse).
 *
 * Height = the standing silhouette from foot to crown (excludes raised
 * weapons/wings). It drives ONLY the visual silhouette — never combat numbers
 * (radius / move speed stay with @nw/engine config; §4.5.3 (D) red line).
 *
 * Two consumers (both still TODO — see §4.5.3 A/B; today this file only fixes
 * the standard so it isn't re-derived from docs each time):
 *   (A) runtime: scale each .tao/draft to TARGET_SCREEN_PX[tier] instead of the
 *       flat STICKMAN_SCALE, so same-tier units render the same height.
 *   (B) export: animator bakes textures to TARGET_ANIMATOR_PX[tier] × SUPERSAMPLE
 *       resolution so asset size tracks the real display size, not the artist's
 *       arbitrary canvas size.
 */
export enum SizeTier {
  /** Small build — lean/agile: ranged, flying, fast-fragile. */
  Small = 'S',
  /** Standard build — standard teen build (baseline). */
  Medium = 'M',
  /** Tall build — sturdy/anchored: shield, heavy hitter. */
  Large = 'L',
  /** Giant build — mythic creatures only; towers a full tier over humans. */
  Giant = 'XL',
}

/**
 * Target on-screen height (px) per tier, at the current portrait/landscape
 * layout. Reference values only — the authority is the ratio to the Medium
 * baseline; rescale proportionally if cell size / resolution changes.
 *   S 0.85× · M 1.00× · L 1.18× · XL 1.50×
 */
export const TARGET_SCREEN_PX: Record<SizeTier, number> = {
  [SizeTier.Small]:  46,
  [SizeTier.Medium]: 54,
  [SizeTier.Large]:  64,
  [SizeTier.Giant]:  81,
};

/**
 * Target height (px) in animator/authoring space per tier. Used by the export
 * bake-down to size textures: bone images are scaled so the whole figure
 * occupies TARGET_ANIMATOR_PX × SUPERSAMPLE pixels of texture.
 */
export const TARGET_ANIMATOR_PX: Record<SizeTier, number> = {
  [SizeTier.Small]:  170,
  [SizeTier.Medium]: 200,
  [SizeTier.Large]:  236,
  [SizeTier.Giant]:  300,
};

/**
 * Texture supersample factor — keeps the figure crisp on high-DPR screens.
 * Replaces the old ad-hoc 1.5 export headroom with a principled knob.
 */
export const SUPERSAMPLE = 2;

/**
 * UnitType → SizeTier. art-direction §4.5.2: same tactical role across the East
 * (Tao/Fang) and West (Anna/Hartmann) factions shares a tier — this both gives
 * a rule and echoes the "the red army is yourself" mirror canon (the two sides
 * are the same cast in different pen colors). PvE myth creatures aren't bound to
 * the teen band and span the full range (Ironclad = Giant).
 */
export const UNIT_SIZE_TIER: Record<UnitType, SizeTier> = {
  // tank / stand-and-soak → L
  [UnitType.ShieldBearer]: SizeTier.Large,   // Chen Shou
  [UnitType.Lena]:         SizeTier.Large,
  // anchor charge / single-point strike → M
  [UnitType.Infantry]:     SizeTier.Medium,  // Li Chuan
  [UnitType.Max]:          SizeTier.Medium,
  // ranged / fragile → S
  [UnitType.Archer]:       SizeTier.Small,   // Su Yuan
  [UnitType.Mara]:         SizeTier.Small,
  // PvE myth creatures
  [UnitType.Ironclad]:     SizeTier.Giant,   // Qiong Qi / Cyclops — towers over humans
  [UnitType.Berserker]:    SizeTier.Large,
  [UnitType.Medic]:        SizeTier.Medium,
  [UnitType.Splitter]:     SizeTier.Small,   // stocky bomb (short, if wide)
  [UnitType.Runner]:       SizeTier.Small,   // Xie Zhi / Cerberus
  [UnitType.Harpy]:        SizeTier.Small,
};

/**
 * Target on-screen height (px) for a unit type, before any board constraint. Battle
 * board units use {@link boardUnitHeight} instead (it shrinks on small cells).
 */
export function targetScreenHeight(type: UnitType): number {
  return TARGET_SCREEN_PX[UNIT_SIZE_TIER[type]];
}

/**
 * Board cell size (design px) at and above which units render at the full
 * {@link TARGET_SCREEN_PX} height. The tier heights are literal design px while
 * the cell is `floor(70·k)` (landscape) / `floor(84·k)` (portrait), so on a short
 * landscape canvas the cell shrinks under a fixed-height unit and the figure spills
 * into the neighbouring lane (722×406: cell 42, Medium = 1.29 cells). 54 is the
 * Medium height itself, i.e. below this cell size Medium is held at exactly one
 * cell. The CrazyGames reviewer canvas (1100×574 → cell 60), every 1080-tall
 * landscape (cell 70) and every portrait screen (cell ≥ 56) sit above it and are
 * unchanged. ADR-105 amendment 2026-10-08.
 */
export const UNIT_SIZE_FULL_CELL = 54;

/**
 * Board-unit size factor for a board with `cellSize` design px cells:
 * `min(1, cellSize / UNIT_SIZE_FULL_CELL)`. Applies uniformly to every tier, so the
 * S/M/L/XL proportions never change. A missing / non-positive cell size (headless
 * stubs) means "no board constraint" → 1.
 */
export function unitSizeScale(cellSize: number | undefined): number {
  if (cellSize === undefined || !Number.isFinite(cellSize) || cellSize <= 0) return 1;
  return Math.min(1, cellSize / UNIT_SIZE_FULL_CELL);
}

/**
 * On-board height (design px) of a unit type on a board with `cellSize` cells —
 * {@link targetScreenHeight} × {@link unitSizeScale}. The ONE value every battle-board
 * consumer sizes from (unit rig/frame-sheet scale, draft placeholder, HP-bar anchor,
 * drag landing preview); don't re-apply the factor anywhere else.
 */
export function boardUnitHeight(type: UnitType, cellSize: number | undefined): number {
  return targetScreenHeight(type) * unitSizeScale(cellSize);
}

/** Target authoring-space texture height (px) for a unit type. */
export function targetAnimatorHeight(type: UnitType): number {
  return TARGET_ANIMATOR_PX[UNIT_SIZE_TIER[type]];
}
