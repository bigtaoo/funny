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
 *   - ...but only down to the legibility floor. Past it the label WRAPS to two lines if it has a
 *     space to break at and the box is tall enough, and otherwise stops at the floor and overflows.
 *     See {@link splitButtonLabel} and the decision it implements
 *     (design/game/UI_DESIGN_LOG_2026-08.md §50.12): wrap first, then abbreviate the string in
 *     `i18n/locales/de.ts` — never shrink past the floor, never truncate a button with an ellipsis;
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

/**
 * Split `label` into the two most balanced lines a space allows, or `null` when there is no space
 * to break at.
 *
 * Balanced rather than greedy because a button is centred, not a paragraph: "Sekten durchsuchen"
 * reads as two stacked words, while a greedy fill would put "Sekten" alone on a line only when the
 * box happened to be that narrow. `null` is the honest answer for a single German compound
 * ("Schmieden") and for every CJK label — nothing in the string offers a break, so wrapping is not
 * one of the options at that call site and the fix is a wider button or a shorter word.
 *
 * Character counts, not measured widths: the UI font is monospace everywhere (render/sketchUi.ts),
 * which is the same property `fitFont` is built on.
 */
export function splitButtonLabel(label: string): [string, string] | null {
  const words = label.split(' ').filter((s) => s.length > 0);
  if (words.length < 2) return null;
  let bestAt = 1;
  let bestCost = Infinity;
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ').length;
    const tail = words.slice(i).join(' ').length;
    const cost = Math.max(head, tail);
    if (cost < bestCost) { bestCost = cost; bestAt = i; }
  }
  return [words.slice(0, bestAt).join(' '), words.slice(bestAt).join(' ')];
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

  /**
   * What ONE line can still do at best: the label by itself, with the icon dropped. That — not the
   * group's `fit` — is the thing wrapping has to beat, because dropping the icon is already an
   * answer this function gives (see `minFit` below) and it is the cheaper one.
   */
  const soloScale = Math.min(1, fitW / Math.max(1, text.width));

  // ── Two lines, at the floor, before any of the shrinking branches below ──────────────────────
  //
  // Reached only when one line cannot hold the label without breaching the floor, so nothing that
  // fits today changes shape: on every viewport and locale that was already legible this test is
  // false and the code below runs exactly as it did. What it replaces is the silent alternative —
  // `scale.set(avail / need)` putting "Schmieden" at 14 design px on a 360-wide phone, measured at
  // 0.71 in the portrait sweep (§50.12). Two lines keep the size; the button only has to be tall
  // enough, which is the cheap half of the trade ("按钮长高一点没关系", 2026-09-12 ruling).
  //
  // The icon is dropped first if that is what makes the block fit, for the same reason `minFit`
  // drops it below: a glyph the player can also read off the button's neighbours is worth less
  // than the word being legible.
  if (soloScale * size < currentFontFloor()) {
    const lines = splitButtonLabel(label);
    if (lines) {
      const l0 = txt(lines[0], size, color, bold);
      const l1 = txt(lines[1], size, color, bold);
      const blockW = Math.max(l0.width, l1.width);
      const lineH = Math.max(l0.height, l1.height);
      const useIcon = icon !== null && icSz + icGap + blockW <= fitW && icSz <= h - 2;
      const wrapW = useIcon ? icSz + icGap + blockW : blockW;
      if (wrapW <= fitW && lineH * 2 <= h - 2) {
        text.destroy({ texture: true, baseTexture: true });
        const gx = x + (w - wrapW) / 2;
        if (useIcon && icon !== null) {
          const glyph = buildIcon(icon, icSz, color, {
            variant: opts.variant ?? (tabIconVariant(color) === 'active' ? 'active' : 'content'),
          });
          glyph.x = Math.round(gx);
          glyph.y = Math.round(y + (h - icSz) / 2);
          target.addChild(glyph);
        }
        const textCx = gx + (useIcon ? icSz + icGap : 0) + blockW / 2;
        const top = y + (h - lineH * 2) / 2;
        l0.anchor.set(0.5, 0); l0.x = Math.round(textCx); l0.y = Math.round(top);
        l1.anchor.set(0.5, 0); l1.x = Math.round(textCx); l1.y = Math.round(top + lineH);
        target.addChild(l0, l1);
        return;
      }
      l0.destroy({ texture: true, baseTexture: true });
      l1.destroy({ texture: true, baseTexture: true });
    }
  }

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
    // Bounded below by the floor. Wrapping was already tried and rejected above (no space to break
    // at, or a box too short for two lines), so the only answers left are "overflow at a readable
    // size" and "fit at an unreadable one" — and the second stopped being allowed on 2026-09-12
    // (§50.12). Overflowing is loud: the sweep reports it as `overflow` against the button's own
    // frame, which is what sends the fix to the call site (a wider button) or to the translation
    // (an abbreviation), instead of leaving a grey smudge that reads as intentional fine print.
    // `size` may have just moved down a tier, so read the floor against the size actually minted.
    const soloFit = Math.max(Math.min(1, fitW / Math.max(1, rawW)), Math.min(1, currentFontFloor() / size));
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
    // Same floor bound as the solo branch: the re-mint moved `size` down a tier, so the scale that
    // fits the new group can breach the floor the re-mint was supposed to respect.
    fit = groupW > fitW ? Math.max(fitW / groupW, Math.min(1, currentFontFloor() / size)) : 1;
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
