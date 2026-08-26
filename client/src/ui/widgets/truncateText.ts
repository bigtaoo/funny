/**
 * truncateText.ts — fit one unwrapped line of text into an available pixel width.
 *
 * The alternative every caller reaches for first is a character cap (`s.slice(0, 60)`), and it is
 * always wrong: a cap is a *count*, while what actually clips the glyphs is the width of whatever
 * column the line sits in. The two disagree by more than 2× between scripts — at the same font
 * size a CJK glyph is about twice as wide as a Latin one — so a cap tuned to look right in one
 * locale cuts mid-word in another, and tuned for the widest column it does nothing at all in the
 * narrow one. See chatRow.ts, which shipped exactly that bug.
 *
 * Measuring goes through `PIXI.TextMetrics`, not through building a throwaway `PIXI.Text` per
 * candidate: TextMetrics computes layout without rasterizing a canvas texture (same reason
 * ChatScene/thread.ts measures its bubbles that way), and the widths it reports match what a real
 * `txt()` node will report — `makeText()`'s CJK anti-clip padding is deliberately excluded from
 * width/height (see render/pixiText.ts). A binary search then needs ~log2(n) measurements instead
 * of the one-Text-per-removed-character loop this replaces.
 */
import * as PIXI from 'pixi.js-legacy';
import { txt } from '../../render/sketchUi';

const ELLIPSIS = '…';

/** The style `txt()` builds, minus everything that cannot affect advance width. */
function styleFor(size: number, bold: boolean): PIXI.TextStyle {
  return new PIXI.TextStyle({
    fontSize: size, fontFamily: 'monospace', fontWeight: bold ? 'bold' : 'normal',
  });
}

/**
 * The longest prefix of `label` that fits `maxW`, with `…` appended when anything was dropped.
 * Returned unchanged when it already fits, so a caller cannot tell a short line from a lucky one.
 */
export function fitToWidth(label: string, size: number, maxW: number, bold = false): string {
  const style = styleFor(size, bold);
  const widthOf = (s: string): number => PIXI.TextMetrics.measureText(s, style).width;
  if (widthOf(label) <= maxW) return label;

  // Cut on code points, not UTF-16 units: an emoji in a player-chosen name is a surrogate pair, and
  // slicing between its halves leaves a lone surrogate that renders as tofu.
  const chars = Array.from(label);
  // Longest fitting prefix: `lo` is known to fit (or is 0), `hi` is known not to.
  let lo = 0;
  let hi = chars.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (widthOf(chars.slice(0, mid).join('') + ELLIPSIS) <= maxW) lo = mid;
    else hi = mid;
  }
  // `lo === 0` means not even one character plus the ellipsis fits. Emit the bare ellipsis rather
  // than an empty string: a slot that narrow is a layout bug upstream, and a blank line hides it.
  return chars.slice(0, lo).join('') + ELLIPSIS;
}

/** {@link fitToWidth} as a ready-to-place `PIXI.Text` — the common case. */
export function truncateToWidth(label: string, size: number, color: number, maxW: number): PIXI.Text {
  return txt(fitToWidth(label, size, maxW), size, color);
}
