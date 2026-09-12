// How big the home-city building cards are and how many sit in a row.
//
// Landscape has always been "as many `CARD_W_TARGET`-wide columns as fit, `CARD_H` tall", and that
// is still exactly what it gets. Portrait needed its own answer, because the band the grid lives in
// is a completely different shape there: the scene pins the resource bar + build queue to the top
// and the five team slots to the bottom, and on a 390x844 phone (design space 1080x2337) what is
// left in between is 1699 design px tall while the 12 tiles at four columns only need 600 — the
// grid sat as three rows glued under the build queue with 1099 px (47% of the screen) of blank
// notebook paper below it, and nothing to scroll (measured 2026-09-11, portrait sweep §49).
//
// So in portrait the card height is derived from the band instead of fixed, and the column count is
// chosen to make the resulting card as square as it can be:
//
//   3 cols → 4 rows of 314x415  (aspect 1.32)   ← picked
//   2 cols → 6 rows of 477x273  (aspect 0.57)
//   4 cols → 3 rows of 232x558  (aspect 2.40)
//
// Square-ness rather than "most columns" or "least leftover": with the height derived, every
// candidate fills the band exactly, so the only thing left to prefer is a card that doesn't read as
// a strip. On the 768x1024 tablet the same rule lands on 3 cols x 326-tall cards — aspect 1.04,
// which is the shape the design's own 222x192 card was reaching for.
//
// Two guards:
//   · the card never gets SHORTER than `CARD_H` — a band too small for the content keeps today's
//     fixed card and scrolls, which is what the scroll viewport is for;
//   · it never gets taller than `MAX_ASPECT` x its width — past that the block is centred in the
//     band with the slack split above and below, rather than stretched into a column of towers.

/** Card height may not exceed this multiple of the card width before the grid stops stretching. */
const MAX_ASPECT = 1.45;

export interface GridMetricsInput {
  /** Tiles to lay out (11 buildings + the synthetic train tile today). */
  count: number;
  /** Drawable width for the grid, inside its padding. */
  availW: number;
  /** Height between the build-queue strip and the pinned team row. */
  availH: number;
  gap: number;
  /** Landscape's fixed card height, and portrait's floor. */
  cardH: number;
  /** Landscape's target card width — what the column count is derived from there. */
  cardWTarget: number;
  maxCols: number;
  portrait: boolean;
}

export interface GridMetrics {
  cols: number;
  /** Column width, always the full share of `availW`. */
  cellW: number;
  /** Card height — `cardH` in landscape, band-derived in portrait. */
  cardH: number;
  /** Design px of empty band above the first row (portrait's centring case; 0 otherwise). */
  topPad: number;
}

/** Columns that fit `cardWTarget` — the historical landscape rule. */
function fittingCols(input: GridMetricsInput): number {
  return Math.min(
    input.maxCols,
    Math.max(1, Math.floor((input.availW + input.gap) / (input.cardWTarget + input.gap))),
  );
}

const colWidth = (input: GridMetricsInput, cols: number): number =>
  Math.floor((input.availW - (cols - 1) * input.gap) / cols);

export function gridMetrics(input: GridMetricsInput): GridMetrics {
  const classic = { cols: fittingCols(input), cellW: 0, cardH: input.cardH, topPad: 0 };
  classic.cellW = colWidth(input, classic.cols);
  if (!input.portrait || input.count <= 0 || input.availH <= 0) return classic;

  let best: GridMetrics | null = null;
  let bestScore = Infinity;
  for (let cols = 1; cols <= input.maxCols; cols++) {
    const rows = Math.ceil(input.count / cols);
    const cellW = colWidth(input, cols);
    if (cellW <= 0) continue;
    const filled = Math.floor((input.availH - (rows - 1) * input.gap) / rows);
    // Shorter than the design card means the band cannot hold these rows at all — that is the
    // scrolling case, and it is `classic`'s job, not a candidate here.
    if (filled < input.cardH) continue;
    const cardH = Math.min(filled, Math.round(cellW * MAX_ASPECT));
    const score = Math.abs(cardH / cellW - 1);
    if (score >= bestScore) continue;
    bestScore = score;
    best = {
      cols, cellW, cardH,
      topPad: Math.round((input.availH - (rows * cardH + (rows - 1) * input.gap)) / 2),
    };
  }
  return best ?? classic;
}

/**
 * Where the card's contents sit, as fractions of the card height — the proportions the fixed
 * 192-tall card was drawn with, so a portrait card that grew to 415 keeps the same composition
 * instead of leaving all its new room in one gap at the bottom.
 */
export const CARD_LAYOUT = {
  iconTop: 18 / 192,
  iconSize: 60 / 192,
  nameY: 90 / 192,
  barY: 118 / 192,
  /** Measured UP from the bottom edge, like the original `CARD_H - 33`. */
  subFromBottom: 33 / 192,
  barH: 6 / 192,
  badgeR: 13 / 192,
  queueIcon: 24 / 192,
} as const;
