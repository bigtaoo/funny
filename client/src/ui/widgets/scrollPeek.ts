// ── scrollPeek — guaranteed "there's more below" affordance for masked scroll grids ────────────
//
// A masked scroll region's own row/cell sizing is otherwise coincidental relative to the viewport:
// if a row's height happens to roughly match the available height, the next row is skipped by the
// draw-cull entirely and nothing peeks above the fold — the screen just looks "full", with only the
// slim ScrollIndicator thumb (easy to miss) hinting more content exists. peekViewportH ensures the
// *visible* viewport height always cuts mid-row when content overflows, so a partial next row/card is
// visible rather than a razor-flush edge — but ONLY intervenes when the naive viewport doesn't already
// leave a comfortable partial row showing. When it does, the full height is kept: over-shrinking to a
// fixed peek fraction would waste a band of viewport below the fold that reads as "end of list".
//
// Usage in a scene's grid/list draw method:
//   const availH = h - bodyTop - margin;               // naive full viewport height
//   const viewH = peekViewportH(availH, cellH + gap, totalContentH);
//   // ...draw mask sized to bodyTop..bodyTop+viewH (not the full remaining screen)...
//   // ...cull rows/items against bodyTop+viewH instead of the raw screen edge...
//   drawScrollIndicator(container, { x, y: bodyTop, w, h: viewH }, scrollY, Math.max(0, totalContentH - viewH));

/**
 * Smallest naive remainder (design px) that already reads as an intentional cut rather than a
 * razor-flush edge or a sub-pixel rounding artifact. Below this, `peekViewportH` backs the
 * viewport off a full row to manufacture a clean `peekFrac` reveal; at or above it, the natural
 * remainder is left untouched — see the 2026-08-10 fix note below for why.
 */
const MIN_VISIBLE_REM = 12;

/**
 * Clamp `availH` down to a height that always cuts mid-row when content overflows, so a fraction of
 * the next row/item is visible above the fold instead of landing flush with the viewport edge.
 *
 * @param availH    Naive full viewport height (e.g. `h - bodyTop - margin`).
 * @param unit      Row/item pitch — `cellH + gap` for a grid, `itemH + gap` for a list.
 * @param contentH  Total content height (all rows/items stacked, no scroll offset).
 * @param peekFrac  Fraction of one row/item's pitch left poking above the fold. Default 0.28 —
 *                  enough to read as "a cut-off card", not so much it wastes a full row of space.
 * @returns The viewport height to actually mask/cull/scroll against. Equal to `availH` untouched
 *          when everything already fits (`contentH <= availH`) or `unit` is degenerate.
 */
export function peekViewportH(availH: number, unit: number, contentH: number, peekFrac = 0.28): number {
  if (unit <= 0 || contentH <= availH) return availH;
  const fullRows = Math.max(1, Math.floor(availH / unit));
  // `rem` is the partial row height the *naive* viewport already leaves poking above the fold.
  const rem = availH - fullRows * unit; // in [0, unit)
  // Any already-visible sliver (rem >= MIN_VISIBLE_REM) already defeats the "screen looks 100%
  // full" failure this guards against — keep the full height untouched. (2026-08-10 fix: this used
  // to require `rem >= peekFrac*unit`, i.e. a *comfortable* ~28%-tall peek, and otherwise backed the
  // viewport off a full extra row to manufacture one — e.g. Shop's Coins tab in portrait at a squat
  // aspect had `rem` land around 7% of a (tall, image-heavy) card's height: not "comfortable" by that
  // bar, so the old code discarded an entire *already-fully-fitting* row's buttons and left a
  // permanent dead gap of unrendered background below the fold — reported as "the bottom half of the
  // recharge page is blocked". A thin-but-nonzero natural peek is strictly better than that trade:
  // it wastes zero space and never hides a row that already fit. Only a true near-flush cut, where
  // the naive remainder is small enough to be visually indistinguishable from 0, still needs the
  // manufactured peek below.)
  if (rem >= MIN_VISIBLE_REM) return availH;
  // Near-flush: the naive cut lands ~on a row boundary, so nothing meaningful peeks and the screen
  // reads as "full". Drop that flush row and land the cut a clean `peekFrac` into the row below it —
  // but only when a full row survives (with just one row visible, shrinking would hide it entirely).
  if (fullRows <= 1) return availH;
  const peek = Math.round(unit * peekFrac);
  return (fullRows - 1) * unit + peek;
}
