// Regression coverage for the 19.08.2026 back-button arrow pass. Every back button in the app used
// to prefix its label with the literal "←" character, which the text renderer draws at hairline
// weight in whatever font the platform's CJK fallback happens to supply — the one glyph in a bar
// full of hand-drawn sketch icons that wasn't drawn with the sketch pen, and the reason the user
// asked for "a real icon on the back button". It is now the `backArrow` procedural glyph, drawn in
// the same accent ink as the label and sized off the same `backSize`.
//
// What can silently break:
//   1. The label regrows the literal arrow (a copy-pasted `← ${t(...)}` in a new call site),
//      leaving two arrows side by side.
//   2. The chip stops reserving width for the glyph, so the arrow paints over the label — the chip
//      is measured by `backChipSize` before the (cached) chrome is drawn, so a width formula that
//      forgets the glyph is invisible until someone looks at a screenshot.
//   3. `backPillRightEdge` drifts from the chip it is supposed to describe. FamilyScene/SectScene
//      lay their own title cluster out from it (they pass `title: null`); before this pass they each
//      carried a *copy* of the chip formula, which went stale the moment the chip grew a glyph.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts), where
// getCachedDisplay falls back to a live draw — that's what makes the chip a walkable container tree
// here rather than a baked sprite. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawSceneHeader, drawFloatingBackButton, backPillRightEdge } from '../../src/ui/widgets/SceneHeader';
import { initI18n, t } from '../../src/i18n';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const W = 1920, H = 1080;

/** Depth-first collect of every PIXI.Text under `root`. */
function texts(root: PIXI.Container, out: PIXI.Text[] = []): PIXI.Text[] {
  for (const child of root.children) {
    if (child instanceof PIXI.Text) out.push(child);
    else if (child instanceof PIXI.Container) texts(child, out);
  }
  return out;
}

/** Depth-first collect of every PIXI.Graphics under `root` — the arrow is one. */
function graphics(root: PIXI.Container, out: PIXI.Graphics[] = []): PIXI.Graphics[] {
  for (const child of root.children) {
    if (child instanceof PIXI.Graphics) out.push(child);
    else if (child instanceof PIXI.Container) graphics(child, out);
  }
  return out;
}

/** The back chip is the last child buildChrome adds (bg → guilloche → accent rule → chip). */
function backChip(container: PIXI.Container): PIXI.Container {
  const chrome = container.children[0] as PIXI.Container;
  return chrome.children[chrome.children.length - 1] as PIXI.Container;
}

describe('back button carries a drawn arrow glyph, not the "←" character', () => {
  it('the header back label is the bare i18n string — no literal arrow prefix', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');
    const label = texts(backChip(c)).find((n) => n.text.includes(t('common.back')));
    expect(label, 'back label text node').toBeTruthy();
    expect(label!.text).toBe(t('common.back'));
    expect(label!.text).not.toContain('←');
  });

  it('draws a glyph inside the chip, left of the label', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');
    const chip = backChip(c);
    // bg pill + arrow: the arrow is the second Graphics in the chip.
    const glyphs = graphics(chip);
    expect(glyphs.length, 'pill background + arrow glyph').toBeGreaterThanOrEqual(2);
    const label = texts(chip)[0]!;
    const arrow = glyphs[glyphs.length - 1]!;
    expect(arrow.x).toBeLessThan(label.x);
  });

  it('reserves chip width for the glyph instead of letting it paint over the label', () => {
    const c = new PIXI.Container();
    const hdr = drawSceneHeader(c, W, H, 'Equipment');
    const chip = backChip(c);
    const label = texts(chip)[0]!;
    const arrow = graphics(chip)[graphics(chip).length - 1]!;
    // The label starts after the arrow box, and the whole group still fits the reported hit width.
    expect(label.x).toBeGreaterThan(arrow.x + arrow.width * 0.5);
    expect(label.x + label.width).toBeLessThanOrEqual(hdr.backRect.w);
  });

  it('backPillRightEdge clears the chip the header actually draws (FamilyScene/SectScene rely on it)', () => {
    const c = new PIXI.Container();
    const hdr = drawSceneHeader(c, W, H, null);
    const chip = backChip(c);
    const edge = backPillRightEdge(H);
    expect(edge).toBeGreaterThan(chip.x + chip.width);
    // …and doesn't overshoot into "the title can never be centred" territory.
    expect(edge).toBeLessThan(W * 0.25);
    expect(hdr.headerH).toBeGreaterThan(0);
  });

  it('the floating chip (full-bleed scenes) gets the same treatment', () => {
    const c = new PIXI.Container();
    drawFloatingBackButton(c, H);
    const chip = c.children[0] as PIXI.Container;
    const label = texts(chip)[0]!;
    expect(label.text).toBe(t('common.back'));
    expect(graphics(chip).length).toBeGreaterThanOrEqual(2);
  });
});
