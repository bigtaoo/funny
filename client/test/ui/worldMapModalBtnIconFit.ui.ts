// The tile-menu button glyph gate (WorldMapPanels/core.ts `labelFitsBesideGlyph`, 2026-09-03).
//
// Batch 9 drew seven tile-menu glyphs and then measured, in a real browser, that five of them could
// never appear: the gate was `btnW >= 200`, and `btnW` is a pure function of the button COUNT
// (`min(300, (900 - 12·(cols+1)) / cols)` with `cols = min(n, 5)`), so it is 166 for any menu with
// five or more buttons — the owned-tile menu has nine. Shortening the labels, which was the
// recorded plan, could not have helped: the old gate never looked at a label. It now measures the
// label at the narrowed width instead, so what decides the glyph is whether the label can afford
// the 34px it costs.
//
// The cases below therefore pin the DECISION RULE, not any particular label: a five-across menu
// draws glyphs for labels that fit, and drops them exactly where the glyph would push the label
// onto another line. The first case fails against the old width proxy (nine 166px columns, zero
// glyphs).
//
// Label widths here are the headless adapter's, NOT the real font's: test/harness/pixiHeadless.ts
// measures every string at 7px/char at every font size, so `LONE_LINE`/`SPILLS` below are sized in
// those units and the real-font equivalents (32px monospace: 32px per CJK glyph, 17.6 per Latin
// char) are not what this file is asserting. What survives the difference is the rule.
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

/** Column width every menu of five or more buttons gets — the number the old gate rejected. */
const NARROW_COL = 166;

/** Fits a 166px column on one line either way (7px/char → 21px). */
const SHORT = 'Aa1';
/** Fits `166 - 16 = 150` on one line (147px) but not the `150 - 34 = 116` left beside a glyph. */
const LONE_LINE = 'x'.repeat(21);
/** Already two lines at 150 (168px), still two beside a glyph (< 2 × 116). */
const ALREADY_WRAPS = 'y'.repeat(24);

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
 * Per-button `{ label, glyph }` as drawn. A glyph is the one child of the modal layer inside the
 * button's rect that is a container wrapping a single sprite (`buildIcon`'s box) rather than the
 * button's own `sketchPanel` graphics or its `PIXI.Text` label.
 */
function drawn(ctx: WorldMapContext): { label: string; glyph: boolean; btnW: number }[] {
  const texts: PIXI.Text[] = [];
  const glyphs: PIXI.Container[] = [];
  for (const child of ctx.modalLayer.children as PIXI.DisplayObject[]) {
    if (child instanceof PIXI.Text) texts.push(child);
    else if (child instanceof PIXI.Container && child.children.length === 1
      && child.children[0] instanceof PIXI.Sprite) glyphs.push(child);
  }
  const inside = (o: PIXI.DisplayObject, r: { x: number; y: number; w: number; h: number }): boolean =>
    o.x >= r.x - 2 && o.x <= r.x + r.w && o.y >= r.y && o.y <= r.y + r.h;
  return ctx.modalBtnRects.map(({ rect }) => ({
    label: texts.find((tx) => inside(tx, rect))?.text ?? '',
    glyph: glyphs.some((g) => inside(g, rect)),
    btnW: Math.round(rect.w),
  }));
}

const btn = (label: string): ModalButton => ({ label, action: vi.fn(), icon: 'flag' });

describe('tile-menu buttons — the leading glyph is gated on measured fit, not column width', () => {
  it('draws a glyph on every button of a nine-across menu whose labels are short', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], Array.from({ length: 9 }, () => btn(SHORT)));
    const rows = drawn(ctx);
    expect(rows).toHaveLength(9);
    // The pre-2026-09-03 gate turned all nine of these off for being under 200px wide.
    expect(rows.map((r) => r.btnW)).toEqual(Array(9).fill(NARROW_COL));
    expect(rows.filter((r) => r.glyph)).toHaveLength(9);
  });

  it('drops the glyph only on the button whose label would gain a line, not on its neighbours', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], [btn(SHORT), btn(LONE_LINE), btn(SHORT), btn(SHORT), btn(SHORT)]);
    const rows = drawn(ctx);
    expect(rows.map((r) => r.btnW)).toEqual(Array(5).fill(NARROW_COL));
    expect(rows.map((r) => r.glyph)).toEqual([true, false, true, true, true]);
  });

  it('keeps the glyph on a label that already wraps, since the glyph costs it no further line', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['My territory'], [btn(ALREADY_WRAPS), btn(SHORT), btn(SHORT), btn(SHORT), btn(SHORT)]);
    expect(drawn(ctx).map((r) => r.glyph)).toEqual([true, true, true, true, true]);
  });

  it('still draws glyphs in the wide columns of a two-button confirm', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Wild city'], [btn('Siege'), btn('Close')]);
    const rows = drawn(ctx);
    expect(rows.every((r) => r.btnW > NARROW_COL)).toBe(true);
    expect(rows.map((r) => r.glyph)).toEqual([true, true]);
  });

  it('draws no glyph for a button that asked for none', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Wild city'], [{ label: 'Siege', action: vi.fn() }, btn('Close')]);
    expect(drawn(ctx).map((r) => r.glyph)).toEqual([false, true]);
  });
});
