// The contract ui/widgets/statusTag.ts exists to hold: a status tag drops its WORD to fit, never
// its glyph, and never shrinks either one.
//
// Worth pinning because the degradation is the branch nobody sees. Every call site's box is roomy
// enough today that the pair fits on all three locales — measured on a 360-wide phone in German,
// the worst shape the layout sweep walks (2026-09-15) — so the fallback is a guard against strings
// and boxes that have not happened yet, and a guard nothing exercises is a guard nothing protects.
// The shrink-free promise is the load-bearing half: it is what lets the caller trust that a tag
// clearing the audit's text gate also clears its icon gate (testing/layoutAudit.ts).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts),
// whose measureText is a flat 7px per character — fine here, because the box widths below are
// chosen relative to that, not to a real font.
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawStatusTag } from '../../src/ui/widgets/statusTag';

const FS = 20;
/** What the widget derives from the font size: ICON_RATIO 1.35, GAP_RATIO 0.3. */
const ICON = Math.round(FS * 1.35);

function draw(boxW: number, opts = {}): { parent: PIXI.Container; used: number } {
  const parent = new PIXI.Container();
  const used = drawStatusTag(parent, 0, 0, boxW, 40, 'Claimed', 'check', 0x336644, FS, opts);
  return { parent, used };
}

describe('drawStatusTag', () => {
  it('draws glyph + word when the pair fits, and reports the pair width', () => {
    const { parent, used } = draw(1000);
    expect(parent.children).toHaveLength(2);
    const text = parent.children.find((c) => c instanceof PIXI.Text) as PIXI.Text;
    expect(text.text).toBe('Claimed');
    expect(used).toBeGreaterThan(ICON);
  });

  it('drops the word — not the glyph — when the pair does not fit', () => {
    const { parent, used } = draw(ICON + 4);
    expect(parent.children).toHaveLength(1);
    expect(parent.children.some((c) => c instanceof PIXI.Text)).toBe(false);
    expect(used).toBe(ICON);
  });

  it('keeps the glyph at full size even in a box narrower than the glyph', () => {
    // Deliberately no clamping: a box this narrow is a layout bug for the sweep to report, not
    // something to render as an illegible smudge.
    const { parent, used } = draw(4);
    expect(parent.children).toHaveLength(1);
    expect(used).toBe(ICON);
    expect(parent.children[0]!.scale.x).toBe(1);
  });

  it('right-aligns by default and centres on request', () => {
    const boxW = 400;
    const right = draw(boxW).parent.children[0]!;
    const centred = draw(boxW, { align: 'center' }).parent.children[0]!;
    const left = draw(boxW, { align: 'left' }).parent.children[0]!;
    expect(left.x).toBe(0);
    expect(centred.x).toBeGreaterThan(left.x);
    expect(right.x).toBeGreaterThan(centred.x);
    expect(right.x + draw(boxW).used).toBeCloseTo(boxW, 0);
  });
});
