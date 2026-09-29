// Which of an inventory cell's actions get a button on the cell. Pure (no PIXI) so the rule can be
// checked against the real per-character width in a unit test; cells.ts supplies the measurement.
import { t } from '../../i18n';
import type { CellAction } from './types';

/** Gap between two action buttons on an inventory cell. */
export const CELL_BTN_GAP = 5;
/** Horizontal room a button keeps free around its label (2px each side). */
const CELL_BTN_LABEL_PAD = 4;

/**
 * Which of a cell's actions get a button of their own, and how wide each button is.
 *
 * Every action used to get an equal share of the cell's width, and a label wider than its share was
 * `scale.set` down to fit. A portrait cell is ~285 design px, and on a phone the floor makes a
 * button label 20 design px, 11 px per monospace character. Three buttons then leave ~7 characters
 * each, which German misses on "Verstärken" (10) and "Umschmieden" (11) and every locale misses at
 * four or five buttons ("Salvage All" in 49 px). Wrapping cannot help, a single word is wider than
 * the button, and the cell has no height for a second row.
 *
 * So the row keeps only actions whose label fits at the floor, in the priority order
 * `instanceActions` returns them, and the rest go behind one "more" button that opens the detail
 * modal. The count is the largest that fits: with `m` actions plus the more button there are `m + 1`
 * equal buttons. `measure` returns the label's width at the size it will be drawn at.
 */
export function splitCellActions(
  actions: readonly CellAction[], innerW: number, measure: (label: string) => number,
  moreLabel = t('equip.moreActions'),
): { shown: CellAction[]; overflow: CellAction[]; buttonW: number } {
  const widthFor = (slots: number): number => (innerW - CELL_BTN_GAP * (slots - 1)) / slots;
  const fits = (label: string, bw: number): boolean => measure(label) + CELL_BTN_LABEL_PAD <= bw;
  const n = actions.length;
  if (n === 0) return { shown: [], overflow: [], buttonW: innerW };
  const full = widthFor(n);
  if (actions.every((a) => fits(a.label, full))) return { shown: [...actions], overflow: [], buttonW: full };
  for (let m = n - 1; m >= 0; m--) {
    const bw = widthFor(m + 1);
    if (m > 0 && !fits(moreLabel, bw)) continue;
    const fitting = actions.filter((a) => fits(a.label, bw));
    if (fitting.length < m) continue;
    const shown = fitting.slice(0, m);
    return { shown, overflow: actions.filter((a) => !shown.includes(a)), buttonW: bw };
  }
  return { shown: [], overflow: [...actions], buttonW: innerW };
}
