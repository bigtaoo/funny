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
        const keypadBottom = g.kY + g.rows * g.kH + (g.rows - 1) * g.kGap;
        expect(g.aY).toBeGreaterThanOrEqual(keypadBottom);
      });

      it('the action row sits on the bottom edge, so no band of the screen is left empty', () => {
        const g = layoutFor(sw, sh);
        // Within the bottom margin (h * 0.04) of the screen floor — the second half of the
        // 2026-09-21 fix: parked under the keypad it left a third of a portrait screen blank.
        expect(g.dh - (g.aY + g.aH)).toBeLessThanOrEqual(Math.round(g.dh * 0.05));
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

      it('keys are big enough to hit and never taller than they are wide', () => {
        const g = layoutFor(sw, sh);
        // 7% of the shorter screen edge — below that a finger cannot reliably pick one digit.
        expect(Math.min(g.kW, g.kH)).toBeGreaterThan(Math.min(g.dw, g.dh) * 0.07);
        expect(g.kH).toBeLessThanOrEqual(g.kW);
        expect(g.kW).toBeLessThanOrEqual(g.kH * 1.8); // …nor stretched into a letterbox
      });

      it('the keypad fills the band between the boxes and the actions', () => {
        const g = layoutFor(sw, sh);
        const gridH = g.rows * g.kH + (g.rows - 1) * g.kGap;
        const gridW = g.perRow * g.kW + (g.perRow - 1) * g.kGap;
        const band = g.aY - (g.rowY + g.boxH);
        // Two thirds of the free band and of the action row's own width — the keypad is the
        // point of this screen, it must not shrink into a stamp in the middle of the page.
        expect(gridH).toBeGreaterThan(band * 0.66);
        expect(gridW).toBeGreaterThan((3 * g.aW + 2 * g.aGap) * 0.66);
      });

      it('the grid holds every digit, with at most one short (centred) trailing row', () => {
        const g = layoutFor(sw, sh);
        expect(g.keys.slice().sort().join('')).toBe(CODE_ALPHABET.slice().split('').sort().join(''));
        expect(g.rows * g.perRow).toBeGreaterThanOrEqual(CODE_ALPHABET.length);
        expect(g.rows * g.perRow - CODE_ALPHABET.length).toBeLessThan(g.perRow);
      });

      it('landscape spreads the digits over two rows, portrait stacks them as a dial-pad', () => {
        const g = layoutFor(sw, sh);
        const landscape = g.dw > g.dh;
        expect([g.perRow, g.rows]).toEqual(landscape ? [5, 2] : [3, 4]);
        expect(g.keys.join('')).toBe(landscape ? '0123456789' : '1234567890');
      });
    });
  }
});
