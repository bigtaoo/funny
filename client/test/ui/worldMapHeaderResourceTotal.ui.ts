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

/** Landscape design dimensions (LandscapeLayout: designHeight fixed at 1080, designWidth grows
 *  with aspect — 1920 is the classic 16:9 baseline). sceneHeaderHeight(1080) = round(1080*0.12).
 *  Used by the "landscape unaffected" tests below (2026-08-11). */
const LANDSCAPE_W = 1920;
const LANDSCAPE_TOP_INSET = 130;

function buildHudHarness(
  yieldRate: Record<string, number> = {},
  resources: Record<string, number> = {},
  dims: { w?: number; topInset?: number; mainBaseTile?: string } = {},
) {
  const w = dims.w ?? W;
  const topInset = dims.topInset ?? TOP_INSET;
  const ctx = {
    w, h: H,
    topInset,
    backRect: { x: 0, y: 0, w: 160, h: topInset },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, mainBaseTile: dims.mainBaseTile, troops: 10, troopCap: 100, territoryCount: 1, resources, yieldRate },
    marches: [],
    teamPanelExpanded: false,
    teams: [],
    teamsLoaded: false,
    occupations: [],
    stationed: [],
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[p.length - 2]), Number(p[p.length - 1])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

function findCluster(ctx: WorldMapContext): PIXI.Container {
  // Bare `PIXI.Container` identity alone isn't enough to single this out any more: the shop entry
  // button's icon (`coinSack`, 2026-08-25) is now a raster glyph, which `buildRasterTabIcon` also
  // wraps in a bare `new PIXI.Container()` — so `headerHudLayer.children` can hold TWO exact-Container
  // matches, and `.find()` would grab whichever button icon comes first instead of the real
  // per-resource readout. The readout is the only one of the two that ever holds PIXI.Text children
  // (rate/total labels); an icon glyph box holds only its sprite.
  const cluster = (ctx.headerHudLayer.children as PIXI.Container[])
    .find((c) => c.constructor === PIXI.Container
      && c.children.some((ch) => ch instanceof PIXI.Text));
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

  // 2026-08-11 portrait clipping fix: with real-world 6-digit stockpiles (see the user's
  // screenshot — 45859/136108/144207/135884), the 5-resource cluster's nominal (unscaled)
  // width badly overflows the header's available space between the back button and the
  // shop/auction buttons — nothing previously clamped it, so the tail resources' totals
  // rendered past the visible canvas edge and were cut off mid-digit. renderHeaderHud now
  // shrinks the whole cluster to fit; assert it never overlaps the shop button regardless
  // of how large the numbers get.
  it('shrinks the cluster so large 6-digit totals never overlap the shop button', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 100, paper: 0, graphite: 600, metal: 0, sticker: 0 },
      { ink: 45859, paper: 136108, graphite: 144207, metal: 135884, sticker: 999999 },
    );
    panels.renderHud();
    const cluster = findCluster(ctx);
    expect(cluster.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.shopBtnRect.x);
    // Every total must still be present (not dropped/truncated) — just drawn smaller.
    const texts = clusterTexts(ctx);
    expect(texts).toEqual(
      expect.arrayContaining(['45859', '136108', '144207', '135884', '999999'])
    );
  });

  it('does not shrink the cluster when it already fits (small totals stay at full scale)', () => {
    const { ctx, panels } = buildHudHarness({ ink: 5 }, { ink: 12, paper: 3 });
    panels.renderHud();
    const cluster = findCluster(ctx);
    expect(cluster.scale.x).toBe(1);
  });

  // 2026-08-11 follow-up (user: "确保横屏不受影响" — make sure landscape is unaffected).
  // The shrink-to-fit fix above only exists because portrait's design width is fixed at 1080
  // (PortraitLayout.DESIGN_W) — landscape's is a much wider 1920+ (LandscapeLayout, designHeight
  // fixed at 1080 instead). Same 6-digit-stockpile numbers from the portrait overflow test,
  // rendered at landscape dimensions: the cluster must have ample room and never trigger the
  // shrink at all.
  it('landscape: the same 6-digit totals that overflow in portrait fit at full scale (no shrink)', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 100, paper: 0, graphite: 600, metal: 0, sticker: 0 },
      { ink: 45859, paper: 136108, graphite: 144207, metal: 135884, sticker: 999999 },
      { w: LANDSCAPE_W, topInset: LANDSCAPE_TOP_INSET },
    );
    panels.renderHud();
    const cluster = findCluster(ctx);
    expect(cluster.scale.x).toBe(1);
    expect(cluster.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.shopBtnRect.x);
    const texts = clusterTexts(ctx);
    expect(texts).toEqual(
      expect.arrayContaining(['45859', '136108', '144207', '135884', '999999'])
    );
  });

  // 2026-08-12 follow-up: the new "回家" (home) button (headerHud.ts) sits between the resource
  // cluster and the shop button once the player has a base, so the cluster's actual available
  // width shrinks further than these tests above ever exercised (they never set mainBaseTile,
  // so homeBtnRect stayed a zero rect and the shrink-to-fit right bound fell back to the shop
  // button, same as before the home button existed). Rerun the exact overflow scenario with a
  // base placed to confirm the fit now respects the tighter home-button boundary instead.
  it('with a base placed (home button present), the same 6-digit totals shrink to fit against the home button, not the shop button', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 100, paper: 0, graphite: 600, metal: 0, sticker: 0 },
      { ink: 45859, paper: 136108, graphite: 144207, metal: 135884, sticker: 999999 },
      { mainBaseTile: 'world:1:0:30:40' },
    );
    panels.renderHud();
    expect(ctx.homeBtnRect.w).toBeGreaterThan(0); // sanity: home button actually rendered
    const cluster = findCluster(ctx);
    expect(cluster.x).toBeGreaterThanOrEqual(ctx.backRect.x + ctx.backRect.w);
    // The tighter bound: home button, not shop button (which now sits further right, past home).
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.homeBtnRect.x);
    const texts = clusterTexts(ctx);
    expect(texts).toEqual(
      expect.arrayContaining(['45859', '136108', '144207', '135884', '999999'])
    );
  });

  it('landscape + base placed: the same 6-digit totals still fit at full scale against the home button', () => {
    const { ctx, panels } = buildHudHarness(
      { ink: 100, paper: 0, graphite: 600, metal: 0, sticker: 0 },
      { ink: 45859, paper: 136108, graphite: 144207, metal: 135884, sticker: 999999 },
      { w: LANDSCAPE_W, topInset: LANDSCAPE_TOP_INSET, mainBaseTile: 'world:1:0:30:40' },
    );
    panels.renderHud();
    expect(ctx.homeBtnRect.w).toBeGreaterThan(0);
    const cluster = findCluster(ctx);
    expect(cluster.scale.x).toBe(1);
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.homeBtnRect.x);
  });
});
