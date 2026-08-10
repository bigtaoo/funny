// Pure formatting helpers for LobbyScene — kept free of any PIXI import so they
// can be unit-tested under the game-logic vitest config (see client/test/).

/**
 * Full coin formatting for the header chip — always shows the exact balance with
 * thousands separators (e.g. 1234 → "1,234", 97084000 → "97,084,000"). Previously
 * abbreviated large balances to "97.1k"-style strings; players want to see the
 * real number, not a rounded approximation.
 */
export function fmtCoins(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return v.toLocaleString('en-US');
}

/** Vertical geometry of the lobby header, resolved from screen size + orientation. */
export interface HeaderMetrics {
  /** Total dark header background height. */
  tbH: number;
  /** Band whose vertical midline the corner chips (profile / account) center on. */
  chipBandH: number;
  /** Y where the chip band starts (0 when it shares the single landscape row). */
  chipBandY: number;
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
 * - Portrait (narrow): the brand lockup gets its OWN row on top (logo is wider
 *   than the gap a shared row would leave); the identity chip band (avatar +
 *   coins + rank, all side-by-side now) sits in its own row right below it.
 *   The chip band no longer needs to fit two stacked sub-rows (coins/rank used
 *   to stack vertically in the corner), so it's shallower than before — that
 *   freed height goes to the hero/pillar buttons in build.ts.
 */
export function headerMetrics(w: number, h: number, portrait: boolean): HeaderMetrics {
  if (portrait) {
    const brandRowH = Math.round(h * 0.09);
    const chipBandH = Math.round(h * 0.12);
    return {
      chipBandH,
      chipBandY: brandRowH,
      tbH: brandRowH + chipBandH,
      brandMidY: Math.round(brandRowH * 0.34),
      logoSize: Math.round(brandRowH * 0.9),
      subtitleY: Math.round(brandRowH * 0.82),
      nameMaxFactor: 0.5,
      ulH: Math.round(h * 0.015),
    };
  }
  const tbH = Math.round(h * 0.16);
  return {
    chipBandH: tbH,
    chipBandY: 0,
    tbH,
    brandMidY: Math.round(tbH * 0.45),
    logoSize: Math.round(tbH * 0.9),
    subtitleY: Math.round(tbH * 0.78),
    nameMaxFactor: 0.36,
    ulH: Math.round(h * 0.02),
  };
}
