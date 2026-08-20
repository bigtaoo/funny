// Regression coverage for the back-button arrow (19.08.2026). Every back button in the app used to
// prefix its label with the literal "←" character, which the text renderer draws at hairline weight
// in whatever font the platform's CJK fallback supplies — the one glyph in a bar full of hand-drawn
// sketch icons that wasn't drawn with the sketch pen. It is now AI art (`BACK_ARROW_ART`, packed by
// pack_tab_icons.cjs in a blue `accent` ink for the paper bar and white `active` for LoginScene's
// dark one).
//
// What can silently break:
//   1. The label regrows the literal arrow (a copy-pasted `← ${t(...)}` in a new call site), leaving
//      two arrows side by side.
//   2. The chip stops reserving width for the glyph, so the arrow paints over the label. The chip is
//      measured by `backChipSize` before the (cached) chrome is drawn, so a width formula that
//      forgets the glyph is invisible until someone looks at a screenshot.
//   3. **The arrow gets baked into the cached chrome.** This is the subtle one and the reason the
//      arrow is added by `addBackArrow` on top of the cached container rather than inside
//      `buildBackChip`: the art is a raster that decodes asynchronously, and `buildRasterTabIcon`
//      deliberately draws nothing until it is ready. Bake it in, and the first header that loses the
//      race to the decoder caches an arrow-less pill FOREVER for that cache key — a bug that only
//      reproduces on a cold load, i.e. never on the machine of whoever moved the code.
//   4. `backPillRightEdge` drifts from the chip it describes. FamilyScene/SectScene lay their own
//      title cluster out from it (they pass `title: null`); before this pass they each carried a
//      copy of the chip formula, which went stale the moment the chip grew a glyph.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts), where
// getCachedDisplay falls back to a live draw — that's what makes the chip a walkable container tree
// here rather than a baked sprite. Note the arrow node itself is EMPTY here: vitest stubs every
// `.png` import to a data URI that never decodes, so `buildRasterTabIcon` returns a bare container.
// Its position is still set, which is what these assertions read. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawSceneHeader, drawFloatingBackButton, backPillRightEdge, BACK_ARROW_NODE } from '../../src/ui/widgets/SceneHeader';
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
/** Left inset of the pill in design space (SceneHeader's BACK_X, §3.1). */
const BACK_X = 10;

/** Depth-first collect of every PIXI.Text under `root`. */
function texts(root: PIXI.Container, out: PIXI.Text[] = []): PIXI.Text[] {
  for (const child of root.children) {
    if (child instanceof PIXI.Text) out.push(child);
    else if (child instanceof PIXI.Container) texts(child, out);
  }
  return out;
}

/** The back chip is the last child buildChrome adds (bg → guilloche → accent rule → chip). */
function backChip(container: PIXI.Container): PIXI.Container {
  const chrome = container.children[0] as PIXI.Container;
  return chrome.children[chrome.children.length - 1] as PIXI.Container;
}

describe('back button carries the arrow art, not the "←" character', () => {
  it('the header back label is the bare i18n string — no literal arrow prefix', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');
    const label = texts(backChip(c))[0];
    expect(label, 'back label text node').toBeTruthy();
    expect(label!.text).toBe(t('common.back'));
    expect(label!.text).not.toContain('←');
  });

  it('keeps the arrow OUT of the cached chrome — the pill holds only its background and label', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');
    // Exactly two children: the rounded-rect background and the label. A third node here means
    // someone moved the arrow back inside the cached container (failure mode 3 above).
    expect(backChip(c).children).toHaveLength(2);
  });

  it('draws the arrow on the header itself, at the pill origin, left of the label', () => {
    const c = new PIXI.Container();
    drawSceneHeader(c, W, H, 'Equipment');
    const chip = backChip(c);
    const label = texts(chip)[0]!;
    const arrow = c.getChildByName(BACK_ARROW_NODE) as PIXI.Container;
    expect(arrow).toBeTruthy();
    expect(arrow instanceof PIXI.Text).toBe(false);
    // Left edge: pill origin + the same padX the label is measured from.
    expect(arrow.x).toBeGreaterThanOrEqual(BACK_X);
    expect(arrow.x).toBeLessThan(BACK_X + chip.x + label.x);
    // Vertically inside the pill, not pinned to the top of the bar.
    expect(arrow.y).toBeGreaterThan(0);
  });

  it('reserves chip width for the glyph instead of letting it paint over the label', () => {
    const c = new PIXI.Container();
    const hdr = drawSceneHeader(c, W, H, 'Equipment');
    const chip = backChip(c);
    const label = texts(chip)[0]!;
    const arrow = c.getChildByName(BACK_ARROW_NODE) as PIXI.Container;
    // The label starts clear of the arrow's own left edge…
    expect(chip.x + label.x).toBeGreaterThan(arrow.x);
    // …and the whole group still fits inside the reported hit width.
    expect(chip.x + label.x + label.width).toBeLessThanOrEqual(hdr.backRect.w);
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
    expect(chip.children).toHaveLength(2); // background + label, arrow drawn beside it
    const arrow = c.getChildByName(BACK_ARROW_NODE) as PIXI.Container;
    expect(arrow).toBeTruthy();
    expect(arrow instanceof PIXI.Text).toBe(false);
    expect(arrow.x).toBeGreaterThanOrEqual(chip.x);
    // Vertically inside the pill: the floating chip sits at its own margin offset, not at y=0 like
    // the header's chrome, so this is where a copy-pasted origin would show up.
    expect(arrow.y).toBeGreaterThanOrEqual(chip.y);
    expect(arrow.y).toBeLessThan(chip.y + chip.height);
  });
});
