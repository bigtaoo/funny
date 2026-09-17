// A modal button's stat row — the `[glyph][figure]` chips under its label (`ModalButton.stats`,
// see ./modalLine.ts for when a button is allowed one).
//
// Split out of ./core.ts the moment it pushed that file past the 500-line gate (2026-09-17), as
// form① free functions — the first option in claudedocs/client-modules.md's split-priority order,
// and the honest one here: nothing below touches `WorldMapPanelsCore.ctx`. `showModal` needs two
// things from this module and they are deliberately separate calls: the row's HEIGHT before it
// lays the grid out (`statBlockH`, which decides `btnH` and the label's own budget), and the row
// itself once it knows the ink and the column width (`buildStatRow`).
import * as PIXI from 'pixi.js-legacy';
import { txt } from '../../../render/sketchUi';
import { FS } from '../../../render/fontScale';
import { buildIcon } from '../../../render/icons';
import type { ModalButtonStat } from './modalLine';

/** Chip glyph box as a multiple of the figure's font size — the ratio `buttonLabel.ts` uses too. */
const STAT_GLYPH_RATIO = 1.25;
/** glyph → its own figure, figure → the next chip's glyph, and the label block → the chip row. */
const STAT_GAP = 6;
const STAT_CHIP_GAP = 18;
export const STAT_ROW_GAP = 6;

/**
 * Font for the figures. `FS.label`, not `FS.small`: they ARE the comparison the player is making
 * across the rows, and at `FS.small` they measured ~10 CSS px in a 1568-wide window — fine print
 * under a 32px name. `label` is the largest token that still reads as subordinate to the label.
 *
 * A function, not a module-level const: `FS.*` are getters over the font floor, so a copy taken at
 * import time is pinned to the unlifted table forever (see render/fontScale.ts's header).
 */
export function statFont(): number {
  return Math.round(FS.label);
}

/** Height a stat row costs a button, chip row plus the gap above it. */
export function statBlockH(): number {
  return Math.round(statFont() * STAT_GLYPH_RATIO) + STAT_ROW_GAP;
}

/**
 * A button's stat row as ONE container laid out from local (0,0), with its natural size — so the
 * caller centres and, if need be, scales the whole row rather than the individual chips (the same
 * "scale the group, not its parts" contract `buttonLabel.ts` draws its icon+label pair under).
 *
 * Bold figures: they are the content of the row, and the glyph beside each one is already the
 * quiet half of the pair.
 */
export function buildStatRow(
  stats: ModalButtonStat[], font: number, color: number,
): { row: PIXI.Container; w: number; h: number } {
  const gSz = Math.round(font * STAT_GLYPH_RATIO);
  const values = stats.map((s) => {
    const val = txt(s.text, font, color, true);
    val.anchor.set(0, 0.5);
    return val;
  });
  const h = Math.max(gSz, ...values.map((v) => v.height));
  const row = new PIXI.Container();
  let x = 0;
  for (let i = 0; i < stats.length; i++) {
    const glyph = buildIcon(stats[i]!.icon, gSz, color);
    glyph.x = x;
    glyph.y = (h - gSz) / 2;
    row.addChild(glyph);
    const val = values[i]!;
    val.x = x + gSz + STAT_GAP;
    val.y = h / 2;
    row.addChild(val);
    x = val.x + val.width + STAT_CHIP_GAP;
  }
  return { row, w: Math.max(0, x - STAT_CHIP_GAP), h };
}
