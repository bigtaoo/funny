// SettingsScene flow layout's row primitive, `Section.row` (SettingsScene/layout.ts, UI_DESIGN_LOG_2026-09
// §65) — tested on its own, with a fake control, because no real setting sits on the narrow edge of
// every branch today:
//  * side by side: control flush with the card's right edge and centred on the row;
//  * too narrow for label + control (and no hint): the control drops under the label instead of
//    running over it — and the row grows to hold both;
//  * a hint wraps in the space left of the control and makes the row taller, never wider.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { Page, section, type Control, type Section } from '../../src/scenes/SettingsScene/layout';
import { collectTexts, findText } from '../harness/settingsScene';

initI18n('en');

const W = 1080, H = 1920;

interface Drawn { x: number; y: number; w: number; h: number }

function fakeControl(w: number, h: number): { ctrl: Control; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  return { ctrl: { w, h, draw: (x, y) => { drawn.push({ x, y, w, h }); } }, drawn };
}

/** One card in a column `colW` wide; `body` adds its rows. */
function card(colW: number, body: (sec: Section, page: Page) => void): { layer: PIXI.Container; page: Page; sec: Section } {
  const layer = new PIXI.Container();
  const page = new Page(layer, W, H, { x: 0, y: 0, w: W, h: H }, 0, [], []);
  let sec!: Section;
  section(page, { x: 0, w: colW, y: 0 }, null, (s) => { sec = s; body(s, page); });
  return { layer, page, sec };
}

describe('Section.row', () => {
  it('side by side: the control is flush right and vertically centred on the row', () => {
    const { ctrl, drawn } = fakeControl(180, 58);
    let row!: { top: number; h: number };
    const { layer, sec } = card(900, (s) => { row = s.row({ label: 'Language', control: ctrl }); });
    const [d] = drawn;
    expect(d!.x + d!.w).toBe(sec.x1);
    expect(Math.abs(d!.y + d!.h / 2 - (row.top + row.h / 2))).toBeLessThanOrEqual(1);
    const label = findText(collectTexts(layer), 'Language');
    expect(label.right).toBeLessThanOrEqual(d!.x);
  });

  it('too narrow for both: the control drops under the label, left-aligned, inside a taller row', () => {
    const wide = fakeControl(180, 58);
    let sideBySide!: { top: number; h: number };
    card(900, (s) => { sideBySide = s.row({ label: 'A fairly long setting label', control: wide.ctrl }); });

    const { ctrl, drawn } = fakeControl(180, 58);
    let row!: { top: number; h: number };
    // Wide enough for either alone, not for both.
    const { layer, sec } = card(420, (s) => { row = s.row({ label: 'A fairly long setting label', control: ctrl }); });
    const [d] = drawn;
    const label = findText(collectTexts(layer), 'A fairly long setting label');
    expect(d!.x, 'stacked control is left-aligned with the text').toBe(sec.x0);
    expect(d!.y, 'stacked control starts below the label').toBeGreaterThanOrEqual(label.bottom);
    expect(d!.x + d!.w).toBeLessThanOrEqual(sec.x1);
    expect(d!.y + d!.h, 'stacked control stays inside its row').toBeLessThanOrEqual(row.top + row.h);
    expect(row.h).toBeGreaterThan(sideBySide.h);
  });

  it('fits side by side when it can: the same row in a column just wide enough is not stacked', () => {
    const { ctrl, drawn } = fakeControl(180, 58);
    const { sec } = card(900, (s) => { s.row({ label: 'Short', control: ctrl }); });
    expect(drawn[0]!.x).toBeGreaterThan(sec.x0);
  });

  it('a hint wraps left of the control and grows the row, never past the control', () => {
    const hint = 'Loads art only when a screen needs it instead of ahead of time, which saves mobile data. '.repeat(3);
    const { ctrl, drawn } = fakeControl(180, 58);
    let row!: { top: number; h: number };
    const { layer, page, sec } = card(700, (s) => { row = s.row({ label: 'Data saver', hint, control: ctrl }); });
    const [d] = drawn;
    expect(d!.x + d!.w, 'a row with a hint keeps its control on the right').toBe(sec.x1);
    const hintNode = findText(collectTexts(layer), hint);
    expect(hintNode.right, 'hint runs under the control').toBeLessThanOrEqual(d!.x);
    expect(hintNode.bottom).toBeLessThanOrEqual(row.top + row.h);
    expect(row.h, 'a wrapped hint makes the row taller than the minimum').toBeGreaterThan(page.m.rowMinH);
  });

  it('rows follow each other: each starts where the previous one ended', () => {
    const a = fakeControl(180, 58), b = fakeControl(180, 58);
    const rows: Array<{ top: number; h: number }> = [];
    card(900, (s) => {
      rows.push(s.row({ label: 'One', control: a.ctrl }));
      rows.push(s.row({ label: 'Two', hint: 'with a hint', control: b.ctrl }));
    });
    expect(rows[1]!.top).toBe(rows[0]!.top + rows[0]!.h);
  });
});
