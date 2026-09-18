// Modal glyph vocabulary — the icon slot on every world-map modal line and button.
//
// `showModal` used to take `lines: string[]` / `buttons: {label}[]` and draw both as bare centered
// text, so the tile-action modals were the only part of the world map with no iconography at all
// (the header HUD, the troops/territory card and the entry buttons all carry one). Two of the six
// information lines even smuggled an EMOJI into the localised string to compensate (🗼/🏹/🚧), which
// renders in the system emoji font rather than the hand-drawn ink the rest of the game uses — and
// on WeChat/iOS not necessarily the same glyph twice.
//
// A line/button is now either a plain string (no icon, unchanged) or a `{ text, icon }` pair. The
// glyph vocabulary is deliberately two-sided:
//
//   - an {@link IconKind} — anything in render/icons' ink or tab table. Tinted, so it works on both
//     the paper-coloured line area and the dark button fill.
//   - `{ res }` — one of the five SLG resource motifs out of the world atlas (`res_ink`, …). Black
//     hand-drawn line art that must NOT be tinted (see render/atlas/resAtlasLoader), so these are
//     for INFORMATION LINES ONLY — on a dark button fill they would be invisible. `buttons[].icon`
//     is typed as `IconKind` alone to make that a compile error rather than a rendering surprise.
//
// Resource motifs live in the lazily-decoded world atlas: `buildModalGlyph` returns null when it
// has not landed yet, and the caller then lays the line out with no icon rather than a blank box.
import * as PIXI from 'pixi.js-legacy';
import type { ResourceType } from '@nw/shared';
import { buildIcon, type IconKind } from '../../../render/icons';
import { getResTexture } from '../../../render/atlas/resAtlasLoader';

/** A modal glyph: a tintable icons.ts kind, or one of the five untinted SLG resource motifs. */
export type ModalGlyph = IconKind | { res: ResourceType };

/** One information line of a modal: bare text, or text with a leading glyph. */
export type ModalLine = string | { text: string; icon?: ModalGlyph };

/**
 * One `[glyph][number]` chip of a button's stat row. The glyph carries the QUANTITY'S NAME, which is
 * why there is no text for it: the word is what made the team picker's rows unreadable (see
 * {@link ModalButton.stats}).
 */
export interface ModalButtonStat {
  icon: IconKind;
  /** The bare figure — `'2525'`, not `'Troops 2525'`. */
  text: string;
}

/** One modal button. `icon` is `IconKind`-only on purpose — see the resource-motif note above. */
export interface ModalButton {
  label: string;
  action: () => void;
  disabled?: boolean;
  icon?: IconKind;
  /**
   * A second line inside the button: small `[glyph][number]` chips under the label, for a row the
   * player picks by COMPARING figures across buttons (the team picker, §4.2/§4.6).
   *
   * Those rows used to spell every figure out in the label — `Team 1 · Troops 2525 · Stamina 100`,
   * which at `FS.title` in a 210px column is three wrapped lines in a 84px button, i.e. clipped,
   * and two thirds of the ink was the same two words repeated on all five rows. As chips the words
   * become glyphs, the figures stay full-size, and the row fits.
   *
   * Only for figures whose glyph the player can read without being told — either one this screen has
   * already established (`unit` is a troop count on the tile menus too) or one drawn for the purpose
   * (`flame` for stamina, batch 13). An icon that has to be decoded is worse than the word it
   * replaced, and a BORROWED one can be worse still: stamina spent a day on `hourglassMd`, which on
   * that same screen means "how much time is left" three times over.
   */
  stats?: ModalButtonStat[];
}

/** The text of a modal line, whichever of the two forms it is written in. */
export function modalLineText(line: ModalLine): string {
  return typeof line === 'string' ? line : line.text;
}

/** The glyph of a modal line, or undefined for a bare-string line. */
export function modalLineIcon(line: ModalLine): ModalGlyph | undefined {
  return typeof line === 'string' ? undefined : line.icon;
}

/**
 * Build a glyph as an `size × size` box at local origin (0,0) with its artwork centred — the same
 * positioning contract `buildIcon` has always had, so callers place either kind by its top-left
 * corner.
 *
 * Returns null only for a resource motif whose atlas has not decoded yet (fire-and-forget load
 * started by WorldMapScene's constructor). Resource art keeps its own aspect ratio inside the box
 * rather than being squashed square.
 */
export function buildModalGlyph(glyph: ModalGlyph, size: number, color: number): PIXI.DisplayObject | null {
  if (typeof glyph === 'string') return buildIcon(glyph, size, color);
  const tex = getResTexture(glyph.res);
  if (!tex) return null;
  const box = new PIXI.Container();
  const sp = new PIXI.Sprite(tex);
  const scale = size / Math.max(tex.width, tex.height);
  sp.width = tex.width * scale;
  sp.height = tex.height * scale;
  sp.x = (size - sp.width) / 2;
  sp.y = (size - sp.height) / 2;
  box.addChild(sp);
  return box;
}

/**
 * The `(x, y)` line every tile modal carries. Centralised because it appeared verbatim at ten call
 * sites across WorldMapInput / cityPanel / march / deploy, none of which agreed on whether it was
 * worth a translation key (it isn't — the format is language-neutral) but all of which now need the
 * same glyph.
 */
export function coordLine(tx: number, ty: number): ModalLine {
  return { text: `(${tx}, ${ty})`, icon: 'mapPin' };
}
