// Regression coverage for the 2026-07-14 change: the SLG world-map header bar dropped its
// static "World" title and now shows a live per-resource production readout instead, with the
// auction button moved out of the left column (Zoom/Auction stack) to the header bar's own far
// right corner. See design/game/SLG_DESIGN_LOG.md §25 "标题栏改为资源产量 + 拍卖行移至右上角".
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — WorldMapPanels
// imports pixi.js-legacy.

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

const [W, H] = [800, 600];
const TOP_INSET = 86; // matches sceneHeaderHeight(600) = round(600*0.12)

function buildHudHarness(topInset: number, yieldRate: Record<string, number> = {}) {
  const ctx = {
    w: W, h: H,
    topInset,
    backRect: { x: 0, y: 0, w: 160, h: topInset },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

describe('WorldMapPanels.renderHud — header bar shows production, not the "World" title', () => {
  it('the auction button lands at the header bar\'s far right, not the left column', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET);
    panels.renderHud();
    // Left column (Zoom/Back) sits near x=0; the auction button must be nowhere near it.
    expect(ctx.aucBtnRect.x).toBeGreaterThan(W / 2);
    // Right-anchored: within a small margin of the screen's right edge (56px margin,
    // widened for narrow/notched viewports — see WorldMapPanels.renderHeaderHud).
    expect(ctx.aucBtnRect.x + ctx.aucBtnRect.w).toBeGreaterThan(W - 60);
    expect(ctx.aucBtnRect.x + ctx.aucBtnRect.w).toBeLessThanOrEqual(W);
  });

  it('the auction button sits inside the header band (vertically), not the old fixed HUD row', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET);
    panels.renderHud();
    expect(ctx.aucBtnRect.y).toBeGreaterThanOrEqual(0);
    expect(ctx.aucBtnRect.y + ctx.aucBtnRect.h).toBeLessThanOrEqual(TOP_INSET);
  });

  it('a taller header keeps the auction button vertically centered within the new topInset', () => {
    const short = buildHudHarness(60);
    short.panels.renderHud();
    const tall = buildHudHarness(140);
    tall.panels.renderHud();
    expect(short.ctx.aucBtnRect.y + short.ctx.aucBtnRect.h).toBeLessThanOrEqual(60);
    expect(tall.ctx.aucBtnRect.y + tall.ctx.aucBtnRect.h).toBeLessThanOrEqual(140);
    expect(tall.ctx.aucBtnRect.h).toBeGreaterThan(short.ctx.aucBtnRect.h);
  });

  /** Production labels live inside the cluster Container (not directly under headerHudLayer) —
   *  find that cluster (the one plain Container that isn't the auction button's chrome/icon/text)
   *  and read its Text children's rendered strings. */
  function findCluster(ctx: WorldMapContext): PIXI.Container {
    const cluster = (ctx.headerHudLayer.children as PIXI.DisplayObject[])
      .find((c): c is PIXI.Container => c.constructor === PIXI.Container);
    if (!cluster) throw new Error('production cluster not found in headerHudLayer');
    return cluster;
  }

  function productionLabels(ctx: WorldMapContext): string[] {
    return (findCluster(ctx).children as PIXI.DisplayObject[])
      .filter((c): c is PIXI.Text => c instanceof PIXI.Text)
      .map((t) => t.text);
  }

  it('draws a "+<rate>" label for every one of the 5 season resources, reading ctx.me.yieldRate', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET, {
      ink: 12, paper: 7, graphite: 3, metal: 20, sticker: 1,
    });
    panels.renderHud();
    expect(productionLabels(ctx)).toEqual(expect.arrayContaining(['+12', '+7', '+3', '+20', '+1']));
  });

  it('falls back to "+0" for resources with no yieldRate entry yet', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET, {});
    panels.renderHud();
    expect(productionLabels(ctx).filter((s) => s === '+0')).toHaveLength(5);
  });

  it('the production readout is horizontally centered between the back button and the auction button, not overlapping either', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET, { ink: 5, paper: 5, graphite: 5, metal: 5, sticker: 5 });
    panels.renderHud();
    const cluster = findCluster(ctx);
    expect(cluster.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.aucBtnRect.x);
  });

  it('re-rendering (as the ~5s march poll does) tears down and rebuilds the header layer without leaking children', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET, { ink: 1, paper: 2, graphite: 3, metal: 4, sticker: 5 });
    panels.renderHud();
    const firstCount = ctx.headerHudLayer.children.length;
    panels.renderHud();
    panels.renderHud();
    expect(ctx.headerHudLayer.children.length).toBe(firstCount);
  });
});
