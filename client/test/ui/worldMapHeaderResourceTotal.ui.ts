// Coverage for the 2026-08-09 UI fix: the per-resource stockpile totals that used to live only
// in the right-side troops/territory card were moved up into the header production readout,
// stacked as a second line under each resource's "+<rate>" line — so the rate and the total for
// a resource read together instead of in two separate panels. See design/DECISIONS.md / user
// feedback screenshot (2026-08-09) and WorldMapPanels/hud.ts::renderHeaderHud.
//
// Same headless-PIXI harness as worldMapHeaderProduction.ui.ts / worldMapBuffRow.ui.ts.
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
const TOP_INSET = 86;

function buildHudHarness(yieldRate: Record<string, number> = {}, resources: Record<string, number> = {}) {
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, troops: 10, troopCap: 100, territoryCount: 1, resources, yieldRate },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

function findCluster(ctx: WorldMapContext): PIXI.Container {
  const cluster = (ctx.headerHudLayer.children as PIXI.DisplayObject[])
    .find((c): c is PIXI.Container => c.constructor === PIXI.Container);
  if (!cluster) throw new Error('production cluster not found in headerHudLayer');
  return cluster;
}

function clusterTexts(ctx: WorldMapContext): string[] {
  return (findCluster(ctx).children as PIXI.DisplayObject[])
    .filter((c): c is PIXI.Text => c instanceof PIXI.Text)
    .map((t) => t.text);
}

/** All PIXI.Text content directly under ctx.hudLayer (the troops/territory card lives here). */
function hudTexts(ctx: WorldMapContext): string[] {
  return (ctx.hudLayer.children as PIXI.DisplayObject[])
    .filter((c): c is PIXI.Text => c instanceof PIXI.Text)
    .map((tx) => tx.text);
}

describe('WorldMapPanels.renderHud — resource stockpile totals moved into the header cluster (2026-08-09)', () => {
  it('the header cluster shows both the "+<rate>" line and the raw stockpile total for every resource', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 12, paper: 7, graphite: 3, metal: 20, sticker: 1 },
      { ink: 197374, paper: 196866, graphite: 2004, metal: 3080, sticker: 440 },
    );
    panels.renderHud();
    const texts = clusterTexts(ctx);
    expect(texts).toEqual(expect.arrayContaining(['+12', '+7', '+3', '+20', '+1']));
    expect(texts).toEqual(expect.arrayContaining(['197374', '196866', '2004', '3080', '440']));
  });

  it('renders an empty total label (not "undefined") for a resource missing from ctx.me.resources', () => {
    const { ctx, panels } = buildHudHarness({ ink: 5 }, {}); // no resources at all yet
    panels.renderHud();
    const texts = clusterTexts(ctx);
    expect(texts.some((s) => s.includes('undefined'))).toBe(false);
  });

  it('the troops/territory card no longer draws individual per-resource count labels (moved up to the header)', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 12 },
      { ink: 197374, paper: 196866, graphite: 2004, metal: 3080, sticker: 440 },
    );
    panels.renderHud();
    // The old implementation drew a bare "197374" (etc.) directly under hudLayer next to the
    // troops/territory line; that number must now only exist in the header cluster.
    expect(hudTexts(ctx).some((s) => s === '197374')).toBe(false);
    expect(clusterTexts(ctx).some((s) => s === '197374')).toBe(true);
  });

  it('still draws the troops/territory line itself in the status card', () => {
    const { ctx, panels } = buildHudHarness({}, {});
    panels.renderHud();
    expect(hudTexts(ctx).some((s) => s.includes('10/100'))).toBe(true);
  });

  it('re-rendering (as the ~5s march poll does) does not leak extra Text children into the cluster', () => {
    const { ctx, panels } = buildHudHarness({ ink: 1 }, { ink: 100 });
    panels.renderHud();
    const first = clusterTexts(ctx).length;
    panels.renderHud();
    panels.renderHud();
    expect(clusterTexts(ctx).length).toBe(first);
  });
});
