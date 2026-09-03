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

/** One modal button. `icon` is `IconKind`-only on purpose — see the resource-motif note above. */
export interface ModalButton {
  label: string;
  action: () => void;
  disabled?: boolean;
  icon?: IconKind;
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
