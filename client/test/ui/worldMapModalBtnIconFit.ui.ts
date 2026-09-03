// The tile-menu button glyph gate + the column count that feeds it (WorldMapPanels/core.ts
// `labelFitsBesideGlyph` and the `cols` search, 2026-09-03).
//
// Batch 9 drew seven tile-menu glyphs and then measured, in a real browser, that five of them could
// never appear: the gate was `btnW >= 200`, and `btnW` is a pure function of the button COUNT
// (`min(300, (900 - 12·(cols+1)) / cols)`), so it was 166 for any menu of five or more buttons — the
// owned-tile menu has nine. Shortening the labels, which was the recorded plan, could not have
// helped: the old gate never looked at a label. Two things replaced it:
//
//   1. the glyph is granted per button by MEASURING the label at the narrowed width — it may cost no
//      extra line, and must still fit the button's height;
//   2. `cols` follows the content too. `minBtnW` 180 caps a row at four, and the search narrows
//      further while any label cannot carry its glyph — but only while that costs no extra row. That
//      is what gets German (`Verstärken`, `Verteidigung`) and English (`Watchtower`, `Arrow tower`)
//      the full set at three across, without making the four-button menus taller.
//
// So the cases below pin the DECISION RULES, not any particular label or width.
//
// Label widths here are the headless adapter's, NOT the real font's: test/harness/pixiHeadless.ts
// measures every string at 7px/char at every font size, so `LONE_LINE`/`ALREADY_WRAPS` are sized in
// those units and the real-font equivalents (32px monospace: 32px per CJK glyph, 17.6 per Latin
// char) are not what this file asserts. What survives the difference is the rule.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { ModalButton } from '../../src/scenes/worldmap/WorldMapPanels/modalLine';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Landscape design space wide enough for the modal to reach its `PANEL_W.md` tier (900). */
const [W, H] = [1920, 1080];

/** Column width at the widest grid a menu may use (four across) and at the one-step fallback. */
const FOUR_COL = 210;
const THREE_COL = 284;

/** Fits on one line in either grid (7px/char → 21px). */
const SHORT = 'Aa1';
/**
 * Fits the 194px a 210px column gives a bare label (161px), but not the 160px left beside a glyph —
 * so at four across this label has to choose, and at three across (234px) it does not.
 */
const LONE_LINE = 'x'.repeat(23);
/** Already two lines at 194px (196px), still two beside a glyph, so the glyph costs it nothing. */
const ALREADY_WRAPS = 'y'.repeat(28);

function buildHarness(): { ctx: WorldMapContext; panels: WorldMapPanels } {
  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    selectedTile: null,
    toastTimer: 0,
    topInset: 0,
    me: { joined: true },
    cb: { accountId: 'me', worldId: 'w1', getCoins: (): number => 0 },
    view: { renderMap: vi.fn(), centerAt: vi.fn() },
  } as unknown as WorldMapContext;
  return { ctx, panels: new WorldMapPanels(ctx) };
}

/**
 * Per-button `{ label, glyph }` as drawn, plus the grid it was drawn in. A glyph is the one child of
 * the modal layer inside the button's rect that is a container wrapping a single sprite
 * (`buildIcon`'s box) rather than the button's own `sketchPanel` graphics or its `PIXI.Text` label.
 */
function drawn(ctx: WorldMapContext): {
  rows: { label: string; glyph: boolean }[]; btnW: number; gridRows: number;
} {
  const texts: PIXI.Text[] = [];
  const glyphs: PIXI.Container[] = [];
  for (const child of ctx.modalLayer.children as PIXI.DisplayObject[]) {
    if (child instanceof PIXI.Text) texts.push(child);
    else if (child instanceof PIXI.Container && child.children.length === 1
      && child.children[0] instanceof PIXI.Sprite) glyphs.push(child);
  }
  const inside = (o: PIXI.DisplayObject, r: { x: number; y: number; w: number; h: number }): boolean =>
    o.x >= r.x - 2 && o.x <= r.x + r.w && o.y >= r.y && o.y <= r.y + r.h;
  const rects = ctx.modalBtnRects.map(({ rect }) => rect);
  return {
    rows: rects.map((rect) => ({
      label: texts.find((tx) => inside(tx, rect))?.text ?? '',
      glyph: glyphs.some((g) => inside(g, rect)),
    })),
    btnW: Math.round(rects[0].w),
    gridRows: new Set(rects.map((r) => Math.round(r.y))).size,
  };
}

const btn = (label: string): ModalButton => ({ label, action: vi.fn(), icon: 'flag' });

describe('tile-menu buttons — glyph by measured fit, columns by whether the glyphs fit', () => {
  it('draws a glyph on every button of a nine-button menu whose labels are short', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], Array.from({ length: 9 }, () => btn(SHORT)));
    const { rows, btnW, gridRows } = drawn(ctx);
    expect(rows).toHaveLength(9);
    expect(btnW).toBe(FOUR_COL);
    expect(gridRows).toBe(3);
    expect(rows.filter((r) => r.glyph)).toHaveLength(9);
  });

  it('narrows a nine-button menu to three columns so the label that would not fit still gets its glyph', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], [
      btn(LONE_LINE), ...Array.from({ length: 8 }, () => btn(SHORT)),
    ]);
    const { rows, btnW, gridRows } = drawn(ctx);
    expect(btnW).toBe(THREE_COL);
    // The whole point of the "no extra row" guard: 9 buttons are 3 rows at four OR three across.
    expect(gridRows).toBe(3);
    expect(rows.filter((r) => r.glyph)).toHaveLength(9);
  });

  it('keeps a four-button menu on one row instead, and only that button goes without a glyph', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Wild land'], [btn(SHORT), btn(LONE_LINE), btn(SHORT), btn(SHORT)]);
    const { rows, btnW, gridRows } = drawn(ctx);
    expect(btnW).toBe(FOUR_COL);
    expect(gridRows).toBe(1);
    expect(rows.map((r) => r.glyph)).toEqual([true, false, true, true]);
  });

  it('keeps the glyph on a label that already wraps, and does not narrow the grid for it', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], [
      btn(ALREADY_WRAPS), ...Array.from({ length: 8 }, () => btn(SHORT)),
    ]);
    const { rows, btnW } = drawn(ctx);
    expect(btnW).toBe(FOUR_COL);
    expect(rows.filter((r) => r.glyph)).toHaveLength(9);
  });

  it('still draws glyphs in the wide columns of a two-button confirm', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Wild city'], [btn('Siege'), btn('Close')]);
    const { rows, btnW } = drawn(ctx);
    expect(btnW).toBeGreaterThan(THREE_COL);
    expect(rows.map((r) => r.glyph)).toEqual([true, true]);
  });

  it('draws no glyph for a button that asked for none', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Wild city'], [{ label: 'Siege', action: vi.fn() }, btn('Close')]);
    expect(drawn(ctx).rows.map((r) => r.glyph)).toEqual([false, true]);
  });
});
