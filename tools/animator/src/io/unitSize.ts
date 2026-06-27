/**
 * Unit height standard — MIRROR of the game's single source of truth at
 * `client/src/render/unitSize.ts` (the animator is a separate package and cannot
 * import across it). The numbers here MUST match that file; design record is
 * art-direction.md §4.5.1. If a tier's target height changes, change it there
 * first, then sync this mirror.
 *
 * Used by the export bake-down (IOController) to size textures to the absolute
 * target display resolution instead of the artist's arbitrary canvas size
 * (art-direction §4.5.3 B). The artist picks the tier in the export panel.
 */

export type SizeTierKey = 'S' | 'M' | 'L' | 'XL';

/**
 * Target on-screen height (px) per tier. Mirror of TARGET_SCREEN_PX in
 * client/src/render/unitSize.ts — S 0.85× · M 1.00× · L 1.18× · XL 1.50×.
 * The export bake uses SCREEN px (not authoring px): the figure's baked texture
 * footprint becomes TARGET_SCREEN_PX × SUPERSAMPLE, matched to what the runtime
 * actually displays after it scales the rig to TARGET_SCREEN_PX (coupling §4.5.3).
 */
export const TARGET_SCREEN_PX: Record<SizeTierKey, number> = {
  S:  46,
  M:  54,
  L:  64,
  XL: 81,
};

/**
 * Texture supersample factor — keeps the figure crisp on high-DPR screens.
 * Replaces the old ad-hoc 1.5 export headroom with a principled knob.
 * Mirror of SUPERSAMPLE in client/src/render/unitSize.ts.
 */
export const SUPERSAMPLE = 2;

/** Tier labels for the export dropdown (XL is mythic-creature only — §4.5.2). */
export const SIZE_TIER_LABELS: Record<SizeTierKey, string> = {
  S:  'S · 小个子 (远程/飞行)',
  M:  'M · 普通 (基准)',
  L:  'L · 高个子 (盾位/重击)',
  XL: 'XL · 巨型 (仅神话生物)',
};
