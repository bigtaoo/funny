// The world-map toast's own box (WorldMapPanels/core.ts showToast), reworked 2026-09-22 (§62).
//
// Two things happened to it and neither had a test. **The look**: every other scene's success toast
// is GlobalToast's solid green banner, while this one drew one dark box for everything — so a SLG
// shop purchase confirmed itself in the same ink-grey panel an error uses. `showToast` grew a
// `filled` flag for that, and only the *call site* is asserted elsewhere (worldMapShopBuyFlow.ui.ts
// checks the argument); nothing checked that the flag actually changes the paint. **The height**:
// it was a hard-coded 84px, which cropped the second line of any wrapped message — which naming the
// bought item ("Purchased: Resource pack (200000 each)") made routine rather than rare.
//
// Reading the paint: sketchPanel's atlas-frame path needs a renderer, so under the headless adapter
// it takes its documented fallback and returns the bare `PIXI.Graphics` with the fill as its first
// graphicsData entry — the same way dailySceneCheckinFocus.ui.ts reads cell colours.
//
// Text-metric caveat: the harness measures a flat ~7px/char and ~10px/line, so the wrapped-height
// case below uses a deliberately long string to clear the 84px floor by line COUNT. The real-font
// version of that check was done on screen (§62: en/de/zh screenshots), which is the only place a
// font's true line height is visible at all.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { ui as C } from '../../src/render/sketchUi';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1920, 1080];

function buildHarness() {
  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    selectedTile: null,
    toastTimer: 0,
    topInset: 0,
    shopItems: [],
    me: { joined: true },
    cb: { getCoins: () => 0 },
    view: { renderMap() {}, centerAt() {} },
  } as unknown as WorldMapContext;
  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

type GfxData = { fillStyle: { color: number; alpha: number }; lineStyle: { color: number; width: number } };

/** The toast box's own Graphics — first one in the layer, whatever nesting sketchPanel chose. */
function boxGfx(layer: PIXI.Container): PIXI.Graphics {
  let found: PIXI.Graphics | null = null;
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children as PIXI.DisplayObject[]) {
      if (found) return;
      if (ch instanceof PIXI.Graphics) { found = ch; return; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(layer);
  expect(found, 'the toast must draw a box').not.toBeNull();
  return found!;
}

function shapesOf(g: PIXI.Graphics): GfxData[] {
  return (g.geometry as unknown as { graphicsData: GfxData[] }).graphicsData;
}

function label(layer: PIXI.Container): PIXI.Text {
  const texts: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children as PIXI.DisplayObject[]) {
      if (ch instanceof PIXI.Text) texts.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(layer);
  expect(texts.length, 'the toast must draw exactly one label').toBe(1);
  return texts[0]!;
}

describe('WorldMapPanels.showToast — the box a purchase gets', () => {
  it('a filled toast paints the whole box in the passed colour (the lobby shop green)', () => {
    const { ctx, panels } = buildHarness();

    panels.showToast('Purchased: Train speedup 24h', C.green, true);

    const fill = shapesOf(boxGfx(ctx.toastLayer))[0]!.fillStyle;
    expect(fill.color).toBe(C.green);
    // Not the ink box at its notice alpha: GlobalToast's success banner is near-solid.
    expect(fill.color).not.toBe(C.dark);
    expect(fill.alpha).toBeGreaterThan(0.9);
  });

  it('the default toast is unchanged — dark box, the colour only as its border', () => {
    const { ctx, panels } = buildHarness();

    panels.showToast('Target must border your territory', C.red);

    const shapes = shapesOf(boxGfx(ctx.toastLayer));
    expect(shapes[0]!.fillStyle.color).toBe(C.dark);
    expect(shapes[0]!.fillStyle.color).not.toBe(C.red);
    // The border is stroked into the same Graphics by sketchPanel's fallback pen.
    expect(shapes.some((s) => s.lineStyle.color === C.red)).toBe(true);
  });
});

describe('WorldMapPanels.showToast — the box follows its text', () => {
  /** The drawn rect, in the box Graphics' own space. */
  const boxRect = (ctx: WorldMapContext): { width: number; height: number } =>
    (shapesOf(boxGfx(ctx.toastLayer))[0] as unknown as { shape: { width: number; height: number } }).shape;

  it('a one-line notice still gets the 84px box it always had', () => {
    const { ctx, panels } = buildHarness();

    panels.showToast('Sped up', C.green, true);

    expect(boxRect(ctx).height).toBe(84);
  });

  it('a message that wraps grows the box instead of being cropped by it', () => {
    const { ctx, panels } = buildHarness();
    // Long enough to wrap to many lines at ANY plausible metric, so the case is about the rule and
    // not about this harness's flat 7px/char (see the file header).
    panels.showToast(`Purchased: ${'Resource pack (200000 each) '.repeat(24)}`, C.green, true);

    const lbl = label(ctx.toastLayer);
    const { height } = boxRect(ctx);
    expect(lbl.height, 'the label must really have wrapped, or this case proves nothing')
      .toBeGreaterThan(84 - 32);
    expect(height).toBeGreaterThan(84);
    expect(height).toBeGreaterThanOrEqual(lbl.height + 32);
  });

  it('the label is centred, so a second line does not hang off to the left', () => {
    const { ctx, panels } = buildHarness();

    panels.showToast('Purchased: Resource pack (200000 each)', C.green, true);

    expect(label(ctx.toastLayer).style.align).toBe('center');
  });
});
