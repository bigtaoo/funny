// ── scrollPeek — guaranteed "there's more below" affordance for masked scroll grids ────────────
//
// A masked scroll region's own row/cell sizing is otherwise coincidental relative to the viewport:
// if a row's height happens to roughly match the available height, the next row is skipped by the
// draw-cull entirely and nothing peeks above the fold — the screen just looks "full", with only the
// slim ScrollIndicator thumb (easy to miss) hinting more content exists. peekViewportH clamps the
// *visible* viewport height so that whenever content overflows, the cut always lands mid-row: a
// partial next row/card is always visible, never a razor-flush edge.
//
// Usage in a scene's grid/list draw method:
//   const availH = h - bodyTop - margin;               // naive full viewport height
//   const viewH = peekViewportH(availH, cellH + gap, totalContentH);
//   // ...draw mask sized to bodyTop..bodyTop+viewH (not the full remaining screen)...
//   // ...cull rows/items against bodyTop+viewH instead of the raw screen edge...
//   drawScrollIndicator(container, { x, y: bodyTop, w, h: viewH }, scrollY, Math.max(0, totalContentH - viewH));

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
  const cut = fullRows * unit + Math.round(unit * peekFrac);
  return Math.min(availH, cut);
}
