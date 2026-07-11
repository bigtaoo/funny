// Pure formatting helpers for LobbyScene — kept free of any PIXI import so they
// can be unit-tested under the game-logic vitest config (see client/test/).

/** Compact coin formatting for the header chip (e.g. 1234 → "1,234", 23456 → "23.5k"). */
export function fmtCoins(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return v.toLocaleString('en-US');
}

/** Vertical geometry of the lobby header, resolved from screen size + orientation. */
export interface HeaderMetrics {
  /** Total dark header background height. */
  tbH: number;
  /** Band whose vertical midline the corner chips (profile / account) center on. */
  chipBandH: number;
  /** Y of the logo+title lockup midline. */
  brandMidY: number;
  /** Logo edge length (square). */
  logoSize: number;
  /** Y of the tagline (subtitle) baseline anchor. */
  subtitleY: number;
  /** Fraction of width the profile chip may use before its name label is scaled down. */
  nameMaxFactor: number;
  /** Height of the boiling title underline. */
  ulH: number;
}

/**
 * Header layout math, orientation-branched and PIXI-free so it can be unit-tested.
 *
 * - Landscape (wide): the classic SINGLE row — corner chips and the centered
 *   logo+title lockup share one band, so `chipBandH === tbH`. The large logo
 *   (`tbH*0.9`) and midline (`tbH*0.45`) match the pre-two-row layout exactly.
 * - Portrait (narrow): the lockup drops to its OWN row below the chip band, since
 *   it is wider than the gap between the two corner chips.
 */
export function headerMetrics(w: number, h: number, portrait: boolean): HeaderMetrics {
  if (portrait) {
    const brandRowH = Math.round(h * 0.09);
    const chipBandH = Math.round(h * 0.16);
    return {
      chipBandH,
      tbH: chipBandH + brandRowH,
      brandMidY: chipBandH + Math.round(brandRowH * 0.34),
      logoSize: Math.round(brandRowH * 0.9),
      subtitleY: chipBandH + Math.round(brandRowH * 0.82),
      nameMaxFactor: 0.5,
      ulH: Math.round(h * 0.015),
    };
  }
  const tbH = Math.round(h * 0.16);
  return {
    chipBandH: tbH,
    tbH,
    brandMidY: Math.round(tbH * 0.45),
    logoSize: Math.round(tbH * 0.9),
    subtitleY: Math.round(tbH * 0.78),
    nameMaxFactor: 0.36,
    ulH: Math.round(h * 0.02),
  };
}
