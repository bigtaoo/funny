/**
 * textRasterOnce.ui.ts — labels are rasterized once (ADR-099).
 *
 * Two separate ways the same label used to be drawn more than once, both measured on 2026-09-28:
 *  - `txtFit` read `.width` on a probe Text to decide whether it fits, which rasterizes it, then threw
 *    it away and built another at the fitted size — 43 of the card roster's 86 ms first build.
 *    `measuredWidth` answers the same question from `TextMetrics` alone.
 *  - every Text started at `settings.RESOLUTION` (1) and re-rasterized at the renderer's 2 on its first
 *    render; `setTextResolution` makes new Text start at the renderer's value.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { makeText, measuredWidth, setTextResolution } from '../../src/render/pixiText';
import { txt, txtFit } from '../../src/render/sketchUi';

const origDefault = PIXI.Text.defaultResolution;
afterEach(() => { PIXI.Text.defaultResolution = origDefault; });

/** Count `updateText` calls that actually rasterize (dirty, or not respecting the dirty flag). */
function countRasters<T>(fn: () => T): { out: T; n: number } {
  const proto = PIXI.Text.prototype as unknown as { updateText(respectDirty: boolean): void };
  const orig = proto.updateText;
  let n = 0;
  proto.updateText = function (this: PIXI.Text & { localStyleID: number; _style: PIXI.TextStyle }, respectDirty: boolean) {
    if (!respectDirty || this.dirty || this.localStyleID !== this._style.styleID) n++;
    return orig.call(this, respectDirty);
  };
  try { return { out: fn(), n }; } finally { proto.updateText = orig; }
}

describe('measuredWidth', () => {
  it('agrees with the width getter it replaces, at any resolution and scale', () => {
    for (const res of [1, 1.5, 2]) {
      for (const label of ['a', 'Li Chuang', 'Power 12345', '[In team: The Very Long Team Name]']) {
        const a = txt(label, 20, 0), b = txt(label, 20, 0);
        a.resolution = res; b.resolution = res;
        a.scale.set(0.8); b.scale.set(0.8);
        expect(measuredWidth(a)).toBeCloseTo(b.width, 6);
      }
    }
  });

  it('does not rasterize', () => {
    const t = txt('Li Chuang', 20, 0);
    expect(countRasters(() => measuredWidth(t)).n).toBe(0);
    expect(t.dirty).toBe(true);
  });
});

describe('txtFit', () => {
  it('rasterizes nothing while fitting — the label is drawn once, when it is used', () => {
    const { out, n } = countRasters(() => txtFit('An extremely long hero name that will not fit', 20, 0, true, 90));
    expect(n).toBe(0);
    expect(out.width).toBeLessThanOrEqual(90);
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('returns a label that fits unchanged when it already fits', () => {
    const t = txtFit('Li', 20, 0, true, 500);
    expect(t.text).toBe('Li');
    expect(t.style.fontSize).toBe(20);
  });
});

describe('setTextResolution', () => {
  it('makes new Text start at the renderer resolution, still auto-resolution', () => {
    setTextResolution(2);
    const t = makeText('x', { fontSize: 20 });
    expect(t.resolution).toBe(2);
    expect((t as unknown as { _autoResolution: boolean })._autoResolution).toBe(true);
  });

  it('ignores nonsense', () => {
    setTextResolution(2);
    setTextResolution(0);
    setTextResolution(Number.NaN);
    expect(PIXI.Text.defaultResolution).toBe(2);
  });
});
