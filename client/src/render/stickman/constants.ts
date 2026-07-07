// Constants for the StickmanRuntime .tao animation runtime.

/**
 * Fallback uniform scale, used only when a unit's natural height or target height
 * is unknown (no clips / no targetHeight passed). The normal path scales each unit
 * by targetScreenHeight / asset.naturalHeight instead, so same-tier units render at
 * the same screen height regardless of the artist's canvas size (art-direction §4.5.3 A).
 * The animator works in ~200 px natural height; at 0.27 the character is ~50 px tall —
 * which is why the per-tier TARGET_SCREEN_PX values cluster around 0.27 × H_nat.
 */
export const STICKMAN_SCALE = 0.27;

/**
 * Hit-flash outline geometry, in *screen* pixels (per-bone radii derive from
 * these so the line reads the same regardless of each bone's baked scale). The
 * outline is a thin *detached* contour: a paper gap separates the body from the
 * line. Slightly bolder than a hairline since it only ever shows for a brief
 * impact flash, where a punchy ring reads best.
 */
export const OUTLINE_GAP_PX   = 1.0;   // transparent gap between body edge and the line
export const OUTLINE_WIDTH_PX = 2.4;   // thickness of the contour line itself

/** Map logical UnitState values → animation clip names. */
export const STATE_ANIM: Record<string, string> = {
  moving:    'walk',
  attacking: 'attack',
  waiting:   'idle',
  crossing:  'walk',
  dead:      'death',
};
