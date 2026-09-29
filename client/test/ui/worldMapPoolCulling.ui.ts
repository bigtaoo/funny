// Coverage for ADR-102: the world map's tile pool hides (and does not redraw) the slots that lie
// off screen.
//
// The pool is the tile-space bounding box of the visible screen rectangle, and under the 2:1
// isometric projection that rectangle is a diamond in tile space — so the box's four corners, about
// half the slots, never reach the screen. Hiding them keeps the renderer and the change detector
// (render/renderPolicy.ts, which does not descend into invisible subtrees) away from ~800 nodes.
//
// The property that matters to the player is the opposite one: no tile that should be on screen
// is ever missing or stale. So besides "some slots are culled", these tests assert, at several pan
// offsets, that every map tile whose art can reach the visible band has a shown slot at its screen
// position that last drew THAT tile — the lazy redraw of a slot scrolling back into view is exactly
// where a culling bug would leave a hole or a tile from somewhere else.
import { describe, it, expect } from 'vitest';
import type * as PIXI from 'pixi.js-legacy';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapRendererPool, PoolSlot } from '../../src/scenes/worldmap/WorldMapRenderer/pool';
import { tileToScreen, ISO_RATIO } from '../../src/render/isoGrid';
import { HUD_H } from '../../src/scenes/worldmap/logic/constants';
import type { ILayout } from '../../src/layout/ILayout';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

/** WorldMapScene's wiring minus WorldMapNet, already built (same shape as worldMapPoolDepthOrder.ui.ts). */
function newScene(designWidth = 1280, designHeight = 800): WorldMapContext {
  const ctx = new WorldMapContext({ designWidth, designHeight } as ILayout, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  recordDraws(ctx);
  ctx.view.centerAt(100, 100);
  ctx.view.build();
  return ctx;
}

/** The tile each slot's Graphics last DREW — tracked independently of `slot.tx/ty`, which is only
 *  the pool's own claim about it. */
const drawnTile = new WeakMap<PIXI.Graphics, string>();
function recordDraws(ctx: WorldMapContext): void {
  const pool = (ctx.view as unknown as { pool: WorldMapRendererPool }).pool;
  const draw = pool.drawTileSlot.bind(pool);
  pool.drawTileSlot = (slot: PoolSlot, tx: number, ty: number): void => {
    drawnTile.set(slot.g, `${tx},${ty}`);
    draw(slot, tx, ty);
  };
}

/**
 * Every in-map tile whose diamond overlaps the visible band [topInset, h - HUD_H]. A deliberately
 * narrower test than the renderer's own margin (which also covers art rising above the diamond), so
 * it cannot pass by sharing the implementation's constants.
 */
function tilesOnScreen(ctx: WorldMapContext): { tx: number; ty: number; x: number; y: number }[] {
  const tp = ctx.tp;
  const hw = tp / 2;
  const hh = (tp * ISO_RATIO) / 2;
  const out: { tx: number; ty: number; x: number; y: number }[] = [];
  for (let ty = 0; ty < ctx.mapH; ty++) {
    for (let tx = 0; tx < ctx.mapW; tx++) {
      const s = tileToScreen(tx, ty, tp);
      const x = ctx.panX + s.x;
      const y = ctx.panY + s.y;
      // Diamond-vs-rectangle: the diamond is |dx|/hw + |dy|/hh < 1, a sum of terms that each grow
      // with one coordinate's distance, so its minimum over the rectangle is at the clamped point.
      const px = Math.max(0, Math.min(ctx.w, x));
      const py = Math.max(ctx.topInset, Math.min(ctx.h - HUD_H, y));
      if (Math.abs(x - px) / hw + Math.abs(y - py) / hh >= 1) continue;
      out.push({ tx, ty, x, y });
    }
  }
  return out;
}

function expectNoHoles(ctx: WorldMapContext): void {
  const shown = new Map<string, PoolSlot>();
  for (const s of ctx.pool) if (s.g.visible) shown.set(`${s.g.x},${s.g.y}`, s);
  const need = tilesOnScreen(ctx);
  expect(need.length).toBeGreaterThan(0);
  for (const t of need) {
    const slot = shown.get(`${t.x},${t.y}`);
    expect(slot, `tile ${t.tx},${t.ty} has no shown slot (pan ${ctx.panX},${ctx.panY})`).toBeDefined();
    expect(slot).toMatchObject({ tx: t.tx, ty: t.ty });
    expect(drawnTile.get(slot!.g), `tile ${t.tx},${t.ty} shows another tile's drawing`).toBe(`${t.tx},${t.ty}`);
  }
}

describe('WorldMapRenderer tile pool — viewport culling (ADR-102)', () => {
  it('hides a large share of the pool: the slots in the corners of its tile-space box', () => {
    const ctx = newScene();
    const hidden = ctx.pool.filter((s) => !s.g.visible).length;
    // ~half the box is off screen; the margin for tall art keeps some of it. Well above a rounding error.
    expect(hidden / ctx.pool.length).toBeGreaterThan(0.3);
  });

  it('shows every tile that reaches the visible band, drawn with that tile, at every pan offset', () => {
    const ctx = newScene();
    expectNoHoles(ctx);
    // Whole tiles, half tiles and odd nudges in both directions: slots leave the screen, wrap around
    // the torus and come back as different tiles, which is where a lazily-skipped redraw would show.
    for (const [dx, dy] of [[ctx.tp, 0], [0, ctx.tp / 2], [37, -113], [-3 * ctx.tp, 2 * ctx.tp], [-251, -19], [5 * ctx.tp, 0]]) {
      ctx.panX += dx!;
      ctx.panY += dy!;
      ctx.view.refreshPool();
      expectNoHoles(ctx);
    }
  });

  it('shows a slot again with its old tile when it comes back without the tile changing', () => {
    const ctx = newScene();
    // Out and back by exactly one pool width keeps each slot's tile; the ones culled on the way
    // must reappear rather than stay hidden because "nothing changed".
    const w = ctx.zc.poolW * ctx.tp;
    ctx.panX -= w / 2; ctx.panY -= w / 4;
    ctx.view.refreshPool();
    ctx.panX += w / 2; ctx.panY += w / 4;
    ctx.view.refreshPool();
    expectNoHoles(ctx);
  });

  it('redraws the shown slots on a data refresh and leaves no hole behind', () => {
    const ctx = newScene();
    ctx.view.invalidatePool();
    expectNoHoles(ctx);
  });

  it('holds at the other zoom level and in portrait', () => {
    const ctx = newScene();
    ctx.view.setZoom(2);
    expectNoHoles(ctx);
    const portrait = newScene(1080, 1920);
    expectNoHoles(portrait);
    expect(portrait.pool.some((s) => !s.g.visible)).toBe(true);
  });
});
