/**
 * buttonLabel.ts — the one true `[icon][gap][label]` group for a button's contents.
 *
 * Every full-screen scene already shares ONE button *background* (`sketchButton`/`sketchPanel`,
 * UI_DESIGN §7.5) but each one drew its own *contents*: a single centred `txt()`. Meanwhile four
 * places had independently grown the icon+label shape — EquipmentScene's Craft button, the world
 * map's header entries, the result screen's actions, and the campaign header's shortcuts — each
 * with its own icon ratio, gap and overflow behaviour. This module is that shape, once:
 *
 *   - the icon and the label are laid out as ONE group, centred in the button box;
 *   - when the group is wider than the box the WHOLE group scales down (icon included) rather
 *     than the label wrapping, spilling, or the icon shoving the text out — German labels
 *     ("Ausrüstung", "Schmieden") are what actually reach the edge;
 *   - `icon: null` degrades to exactly what the scenes did before: one centred label.
 *
 * Raster tab icons bake their ink at pack time, so the variant matters and cannot be tinted:
 * `tabIconVariant` reads the LABEL colour, which is right for white-on-dark and ink-on-paper but
 * wrong for the gold-on-dark pills (gold's luma is 0.59, so it selects the washed-out `inactive`
 * grey and the glyph all but vanishes on the ink fill). Callers on a dark fill therefore pass
 * `variant: 'active'` explicitly — see UI_DESIGN §2.
 */
import * as PIXI from 'pixi.js-legacy';
import { txt } from '../../render/sketchUi';
import { fitFont, currentFontFloor } from '../../render/fontScale';
import { buildIcon, tabIconVariant, type IconKind, type RasterIconVariant } from '../../render/icons';

/** Icon box as a multiple of the font size, and the gap between icon and label. */
const ICON_RATIO = 1.35;
const GAP_RATIO = 0.3;

/**
 * Width the glyph + gap add to a label at `fontSize`. Buttons that size themselves to their text
 * (the sect header's ally pills) add this before measuring, so the group isn't scaled down inside
 * a pill that was only ever sized for the words.
 */
export function buttonLabelIconW(fontSize: number): number {
  return Math.round(fontSize * ICON_RATIO) + Math.round(fontSize * GAP_RATIO);
}

export interface ButtonLabelOpts {
  /** Bold label (default true — button labels are bold nearly everywhere). */
  bold?: boolean;
  /**
   * Ink cut for a raster icon. Pass `'active'` (the light cut) for any button with a DARK fill;
   * omit on paper-fill buttons to let the label colour decide. Ignored by tinted ink icons.
   */
  variant?: RasterIconVariant;
  /** Horizontal breathing room reserved inside the box, in px (default 10). */
  inset?: number;
  /**
   * Below this scale factor the icon is DROPPED and the label is drawn alone at full size
   * (default 0.82). A list-row button sized for two CJK characters cannot also hold a glyph:
   * scaling the group to fit would shrink the label past legibility, which is a worse button
   * than one with no icon. So "add an icon everywhere" degrades per button, at its real width,
   * instead of needing a hand-maintained list of which call sites are too narrow.
   */
  minFit?: number;
  /**
   * Stack the glyph ABOVE the label instead of beside it. For square cells (the lobby's side
   * strip) — a row layout there would be scaled down to nothing by `minFit`, while a column has
   * the room for both.
   */
  stack?: boolean;
}

/**
 * Draw `[icon][gap][label]` centred in the box `(x, y, w, h)`, scaling the group down to fit.
 * Adds its nodes to `target`; the caller owns the background and the hit rect.
 */
export function drawButtonLabel(
  target: PIXI.Container,
  x: number, y: number, w: number, h: number,
  label: string, icon: IconKind | null, color: number, fontSize: number,
  opts: ButtonLabelOpts = {},
): void {
  const bold = opts.bold ?? true;
  const fitW = w - (opts.inset ?? 10);

  let size = fontSize;
  let text = txt(label, size, color, bold);
  text.anchor.set(0, 0.5);

  /**
   * Re-mint the label smaller when shrinking the built group WOULD break the font scale's
   * legibility floor, and only then.
   *
   * Every branch below fits by scaling what it already built, which multiplies the size by an
   * arbitrary float: on a phone held sideways (0.36x) that put the lobby strip's "Feedback" at 17.6
   * design px, under the 20 that viewport's floor promises (layout sweep §49). `fitFont` picks a
   * size off the shared scale instead and stops at the floor.
   *
   * Gated on the floor rather than applied eagerly, because the two degradations are not
   * interchangeable and the existing one is deliberate: a button that cannot hold [icon][label]
   * drops the ICON and keeps the label at full size (see `minFit`). Stepping the size down first
   * would quietly reverse that everywhere — on a desktop window, where the floor is the raw
   * `FS.micro` and no shrink ever breaches it, this changes nothing at all.
   *
   * @param need width the group wants at the CURRENT size
   * @returns true if the label was re-minted, so the caller re-reads its width
   */
  const floorFit = (need: number): boolean => {
    if (need <= fitW || (fitW / need) * size >= currentFontFloor()) return false;
    const fitted = fitFont(size, need, fitW);
    if (fitted >= size) return false;
    const { x: ax, y: ay } = text.anchor;
    text.destroy({ texture: true, baseTexture: true });
    size = fitted;
    text = txt(label, size, color, bold);
    text.anchor.set(ax, ay);
    return true;
  };

  let icSz = Math.round(size * ICON_RATIO);
  let icGap = Math.round(size * GAP_RATIO);

  if (icon && opts.stack) {
    const iconVariant = opts.variant ?? (tabIconVariant(color) === 'active' ? 'active' : 'content');
    // Only the label costs width here — the glyph is above it, not beside it.
    if (floorFit(text.width)) {
      icSz = Math.round(size * ICON_RATIO);
      icGap = Math.round(size * GAP_RATIO);
    }
    const soloFit = Math.min(1, fitW / Math.max(1, text.width));
    // A cell that cannot hold the word at a LEGIBLE size gets the glyph ALONE, bigger. This is the
    // stack-path counterpart of `minFit` below, and it has the same shape of argument: the lobby
    // strip's font is derived from its square cell (0.30x), so an 8-character word is 1.44x the
    // cell at ANY viewport and this path has always shrunk it — fine at 0.61 of a desktop's 28px,
    // illegible at 0.61 of a phone-in-landscape's, where the floor is 20. So the test is the floor,
    // not the fit: every viewport that was fine stays exactly as it was, and the one that was not
    // gets the destination's own glyph, which is what a player recognises anyway. The badge layer
    // still marks state.
    if (soloFit * size < currentFontFloor()) {
      text.destroy({ texture: true, baseTexture: true });
      const soloSz = Math.round(Math.min(icSz * 2.2, h * 0.62));
      const glyphOnly = buildIcon(icon, soloSz, color, { variant: iconVariant });
      glyphOnly.x = Math.round(x + (w - soloSz) / 2);
      glyphOnly.y = Math.round(y + (h - soloSz) / 2);
      target.addChild(glyphOnly);
      return;
    }
    const stackSz = Math.round(Math.min(icSz * 1.6, h * 0.46));
    const groupH = stackSz + icGap + text.height;
    const top = y + (h - groupH) / 2;
    const glyph = buildIcon(icon, stackSz, color, { variant: iconVariant });
    glyph.x = Math.round(x + (w - stackSz) / 2);
    glyph.y = Math.round(top);
    target.addChild(glyph);
    text.anchor.set(0.5, 0);
    text.scale.set(soloFit);   // anchored at its centre, so no width read is needed after scaling
    text.x = Math.round(x + w / 2);
    text.y = Math.round(top + stackSz + icGap);
    target.addChild(text);
    return;
  }

  let groupW = icon ? icSz + icGap + text.width : text.width;
  let fit = groupW > fitW ? fitW / groupW : 1;

  // `minFit` is a fixed guess at "this shrink is too much"; the legibility floor is the same
  // judgement measured (render/fontScale.ts). Either one drops the icon: the defense editor's
  // 70-px footer buttons needed 0.89 on a tablet, which clears 0.82 and still put "Clear" at 14.2
  // design px, under that viewport's floor of 16 (layout sweep §49). Without the icon the label
  // fits outright at full size.
  if (!icon || fit < (opts.minFit ?? 0.82) || fit * size < currentFontFloor()) {
    // `text.width` is a live getter over the scale, so it must be read ONCE, before scaling:
    // reading it again afterwards and multiplying by the fit applies the shrink twice, and the
    // label is centred as if it were narrower than it is — i.e. pushed right, past the button's
    // own edge. Every too-long button label in the game was off-centre and overflowing this way
    // (Settings' Rename / Delete Account / Replay tutorial, measured in portrait 2026-09-11).
    floorFit(text.width);
    const rawW = text.width;
    const soloFit = Math.min(1, fitW / Math.max(1, rawW));
    text.scale.set(soloFit);
    text.x = Math.round(x + (w - rawW * soloFit) / 2);
    text.y = y + h / 2;
    target.addChild(text);
    return;
  }

  // The group fits, but only by scaling; re-mint if that scale would put the label under the floor.
  if (floorFit(groupW)) {
    icSz = Math.round(size * ICON_RATIO);
    icGap = Math.round(size * GAP_RATIO);
    groupW = icSz + icGap + text.width;
    fit = groupW > fitW ? fitW / groupW : 1;
  }

  const groupX = x + (w - groupW * fit) / 2;

  const glyph = buildIcon(icon, icSz, color, {
    variant: opts.variant ?? (tabIconVariant(color) === 'active' ? 'active' : 'content'),
  });
  glyph.scale.set(fit);
  glyph.x = Math.round(groupX);
  glyph.y = Math.round(y + (h - icSz * fit) / 2);
  target.addChild(glyph);

  text.scale.set(fit);
  text.x = Math.round(groupX + (icSz + icGap) * fit);
  text.y = y + h / 2;
  target.addChild(text);
}
