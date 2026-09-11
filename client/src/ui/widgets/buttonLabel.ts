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
  const text = txt(label, fontSize, color, opts.bold ?? true);
  text.anchor.set(0, 0.5);

  const icSz = Math.round(fontSize * ICON_RATIO);
  const icGap = Math.round(fontSize * GAP_RATIO);
  const fitW = w - (opts.inset ?? 10);

  if (icon && opts.stack) {
    const iconVariant = opts.variant ?? (tabIconVariant(color) === 'active' ? 'active' : 'content');
    const stackSz = Math.round(Math.min(icSz * 1.6, h * 0.46));
    const groupH = stackSz + icGap + text.height;
    const top = y + (h - groupH) / 2;
    const glyph = buildIcon(icon, stackSz, color, { variant: iconVariant });
    glyph.x = Math.round(x + (w - stackSz) / 2);
    glyph.y = Math.round(top);
    target.addChild(glyph);
    const soloFit = Math.min(1, fitW / Math.max(1, text.width));
    text.anchor.set(0.5, 0);
    text.scale.set(soloFit);   // anchored at its centre, so no width read is needed after scaling
    text.x = Math.round(x + w / 2);
    text.y = Math.round(top + stackSz + icGap);
    target.addChild(text);
    return;
  }

  const groupW = icon ? icSz + icGap + text.width : text.width;
  const fit = groupW > fitW ? fitW / groupW : 1;

  if (!icon || fit < (opts.minFit ?? 0.82)) {
    // `text.width` is a live getter over the scale, so it must be read ONCE, before scaling:
    // reading it again afterwards and multiplying by the fit applies the shrink twice, and the
    // label is centred as if it were narrower than it is — i.e. pushed right, past the button's
    // own edge. Every too-long button label in the game was off-centre and overflowing this way
    // (Settings' Rename / Delete Account / Replay tutorial, measured in portrait 2026-09-11).
    const rawW = text.width;
    const soloFit = Math.min(1, fitW / Math.max(1, rawW));
    text.scale.set(soloFit);
    text.x = Math.round(x + (w - rawW * soloFit) / 2);
    text.y = y + h / 2;
    target.addChild(text);
    return;
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
