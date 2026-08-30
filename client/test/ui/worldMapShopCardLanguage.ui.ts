// Visual-language contract for the SLG shop's item cards (UI_DESIGN_LOG_2026-08.md §43).
//
// Why this file exists, and why it is colours rather than behaviour: the world-map shop and the
// lobby shop are two independent implementations of one concept ("a product card"), and they had
// silently grown two different palettes — a full blue frame vs a thin rule + accent bar, a second
// frame around the icon, a solid-accent Buy band vs an ink one, a grey "{cost} coins" sentence vs
// the shared coin cluster. None of that was visible to the suite: `worldMapShopPanel.ui.ts`'s 27
// cases assert which icon, which gate, which callback, and every one of them passed against the
// pre-2026-08-30 palette. Same failure mode §41.1 wrote up for the scale pass, one layer over.
//
// So this asserts the palette, and — the part that actually keeps the two from drifting apart
// again — cross-checks it against what `ShopScene/card.ts`'s own `drawCard`/`drawButton` produce
// for an equivalent card, rather than only against hard-coded tokens. A token-only test would go
// green on a day someone restyles the lobby and leaves the SLG behind, which is the exact bug.
//
// Both are asserted anyway: the cross-check pins "the two agree", the literal tokens pin "and they
// agree on THIS", so a change that moves both at once still has to be deliberate.
//
// How the colours are read: with no renderer and no atlas, `sketchPanel` takes its documented
// fallback and returns a bare `PIXI.Graphics` whose `geometry.graphicsData` holds the fill rect
// first and every SketchPen stroke after it, each carrying its own `lineStyle.color` and points.
// That is enough to tell "a rule around the whole cell" from "a bar down its left edge" by the x
// range of the strokes, which is the property the accent bar actually has.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { ui as C } from '../../src/render/sketchUi';
import { drawCard } from '../../src/scenes/ShopScene/card';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldMapPanelsCore } from '../../src/scenes/worldmap/WorldMapPanels/core';
import type { SlgShopItemView } from '../../src/net/WorldApiClient';
import type { ShopSceneCore, CardSpec } from '../../src/scenes/ShopScene/core';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// The cell geometry renderShopPanel computes for a `PANEL_W.md` panel in portrait, hard-coded so
// this file tests one card in isolation instead of hunting it out of a rendered grid.
const CELL_W = 422;
const CELL_H = 204;

const ITEM: SlgShopItemView = {
  id: 'sp1', cost: 200, kind: 'troop_speedup', effect: { duration_sec: 3600 }, description: '',
};

// ── Reading colours back out of a headless sketchPanel ───────────────────────

interface GraphicsDatum {
  fillStyle: { color: number; visible: boolean };
  lineStyle: { color: number; visible: boolean };
  shape: { points?: number[] };
}

const dataOf = (g: PIXI.Graphics): GraphicsDatum[] =>
  (g.geometry as unknown as { graphicsData: GraphicsDatum[] }).graphicsData;

/** The one visible fill colour a sketchPanel lays down before its strokes. */
function fillOf(g: PIXI.Graphics): number {
  const d = dataOf(g).find((x) => x.fillStyle.visible);
  expect(d, 'panel has a visible fill').toBeDefined();
  return d!.fillStyle.color;
}

/** Every stroke colour on a panel, with the x range it spans — a frame spans the whole width, a
 *  left accent bar spans a sliver of it. */
function strokesOf(g: PIXI.Graphics): Map<number, { count: number; minX: number; maxX: number }> {
  const out = new Map<number, { count: number; minX: number; maxX: number }>();
  for (const d of dataOf(g)) {
    if (!d.lineStyle.visible) continue;
    const e = out.get(d.lineStyle.color) ?? { count: 0, minX: Infinity, maxX: -Infinity };
    e.count++;
    const pts = d.shape.points ?? [];
    for (let i = 0; i < pts.length; i += 2) {
      e.minX = Math.min(e.minX, pts[i]!);
      e.maxX = Math.max(e.maxX, pts[i]!);
    }
    out.set(d.lineStyle.color, e);
  }
  return out;
}

const textsIn = (c: PIXI.Container): PIXI.Text[] => {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children as PIXI.DisplayObject[]) {
      if (ch instanceof PIXI.Text) out.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(c);
  return out;
};

/** PIXI normalises a numeric `fill` to '#rrggbb' on the way into the style object. */
const textFill = (t: PIXI.Text): number => {
  const f = t.style.fill as number | string;
  return typeof f === 'string' ? parseInt(f.replace('#', ''), 16) : f;
};

// ── Harnesses ────────────────────────────────────────────────────────────────

/** Draws ONE SLG card into a bare container: [cell, icon, (badge), name, coin, amount, band, label]. */
function slgCard(opts: { coins?: number; hasBattlePass?: boolean; item?: SlgShopItemView } = {}) {
  const item = opts.item ?? ITEM;
  const doBuyShopItem = vi.fn();
  const ctx = {
    w: 1080, h: 1920,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    shopItems: [item],
    me: { joined: true, ...(opts.hasBattlePass ? { hasBattlePass: true } : {}) },
    cb: { accountId: 'me', getCoins: () => opts.coins ?? 99999, worldApi: { getShopItems: vi.fn() } },
    net: { doBuyShopItem },
    view: { renderMap: vi.fn() },
  } as unknown as WorldMapContext;
  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;

  // `renderShopItemCard` is private on ShopPanel, which is itself a private field on the
  // WorldMapPanels facade — TS privacy is erased at runtime, so the plain double cast used
  // throughout worldMapShopPanel.ui.ts reaches through both layers (see its shopIconApi note).
  const shop = (panels as unknown as {
    shop: { renderShopItemCard(l: PIXI.Container, it: SlgShopItemView, x: number, y: number, w: number, h: number): void };
  }).shop;

  const layer = new PIXI.Container();
  shop.renderShopItemCard(layer, item, 0, 0, CELL_W, CELL_H);

  const gfx = (layer.children as PIXI.DisplayObject[]).filter((c): c is PIXI.Graphics => c instanceof PIXI.Graphics);
  return { ctx, panels, layer, doBuyShopItem, cell: gfx[0]!, band: gfx[gfx.length - 1]!, directGraphics: gfx };
}

/** Draws the equivalent LOBBY card (ShopScene/card.ts) into a bare container, for the cross-check. */
function lobbyCard(enabled = true) {
  const core = { artHooked: new Set<string>(), hits: [], render: vi.fn() } as unknown as ShopSceneCore;
  const spec: CardSpec = {
    icon: 'hourglassSm', iconColor: C.accent, title: 'Train speedup 1h', coinAmount: 200,
    buttons: [{ label: 'Buy', enabled, primary: true, fn: vi.fn() }],
  };
  const body = new PIXI.Container();
  drawCard(core, body, spec, 0, 0, CELL_W, CELL_H);
  const gfx = (body.children as PIXI.DisplayObject[]).filter((c): c is PIXI.Graphics => c instanceof PIXI.Graphics);
  return { body, cell: gfx[0]!, band: gfx[gfx.length - 1]! };
}

// ── The contract ─────────────────────────────────────────────────────────────

describe('SLG shop card — frame', () => {
  it('fills with card stock and rules the cell in C.line, not a full accent frame', () => {
    const { cell } = slgCard();
    expect(fillOf(cell)).toBe(C.paper);
    const strokes = strokesOf(cell);
    const rule = strokes.get(C.line);
    expect(rule, 'the cell is ruled in C.line').toBeDefined();
    // A frame spans the cell; this is what rules out the pre-2026-08-30 whole-cell blue border
    // having merely been recoloured into a stub.
    expect(rule!.maxX - rule!.minX).toBeGreaterThan(CELL_W * 0.9);
  });

  it('carries the accent as a bar down the left edge, not as a border', () => {
    const { cell } = slgCard();
    const accent = strokesOf(cell).get(C.accent);
    expect(accent, 'sketchAccentBar drew an accent stroke').toBeDefined();
    // Every accent-coloured stroke sits in the left sliver. Restoring the old full C.accent frame
    // fails here, because that stroke would reach the right edge.
    expect(accent!.maxX).toBeLessThan(CELL_W * 0.1);
  });

  it('draws no second frame around the icon — the card has exactly two panels, cell and Buy band', () => {
    const { directGraphics } = slgCard();
    expect(directGraphics).toHaveLength(2);
  });
});

describe('SLG shop card — Buy band', () => {
  it('is an ink band with a green primary stroke, not a solid accent fill', () => {
    const { band } = slgCard({ coins: 99999 });
    expect(fillOf(band)).toBe(C.dark);
    const strokes = strokesOf(band);
    expect(strokes.has(C.green), 'primary action strokes green').toBe(true);
    expect(strokes.has(C.accent), 'and not the default blue').toBe(false);
  });

  it('greys out with the shared disabled styling when the item is unaffordable', () => {
    const { band } = slgCard({ coins: 10 }); // ITEM costs 200
    expect(fillOf(band)).toBe(C.btnDis);
    expect(strokesOf(band).has(C.btnOff)).toBe(true);
  });

  it('greys out the same way for an already-owned battle pass', () => {
    const bp: SlgShopItemView = {
      id: 'bp', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: '',
    };
    const { band } = slgCard({ item: bp, hasBattlePass: true, coins: 99999 });
    expect(fillOf(band)).toBe(C.btnDis);
  });
});

describe('SLG shop card — price', () => {
  it('prints the cost as a gold bold number and never spells the unit out', () => {
    const { layer } = slgCard();
    const texts = textsIn(layer);
    const amount = texts.find((t) => t.text === '200');
    expect(amount, 'the price is the bare formatted number').toBeDefined();
    expect(textFill(amount!)).toBe(C.gold);
    expect(amount!.style.fontWeight).toBe('bold');
    // The glyph is the unit (SceneHeader/currency.ts buildCluster) — no card text may name it.
    expect(texts.some((t) => /coin|金币|Münz/i.test(t.text))).toBe(false);
  });

  it('pairs the number with a coin glyph, so the unit is not simply missing', () => {
    // Asserted by node count, not by geometry: `buildIcon` resolves both of this card's glyphs
    // through the raster path, and with no decoded texture `buildInkIcon` hands back an EMPTY
    // container (icons.ts / inkIconRaster.ts) — so their bounds are 0x0 headlessly and nothing
    // positional can be pinned here. Two icon containers is still the property that matters:
    // dropping the coin glyph and leaving a bare gold number would name the unit nowhere at all.
    const { layer, directGraphics } = slgCard();
    const icons = (layer.children as PIXI.DisplayObject[]).filter(
      (c) => c instanceof PIXI.Container && !(c instanceof PIXI.Text) && !directGraphics.includes(c as PIXI.Graphics),
    );
    expect(icons, 'the item glyph and the coin glyph').toHaveLength(2);
  });
});

// The point of the batch: these two implementations must keep answering the same way. A token-only
// test above would stay green if the lobby moved and the SLG did not.
describe('SLG shop card vs the lobby card (ShopScene/card.ts) — same palette', () => {
  it('agrees on the card fill and the rule colour', () => {
    const slg = slgCard().cell;
    const lobby = lobbyCard().cell;
    expect(fillOf(slg)).toBe(fillOf(lobby));
    expect([...strokesOf(slg).keys()].sort()).toEqual([...strokesOf(lobby).keys()].sort());
  });

  it('agrees on the enabled Buy band — ink fill, green primary stroke', () => {
    const slg = slgCard({ coins: 99999 }).band;
    const lobby = lobbyCard(true).band;
    expect(fillOf(slg)).toBe(fillOf(lobby));
    expect([...strokesOf(slg).keys()]).toEqual([...strokesOf(lobby).keys()]);
  });

  it('agrees on the price colour', () => {
    const slgAmount = textsIn(slgCard().layer).find((t) => t.text === '200')!;
    const lobbyAmount = textsIn(lobbyCard().body).find((t) => t.text === '200')!;
    expect(textFill(slgAmount)).toBe(textFill(lobbyAmount));
    expect(slgAmount.style.fontWeight).toBe(lobbyAmount.style.fontWeight);
  });
});

// The green stroke is opt-in: `panelButtonIn` gained a `border` parameter for the shop's primary
// action, and every other world-map panel button must keep the blue it always had.
describe('panelButtonIn — the new border parameter defaults to the blue every other panel uses', () => {
  it('omitting `border` still strokes C.accent', () => {
    const { panels } = slgCard();
    const core = (panels as unknown as { core: WorldMapPanelsCore }).core;
    const layer = new PIXI.Container();
    core.panelButtonIn(layer, 'Jump', 0, 0, 120, 48, C.dark, vi.fn());
    const g = (layer.children as PIXI.DisplayObject[]).find((c): c is PIXI.Graphics => c instanceof PIXI.Graphics)!;
    const strokes = strokesOf(g);
    expect(strokes.has(C.accent)).toBe(true);
    expect(strokes.has(C.green)).toBe(false);
  });
});
