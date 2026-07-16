/**
 * fontScale.ts — the single source of truth for in-game font sizes.
 *
 * Before this, font sizes were set ~590 different times across 61 files with no
 * shared table: `txt(label, 12, …)` / `fontSize: 14` fixed literals (23 distinct
 * values, 9–60px) mixed with responsive `Math.round(h * 0.026)` expressions (48
 * distinct fraction multipliers against a grab-bag of base dimensions). The same
 * *semantic* piece of text — a card subtitle, say — was 12px in one scene, 13px
 * in another, `0.024 * h` in a third. Re-tuning "all the small labels" meant a
 * global grep.
 *
 * This module collapses that into ONE semantic scale. Every scene sizes text by
 * intent — `FS.body`, `FS.title` — not by a magic number, and the whole game's
 * typography is re-tuned from the nine numbers below. All values are in the 1080
 * design-coordinate space that both {@link LandscapeLayout} (designHeight 1080)
 * and {@link PortraitLayout} (designWidth 1080) render into, so a token means the
 * same rendered size in either orientation.
 *
 * The tokens are ordered small→large and each covers the raw-px band noted beside
 * it (the band the old scattered values fell in, snapped to the tier). To change
 * how big "body text" is everywhere, edit the number here — nowhere else.
 */

/** The semantic font scale. Sizes are design px (1080-space). */
export const FS = {
  /** ≤11 — fine print: unit counters, timers, "/cap" suffixes, tiny badges. */
  micro: 11,
  /** 12–14 — secondary labels, hints, cost lines, dense metadata. */
  tiny: 13,
  /** 15–16 — compact body / dense list rows. */
  small: 16,
  /** 17–18 — default body text and standard button labels. */
  body: 18,
  /** 19–21 — emphasized body, item / card names. */
  bodyLg: 20,
  /** 22–25 — section labels, sub-headings, list-group titles. */
  label: 24,
  /** 26–29 — panel headings, prominent counters. */
  heading: 28,
  /** 30–35 — scene / panel titles. */
  title: 32,
  /** 36–47 — hero titles, toasts, headline callouts. */
  headline: 42,
  /** ≥48 — splash / result numbers. */
  display: 60,
} as const;

/** A font-scale token name (e.g. `'body'`). */
export type FontToken = keyof typeof FS;

/** Ordered (token, px) pairs, small → large. */
const TIERS: ReadonlyArray<readonly [FontToken, number]> = (
  Object.entries(FS) as Array<[FontToken, number]>
).sort((a, b) => a[1] - b[1]);

/**
 * Snap an arbitrary pixel size to the nearest scale token. Kept for the handful
 * of call sites whose size is genuinely computed at runtime (e.g. text scaled to
 * fill a variable-height control): pass the computed px through here so it still
 * lands on the shared scale rather than reintroducing an off-scale value.
 *
 * Ties round up to the larger tier (legibility over compactness).
 */
export function snapFont(px: number): number {
  let best = TIERS[0];
  let bestDist = Infinity;
  for (const tier of TIERS) {
    const d = Math.abs(tier[1] - px);
    if (d < bestDist || (d === bestDist && tier[1] > best[1])) {
      best = tier;
      bestDist = d;
    }
  }
  return best[1];
}
