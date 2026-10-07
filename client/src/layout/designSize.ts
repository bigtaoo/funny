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
// Landscape follows the same rule on its short axis, the design HEIGHT (2026-10-01, same ADR): a
// phone held sideways (844x390) used to render at 0.36x exactly like the old portrait; it now gets a
// 780-tall design and the long axis scales its 1920/2592 bounds by the same factor.
//
// ## Why landscape has its own target since 2026-10-07
//
// Reusing portrait's 0.5 left the CrazyGames reviewer's real canvas (1100x574) at 0.53x — 574 CSS px
// asks for 1148, which clamps to 1080 — so body text was 9.6 CSS px and fine print 8.5 on a laptop
// screen, and the portal's 722x406 preview tile sat at 0.50x. A landscape window is read from
// further away than a phone in the hand and has width to spare (the long axis follows the aspect),
// so it can afford a larger scale than portrait, whose width is what every grid is packed against.
// Landscape therefore aims for {@link LANDSCAPE_TARGET_SCALE} (0.62) with its own floor
// {@link LANDSCAPE_MIN_H} (640): 1100x574 → 926 tall at 0.62x, 722x406 → 654 at 0.62x, a phone held
// sideways (844x390) → 640 at 0.61x. Anything ≥ ~670 CSS px tall still asks for ≥ 1080 and is
// untouched (1280x720, 1366x768, 1920x1080, tablets). Portrait keeps 0.5 / 720.

/** The classic short side of both layouts' design rect (portrait width, landscape height). */
export const REFERENCE_SHORT = 1080;

/** The design→screen scale portrait aims for on its short axis (the width) on small screens. */
export const PORTRAIT_TARGET_SCALE = 0.5;

/**
 * The design→screen scale landscape aims for on its short axis (the height) on small screens —
 * larger than portrait's, see the header's 2026-10-07 section. Every landscape viewport under
 * ~670 CSS px tall lands on it (or on the floor below); taller ones keep the 1080 reference.
 */
export const LANDSCAPE_TARGET_SCALE = 0.62;

/**
 * Floor on landscape's design height. At 0.62 a 360-tall phone held sideways would ask for 580,
 * where the board's side margins (the ink/HP and refresh/upgrade columns, both `× k`) get too narrow
 * for their literal-size text; below this the scale drops instead (360 → 0.56x).
 */
export const LANDSCAPE_MIN_H = 640;

/**
 * Floor on the design short side. A 320-wide screen would otherwise ask for 640, where two-column
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

/**
 * Landscape design height for a safe drawable area `availH` CSS px tall: `availH / 0.62`, rounded to
 * an even number, clamped to [{@link LANDSCAPE_MIN_H}, {@link REFERENCE_SHORT}] — portrait's rule
 * with landscape's own target and floor. ≥ ~670 CSS px tall stays 1080.
 */
export function landscapeDesignHeight(availH: number): number {
  if (!Number.isFinite(availH) || availH <= 0) return REFERENCE_SHORT;
  const h = 2 * Math.round(availH / LANDSCAPE_TARGET_SCALE / 2);
  return Math.min(REFERENCE_SHORT, Math.max(LANDSCAPE_MIN_H, h));
}

/**
 * LandscapeLayout's long-axis floor at the 1080 reference (scaled by `designHeight / 1080`): classic
 * 16:9, so squatter screens get exactly the historical board.
 */
export const LANDSCAPE_REFERENCE_W = 1920;

/**
 * Long-axis ceiling at the 1080 reference — 2.4:1 — scaled the same way. Every real phone held
 * sideways lands under it (16:9 is 1.78, iPhone 13 is 2.16, the widest shipping 21:9 is 2.33). What
 * is NOT a phone aspect is an in-app WebView cropped by its host's chrome: the 2026-08-25 crash loop
 * was a 750x270 viewport (2.78:1) that, uncapped, asked for a design rect 56% wider than the
 * reference — all of it empty paper beside the board, and 56% more pixels in every page-sized
 * texture (render/bake.ts). Past the cap the game contains to height and `ScalingManager` paints the
 * desk surround in the side bands.
 */
export const LANDSCAPE_MAX_W = 2592;

/**
 * Landscape design width for a safe area `availW`×`availH`: the height from
 * {@link landscapeDesignHeight}, the width tracking the aspect between the scaled 1920 and 2592.
 * Shared with the browser sweep for the same reason as the portrait rule.
 */
export function landscapeDesignWidth(availW: number, availH: number): number {
  const h = landscapeDesignHeight(availH);
  const k = h / REFERENCE_SHORT;
  const aspectW = Math.round(h * (availW / Math.max(1, availH)));
  return Math.min(Math.round(LANDSCAPE_MAX_W * k), Math.max(Math.round(LANDSCAPE_REFERENCE_W * k), aspectW));
}
