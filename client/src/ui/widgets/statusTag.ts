/**
 * statusTag.ts — the one true `[icon][gap][word]` group for a row's STATE, and the mirror image of
 * `buttonLabel.ts`.
 *
 * A button and a status tag look alike and degrade in opposite directions, which is why they are
 * two functions and not one:
 *
 *   - a BUTTON is a promise about what a tap does, so the word is the payload. When the box is too
 *     narrow, `drawButtonLabel` drops the ICON and keeps the word at full size (`minFit`).
 *   - a STATUS TAG is a fact the row already half-tells through its own fill, border and position.
 *     When the box is too narrow it drops the WORD and keeps the glyph. A check mark on a green
 *     card says "done" without help; "Done" spelled out next to it is the same sentence twice.
 *
 * Neither ever shrinks below the legibility floor, and this one cannot shrink at all: the glyph is
 * drawn at `ICON_RATIO × fontSize`, i.e. bigger than the text it replaces, so a tag that degrades
 * always clears the audit's icon gate whenever the word it replaced cleared the text gate
 * (testing/layoutAudit.ts — "an unreadable glyph is just a smudge").
 *
 * **The trigger is measured width, never `layout.orientation`.** Portrait is only the loudest of
 * three ways a tag runs out of room; the other two reach landscape as well. German is the longest
 * of the three locales word for word ("Gesperrt" reserved 282 px of a 465-wide battle-pass cell and
 * shoved the reward's `×N` through it — sweep §50.12), and Chinese is full-width with no space to
 * wrap at. An `if (this.landscape)` branch fixes one third of the problem and hides the rest, which
 * is the same mistake `drawButtonLabel`'s header and DailyScene's claim button already record.
 *
 * Only for states that have a glyph a player reads without being taught it — done/claimed (`check`)
 * and locked (`lock`). A set of seven mutually exclusive outcomes with no convention behind them
 * (the auction's Sold / Cancelled / Expired / Leading / Outbid / Won / Lost) stays words at every
 * width: an icon-only tag there is a riddle, not a summary.
 */
import * as PIXI from 'pixi.js-legacy';
import { txt } from '../../render/sketchUi';
import { buildIcon, tabIconVariant, type IconKind, type RasterIconVariant } from '../../render/icons';

/** Glyph box as a multiple of the font size, and the gap between glyph and word. Matches `buttonLabel`. */
const ICON_RATIO = 1.35;
const GAP_RATIO = 0.3;

export interface StatusTagOpts {
  /** Bold word (default true — a status tag is a highlight, not body copy). */
  bold?: boolean;
  /** Ink cut for a raster icon; ink glyphs (`check`, `lock`) ignore it and take `color` literally. */
  variant?: RasterIconVariant;
  /**
   * Where the group sits in the box (default `'right'`). Status tags are right-anchored nearly
   * everywhere — the row's own content grows from the left — but a full-width "claimed" banner
   * (the mail reader) is centred.
   */
  align?: 'left' | 'center' | 'right';
}

/**
 * Draw `[icon][gap][word]` inside the box `(x, y, w, h)`, vertically centred, degrading to the
 * glyph alone when the pair does not fit.
 *
 * @returns the width the group actually occupies, so the caller can reserve exactly that much of
 *   the row for it (see `BattlePassScene/cell.ts`, where the reward band is what is left over).
 */
export function drawStatusTag(
  target: PIXI.Container,
  x: number, y: number, w: number, h: number,
  label: string, icon: IconKind, color: number, fontSize: number,
  opts: StatusTagOpts = {},
): number {
  const size = Math.round(fontSize);
  const icSz = Math.round(size * ICON_RATIO);
  const icGap = Math.round(size * GAP_RATIO);
  const variant = opts.variant ?? (tabIconVariant(color) === 'active' ? 'active' : 'content');

  const text = txt(label, size, color, opts.bold ?? true);
  const pairW = icSz + icGap + text.width;
  // The glyph alone is never dropped and never scaled: a box too narrow even for it is a layout
  // bug for the sweep to report, not something to quietly render as a smudge.
  const useWord = pairW <= w;
  const groupW = useWord ? pairW : icSz;

  const left = opts.align === 'left' ? x
    : opts.align === 'center' ? x + (w - groupW) / 2
      : x + w - groupW;

  const glyph = buildIcon(icon, icSz, color, { variant });
  glyph.x = Math.round(left);
  glyph.y = Math.round(y + (h - icSz) / 2);
  target.addChild(glyph);

  if (useWord) {
    text.anchor.set(0, 0.5);
    text.x = Math.round(left + icSz + icGap);
    text.y = Math.round(y + h / 2);
    target.addChild(text);
  } else {
    text.destroy({ texture: true, baseTexture: true });
  }

  return groupW;
}
