// Friend Match "enter room code" geometry (RoomScene/views.ts codeEntryLayout).
//
// Two things went wrong here on 2026-09-21, when the room-code charset dropped its letters and the
// keypad went from 3 rows of 7 to 2 rows of 5:
//   1. the entered-code boxes are sized off the WIDTH (w * 0.10, 1.25x as tall), so on a
//      wide-and-short landscape window the row was ~28% of the screen height, and
//   2. the keypad started at a hard h * 0.40 regardless,
// which put the first row of digits on top of the boxes. Both halves are pure arithmetic, so this
// asserts them directly instead of rendering: box row above the keypad, keypad above the action
// row, everything inside the screen. scenes.ui.ts keeps the tap-target half (the rects the hit
// list actually registers).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { codeEntryLayout } from '../../src/scenes/RoomScene/views';
import { CODE_ALPHABET, CODE_LEN } from '../../src/scenes/RoomScene/types';

// Screen sizes, not design sizes — each goes through createLayout the way the scene does.
const SCREENS: Array<[string, number, number]> = [
  ['portrait', 800, 1280],
  ['landscape', 1280, 800],
  // The one that actually broke: a maximised desktop window is far wider than it is tall.
  ['wide landscape (2.25:1)', 1568, 698],
  ['very wide landscape (2.6:1)', 1680, 640],
];

function layoutFor(w: number, h: number) {
  const l = createLayout(w, h);
  const dw = l.designWidth, dh = l.designHeight;
  return { dw, dh, ...codeEntryLayout(dw, dh) };
}

describe('RoomScene code-entry layout', () => {
  for (const [label, sw, sh] of SCREENS) {
    describe(label, () => {
      it('the keypad starts below the entered-code boxes', () => {
        const g = layoutFor(sw, sh);
        expect(g.kY).toBeGreaterThanOrEqual(g.rowY + g.boxH);
      });

      it('the action row starts below the last keypad row', () => {
        const g = layoutFor(sw, sh);
        const keypadBottom = g.kY + g.rows * g.kW + (g.rows - 1) * g.kGap;
        expect(g.aY).toBeGreaterThanOrEqual(keypadBottom);
      });

      it('nothing runs off the bottom or the sides', () => {
        const g = layoutFor(sw, sh);
        const rowW = CODE_LEN * g.boxW + (CODE_LEN - 1) * g.boxGap;
        expect(g.rowX).toBeGreaterThanOrEqual(0);
        expect(g.rowX + rowW).toBeLessThanOrEqual(g.dw);
        expect(g.kX0).toBeGreaterThanOrEqual(0);
        expect(g.kX0 + g.perRow * g.kW + (g.perRow - 1) * g.kGap).toBeLessThanOrEqual(g.dw);
        expect(g.aX0).toBeGreaterThanOrEqual(0);
        expect(g.aX0 + 3 * g.aW + 2 * g.aGap).toBeLessThanOrEqual(g.dw);
        expect(g.aY + g.aH).toBeLessThanOrEqual(g.dh);
      });

      it('keys are square and big enough to hit', () => {
        const g = layoutFor(sw, sh);
        // 7% of the shorter screen edge — below that a finger cannot reliably pick one digit.
        expect(g.kW).toBeGreaterThan(Math.min(g.dw, g.dh) * 0.07);
      });

      it('the grid holds every digit with no half-empty trailing row', () => {
        const g = layoutFor(sw, sh);
        expect(g.rows * g.perRow).toBe(CODE_ALPHABET.length);
      });
    });
  }
});
