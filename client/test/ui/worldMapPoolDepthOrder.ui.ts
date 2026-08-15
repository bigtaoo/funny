// Coverage for the 2026-08-15 isometric painter's-order fix in WorldMapRenderer/pool.ts
// (user report: "瞭望塔和拒马的表现太奇怪了，看起来乱糟糟的").
//
// The tile pool is a MODULO-WRAP torus: a tile at (tx,ty) always lands in slot
// `(ty % poolH) * poolW + (tx % poolW)`, and that slot's position inside
// `poolContainer.children` is fixed at buildPool() time. So a slot's paint order had nothing
// to do with its screen depth, AND the mapping shifts as you pan — a tile drawn on top of its
// neighbour at one pan offset could end up underneath it after scrolling one tile. That was
// invisible while every tile's art stayed inside its own diamond, but structure sprites
// (watchtower/blocker) and landmark buildings (keep/stronghold) rise well above it.
//
// The fix stamps `slot.g.zIndex = tx + ty` (screen y ∝ tx+ty under the 2:1 iso projection) and
// turns on `poolContainer.sortableChildren`. The property these tests actually assert is the
// user-visible one — after sorting, paint order runs strictly back-to-front in screen y — and
// they re-assert it at several pan offsets, because a single offset can pass by luck (the
// torus mapping IS y-ordered when the visible window happens to start at a multiple of the
// pool size, which is exactly why this bug survived so long).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
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

const LAYOUT = { designWidth: 1280, designHeight: 800 } as ILayout;

const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

/** WorldMapScene's wiring minus WorldMapNet, already built (same shape as worldMapRefreshBundle.ui.ts). */
function newScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.centerAt(100, 100);
  ctx.view.build();
  return ctx;
}

/**
 * Paint order as PIXI will resolve it: children after the zIndex sort the renderer applies.
 * Calling sortChildren() explicitly is what `sortableChildren` makes the renderer do on its
 * own — doing it here keeps the test free of a real renderer.
 */
function paintOrder(ctx: WorldMapContext): PIXI.DisplayObject[] {
  ctx.poolContainer.sortChildren();
  return ctx.poolContainer.children;
}

/** First index where a child paints BEFORE one that is further back on screen, or -1 if none. */
function firstDepthInversion(children: PIXI.DisplayObject[]): number {
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.y < children[i - 1]!.y) return i;
  }
  return -1;
}

describe('WorldMapRenderer tile pool — isometric paint order (2026-08-15)', () => {
  it('turns on zIndex sorting for the tile pool', () => {
    const ctx = newScene();
    expect(ctx.poolContainer.sortableChildren).toBe(true);
    expect(ctx.pool.length).toBeGreaterThan(0);
  });

  it('gives every slot a zIndex equal to its tile depth rank (tx + ty)', () => {
    const ctx = newScene();
    for (const s of ctx.pool) expect(s.g.zIndex).toBe(s.tx + s.ty);
  });

  it('paints strictly back-to-front in screen y, at every pan offset', () => {
    const ctx = newScene();
    // A whole tile, a half tile, and a prime-ish nudge: each maps the visible window onto the
    // torus differently, so at least one of them lands on the mis-ordered case the fix targets.
    for (const dx of [0, ctx.tp, ctx.tp / 2, 37, 113]) {
      ctx.panX -= dx;
      ctx.panY -= dx;
      ctx.view.refreshPool();
      const children = paintOrder(ctx);
      expect(children.length).toBe(ctx.pool.length);
      expect(firstDepthInversion(children)).toBe(-1);
    }
  });

  it('paints the frontmost tile last, so its building sprite is never buried by the row behind', () => {
    const ctx = newScene();
    const children = paintOrder(ctx);
    const maxY = Math.max(...children.map((c) => c.y));
    expect(children[children.length - 1]!.y).toBe(maxY);
  });

  it('keeps the order correct after a zoom change rebuilds the pool from scratch', () => {
    const ctx = newScene();
    // buildPool() drops every slot and re-adds fresh Graphics — sortableChildren and the zIndex
    // stamping both have to survive that, not just the first build.
    ctx.view.setZoom(2);

    expect(ctx.poolContainer.sortableChildren).toBe(true);
    for (const s of ctx.pool) expect(s.g.zIndex).toBe(s.tx + s.ty);
    expect(firstDepthInversion(paintOrder(ctx))).toBe(-1);
  });

  it('leaves the pool alone at zoom 3, which renders through the batched L3 Graphics instead', () => {
    const ctx = newScene();
    ctx.view.setZoom(3);

    expect(ctx.pool.length).toBe(0);
    expect(ctx.poolContainer.visible).toBe(false);
    expect(ctx.mapGfxL3.visible).toBe(true);
  });
});
