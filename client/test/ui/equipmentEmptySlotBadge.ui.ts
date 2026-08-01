// Regression coverage for the 2026-08-01 empty-slot glyph fix (equipmentGlyph.ts): the "+" used to
// be drawn dead-center on top of the whole per-slot shape. For the trinket slot (a rect + a punched
// hole) that read as a little humanoid figure rather than an empty accessory slot — roster feedback.
// The "+" now lives in a small corner badge, off the shape's own center, so the per-slot silhouette
// (pen stroke / plain rect / rect+hole) stays legible on its own.
//
// SketchPen.line() is the only SketchPen method the badge cross uses — none of the three per-slot
// switch cases in drawEmptySlotGlyph call it (weapon uses stroke(), armor/trinket use rect()/circle()),
// so every SketchPen.prototype.line call captured here belongs to the badge, not the silhouette.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../../src/render/sketch';
import { drawEmptySlotGlyph } from '../../src/render/equipmentGlyph';
import type { EquipSlot } from '../../src/game/meta/SaveData';

const SIZE = 44;
const SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];

/** [x1, y1, x2, y2] from a SketchPen.line() call, ignoring the trailing opts arg. */
function lineArgs(call: unknown[]): [number, number, number, number] {
  return call.slice(0, 4) as [number, number, number, number];
}

describe('equipmentGlyph — empty-slot "+" badge sits in a corner, not on top of the per-slot silhouette (2026-08-01)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(SLOTS)('slot "%s": draws exactly one "+" (2 SketchPen.line bars), both off the shape\'s own origin', (slot) => {
    const lineSpy = vi.spyOn(SketchPen.prototype, 'line');
    const g = new PIXI.Graphics();
    drawEmptySlotGlyph(g, slot, SIZE, 7);

    expect(lineSpy).toHaveBeenCalledTimes(2);
    for (const call of lineSpy.mock.calls) {
      const [x1, y1, x2, y2] = lineArgs(call);
      // The old centered "+" had both endpoints of each bar within `plusR` (~SIZE*0.11) of the
      // origin. The corner badge sits well outside that — proves it moved off-center.
      expect(Math.hypot(x1, y1)).toBeGreaterThan(SIZE * 0.15);
      expect(Math.hypot(x2, y2)).toBeGreaterThan(SIZE * 0.15);
    }
  });

  it('the badge sits in the same corner for every slot type (one consistent "add" affordance position)', () => {
    const centers = SLOTS.map((slot) => {
      const lineSpy = vi.spyOn(SketchPen.prototype, 'line');
      const g = new PIXI.Graphics();
      drawEmptySlotGlyph(g, slot, SIZE, 7);
      const [bar1, bar2] = lineSpy.mock.calls.map(lineArgs);
      lineSpy.mockRestore();

      // One bar is horizontal (y1 === y2), the other vertical (x1 === x2); their shared coordinate
      // pins the badge center.
      const horiz = bar1![1] === bar1![3] ? bar1! : bar2!;
      const vert = bar1![0] === bar1![2] ? bar1! : bar2!;
      expect(horiz[1]).toBe(horiz[3]);
      expect(vert[0]).toBe(vert[2]);
      return { x: vert[0], y: horiz[1] };
    });

    // Same badge center across weapon/armor/trinket.
    for (const c of centers.slice(1)) {
      expect(c.x).toBeCloseTo(centers[0]!.x, 5);
      expect(c.y).toBeCloseTo(centers[0]!.y, 5);
    }
    // In the bottom-right quadrant of the icon box, not centered and not top-left.
    expect(centers[0]!.x).toBeGreaterThan(0);
    expect(centers[0]!.y).toBeGreaterThan(0);
  });
});
