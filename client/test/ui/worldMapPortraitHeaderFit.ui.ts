// Regression coverage for the 2026-08-18 portrait header pass (found while shooting store
// screenshots — design/product/release/store-assets-checklist.md §0.5).
//
// Portrait design width is pinned at 1080 while sceneHeaderHeight (and every size derived from it)
// grows with the stretchy height axis, so on a tall phone the world-map header row overflowed
// itself: the Home/Shop/Auction buttons walked left over the back button, and the five-resource
// readout — whose shrink-to-fit had a 0.55 floor that deliberately accepted overflow — ran across
// the buttons and past the right edge. Portrait now puts the readout on its own strip below the bar
// (ctx.resStripH, set in WorldMapRenderer/build.ts) and drops the buttons' labels.
//
// Also covered: the troops/territory card's value label used to run out of its half-column at a
// full troop cap ("10000/10000"), overlapping the Territory column.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
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

// Real measured design space for an iPhone 15 Pro Max (1290x2796 → PortraitLayout keeps width at
// 1080 and stretches height): h = 2341, sceneHeaderHeight = round(2341*0.12) = 281, and build()'s
// portrait strip = round(281*0.46) = 129.
const PORTRAIT = { w: 1080, h: 2341, barH: 281, stripH: 129 };
// Landscape 16:9 baseline: designHeight pinned 1080, header 130, no strip.
const LANDSCAPE = { w: 1920, h: 1080, barH: 130, stripH: 0 };

function buildHarness(
  dims: { w: number; h: number; barH: number; stripH: number },
  opts: { resources?: Record<string, number>; troops?: number; troopCap?: number } = {},
) {
  const ctx = {
    w: dims.w, h: dims.h,
    headerBarH: dims.barH,
    resStripH: dims.stripH,
    topInset: dims.barH + dims.stripH,
    backRect: { x: 0, y: 0, w: Math.round(dims.barH * 1.41), h: dims.barH },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: {
      joined: true, mainBaseTile: 'w1:400:400',
      troops: opts.troops ?? 10000, troopCap: opts.troopCap ?? 10000, territoryCount: 11,
      resources: opts.resources ?? { ink: 10000, paper: 98765, graphite: 4321, metal: 8888, sticker: 777 },
      yieldRate: { ink: 100, paper: 60, graphite: 45, metal: 30, sticker: 12 },
    },
    marches: [],
    teamPanelExpanded: false,
    teams: [],
    teamsLoaded: false,
    occupations: [],
    stationed: [],
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[p.length - 2]), Number(p[p.length - 1])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;
  return { ctx, panels: new WorldMapPanels(ctx) };
}

/** The three header entry buttons, as rects, in whatever order they were laid out. */
function entryRects(ctx: WorldMapContext) {
  return [ctx.homeBtnRect, ctx.shopBtnRect, ctx.aucBtnRect];
}

function overlaps(a: { x: number; w: number }, b: { x: number; w: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

describe('world-map header row fits portrait', () => {
  it('entry buttons stay on screen and clear of the back button', () => {
    const { ctx, panels } = buildHarness(PORTRAIT);
    panels.renderHud();
    for (const r of entryRects(ctx)) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
      expect(r.x + r.w).toBeLessThanOrEqual(PORTRAIT.w);
    }
  });

  it('entry buttons do not overlap each other', () => {
    const { ctx, panels } = buildHarness(PORTRAIT);
    panels.renderHud();
    const [home, shop, auc] = entryRects(ctx);
    expect(overlaps(home!, shop!)).toBe(false);
    expect(overlaps(shop!, auc!)).toBe(false);
    expect(overlaps(home!, auc!)).toBe(false);
  });

  it('the resource readout sits in its own strip below the bar, fully on screen', () => {
    const { ctx, panels } = buildHarness(PORTRAIT);
    panels.renderHud();
    const r = ctx.resClusterRect;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(PORTRAIT.w);
    // Inside the strip band [barH, barH + stripH] — i.e. below the bar, above the map.
    expect(r.y).toBeGreaterThanOrEqual(PORTRAIT.barH);
    expect(r.y + r.h).toBeLessThanOrEqual(PORTRAIT.barH + PORTRAIT.stripH);
  });

  it('the resource readout never overlaps an entry button', () => {
    const { ctx, panels } = buildHarness(PORTRAIT);
    panels.renderHud();
    // Different bands vertically, so a horizontal overlap is fine now — but the readout must not
    // reach into the bar's own band at all, which is what the old in-bar layout did.
    expect(ctx.resClusterRect.y).toBeGreaterThanOrEqual(ctx.aucBtnRect.y + ctx.aucBtnRect.h);
  });

  it('the zoom chip clears the resource strip', () => {
    const { ctx, panels } = buildHarness(PORTRAIT);
    panels.renderHud();
    // It used to anchor off the back chip alone, which is exactly where the strip now sits.
    expect(ctx.zoomBtnRect.y).toBeGreaterThanOrEqual(PORTRAIT.barH + PORTRAIT.stripH);
  });

  it('landscape keeps the readout inside the bar, between back button and entry buttons', () => {
    const { ctx, panels } = buildHarness(LANDSCAPE);
    panels.renderHud();
    const r = ctx.resClusterRect;
    expect(r.y).toBeLessThan(LANDSCAPE.barH);
    expect(r.y + r.h).toBeLessThanOrEqual(LANDSCAPE.barH);
    expect(r.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
    expect(r.x + r.w).toBeLessThanOrEqual(ctx.homeBtnRect.x);
  });

  it('landscape entry buttons keep their text labels; portrait drops them', () => {
    const land = buildHarness(LANDSCAPE);
    land.panels.renderHud();
    const landLabels = (land.ctx.headerHudLayer.children as PIXI.DisplayObject[])
      .filter((c): c is PIXI.Text => c instanceof PIXI.Text).map((t) => t.text);
    expect(landLabels).toContain('Auction');

    const port = buildHarness(PORTRAIT);
    port.panels.renderHud();
    const portLabels = (port.ctx.headerHudLayer.children as PIXI.DisplayObject[])
      .filter((c): c is PIXI.Text => c instanceof PIXI.Text).map((t) => t.text);
    expect(portLabels).not.toContain('Auction');
  });
});

describe('troops/territory card', () => {
  /** The card's stat value labels ("10000/10000", "11") live directly on hudLayer. */
  function statLabels(ctx: WorldMapContext) {
    return (ctx.hudLayer.children as PIXI.DisplayObject[])
      .filter((c): c is PIXI.Text => c instanceof PIXI.Text);
  }

  it('a full troop cap stays inside its own half of the card', () => {
    const { ctx, panels } = buildHarness(PORTRAIT, { troops: 10000, troopCap: 10000 });
    panels.renderHud();
    const troopLbl = statLabels(ctx).find((t) => t.text === '10000/10000');
    expect(troopLbl).toBeDefined();
    // Card is 320 wide, right-anchored 16px off the edge; the troops column is its left half.
    const cardX = PORTRAIT.w - 320 - 16;
    expect(troopLbl!.x + troopLbl!.width).toBeLessThanOrEqual(cardX + 160);
  });

  it('a short value is not scaled down', () => {
    const { ctx, panels } = buildHarness(PORTRAIT, { troops: 12, troopCap: 100 });
    panels.renderHud();
    const troopLbl = statLabels(ctx).find((t) => t.text === '12/100');
    expect(troopLbl).toBeDefined();
    expect(troopLbl!.scale.x).toBe(1);
  });
});
