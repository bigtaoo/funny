// designSize.ts — how wide portrait's design space is for a given screen.
//
// Pure and dependency-free on purpose: `PortraitLayout` builds from it, and the browser layout
// sweep (test/browser/lib/auditBox.ts) has to predict the exact same design rect from a Playwright
// process that cannot import PIXI or `@nw/engine`.
//
// ## Why portrait's width is no longer a fixed 1080 (2026-10-01)
//
// A design px is not a screen px. With the width pinned at 1080, a 390-wide iPhone renders the
// whole UI at 0.36x and a 360-wide Android at 0.33x. The font table already compensates for that
// (render/fontScale.ts lifts and boosts every token toward a CSS-px target), but nothing else did:
// icons, grid cells, paddings and level stars are literal design px, so on a phone they landed at
// a third of their size. Raising each constant does not work — every container that fits its
// children to the width scales them straight back down.
//
// So the width follows the screen instead: aim for {@link PORTRAIT_TARGET_SCALE}, never narrower
// than {@link PORTRAIT_MIN_W}, never wider than the classic {@link REFERENCE_SHORT}. Tablets and
// desktop portrait windows (≥ 540 CSS px wide) still get exactly 1080 and are untouched; phones get
// 720–860, i.e. ~1.4x larger literal geometry. Text barely moves, because the font scale's floor and
// boost already aim at a CSS size and simply have less to add at the larger scale.
//
// Landscape is unchanged: its fixed axis is the 1080 design HEIGHT.

/** The classic short side of both layouts' design rect (portrait width, landscape height). */
export const REFERENCE_SHORT = 1080;

/** The design→screen scale portrait aims for on narrow screens. */
export const PORTRAIT_TARGET_SCALE = 0.5;

/**
 * Floor on portrait's design width. A 320-wide screen would otherwise ask for 640, where two-column
 * grids that fit at 720 stop fitting; below this the scale drops instead (320 → 0.44x).
 */
export const PORTRAIT_MIN_W = 720;

/**
 * Portrait design width for a safe drawable area `availW` CSS px wide: `availW / 0.5`, rounded to an
 * even number, clamped to [{@link PORTRAIT_MIN_W}, {@link REFERENCE_SHORT}].
 */
export function portraitDesignWidth(availW: number): number {
  if (!Number.isFinite(availW) || availW <= 0) return REFERENCE_SHORT;
  const w = 2 * Math.round(availW / PORTRAIT_TARGET_SCALE / 2);
  return Math.min(REFERENCE_SHORT, Math.max(PORTRAIT_MIN_W, w));
}
