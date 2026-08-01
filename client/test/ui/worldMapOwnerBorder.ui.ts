// Coverage for the 2026-08-01 world-map declutter pass: a tile's ownership border should only
// draw where it actually touches a boundary (a differently-owned, or unowned/uncached,
// neighbor) — see WorldMapRenderer/pool.ts::ownerHasBoundary and tileGraphics.ts's new
// `ownerBorder` param on drawTileL1/drawTileL2. Before this fix, every owned tile drew its own
// border independently, so a solid block of same-owner territory repeated the same diamond
// outline tile after tile and read as a dense grid (reported: "地图看起来有些混乱").
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { drawTileL1, drawTileL2 } from '../../src/scenes/worldmap/tileGraphics';
import { MINE_TINT, MINE_BASE_TINT } from '../../src/scenes/worldmap/tileStyle';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

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

function buildScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.build();
  return ctx;
}

function mineTile(x: number, y: number, extra: Partial<WorldTileView> = {}): WorldTileView {
  return { x, y, type: 'territory', level: 1, mine: true, ...extra } as WorldTileView;
}

// TS privacy on ownerHasBoundary (declared via the PoolMixin's PoolHandlers interface) is
// compile-time only — calling it through `as any` here mirrors the existing pattern the
// codebase already uses for reaching into scene internals in throwaway/debug contexts.
function hasBoundary(ctx: WorldMapContext, owner: number, x: number, y: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx.view as any).ownerHasBoundary(owner, x, y);
}

describe('ownerHasBoundary (2026-08-01 declutter pass)', () => {
  it('an interior tile fully surrounded by the same owner has no boundary', () => {
    const ctx = buildScene();
    ctx.tileCache.set('5:5', mineTile(5, 5));
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      ctx.tileCache.set(`${5 + dx}:${5 + dy}`, mineTile(5 + dx, 5 + dy));
    }
    expect(hasBoundary(ctx, MINE_TINT, 5, 5)).toBe(false);
  });

  it('a tile bordering a different owner has a boundary', () => {
    const ctx = buildScene();
    ctx.tileCache.set('5:5', mineTile(5, 5));
    ctx.tileCache.set('4:5', mineTile(4, 5));
    ctx.tileCache.set('6:5', mineTile(6, 5));
    ctx.tileCache.set('5:4', mineTile(5, 4));
    ctx.tileCache.set('5:6', { x: 5, y: 6, type: 'territory', level: 1, occupied: true } as WorldTileView); // enemy
    expect(hasBoundary(ctx, MINE_TINT, 5, 5)).toBe(true);
  });

  it('a tile next to an unowned/uncached neighbor has a boundary (conservative — never merge across missing data)', () => {
    const ctx = buildScene();
    ctx.tileCache.set('5:5', mineTile(5, 5));
    ctx.tileCache.set('4:5', mineTile(4, 5));
    ctx.tileCache.set('6:5', mineTile(6, 5));
    ctx.tileCache.set('5:4', mineTile(5, 4));
    // (5,6) intentionally left out of the cache (outside vision / never fetched).
    expect(hasBoundary(ctx, MINE_TINT, 5, 5)).toBe(true);
  });

  it("a capital tile's own outline is preserved against surrounding territory (MINE_BASE_TINT != MINE_TINT)", () => {
    const ctx = buildScene();
    ctx.tileCache.set('5:5', mineTile(5, 5, { type: 'base' }));
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      ctx.tileCache.set(`${5 + dx}:${5 + dy}`, mineTile(5 + dx, 5 + dy)); // plain territory, not base
    }
    expect(hasBoundary(ctx, MINE_BASE_TINT, 5, 5)).toBe(true);
  });
});

describe('drawTileL1 / drawTileL2 ownerBorder gating (2026-08-01 declutter pass)', () => {
  function spyLineStyle(g: PIXI.Graphics): { width: number; color: number; alpha: number }[] {
    const calls: { width: number; color: number; alpha: number }[] = [];
    vi.spyOn(g, 'lineStyle').mockImplementation(function (
      this: PIXI.Graphics, width?, color?: any, alpha?: any,
    ) {
      calls.push({ width: Number(width ?? 0), color: Number(color ?? 0), alpha: Number(alpha ?? 1) });
      return this;
    });
    return calls;
  }
  function spyBeginFill(g: PIXI.Graphics): { color: number; alpha: number }[] {
    const calls: { color: number; alpha: number }[] = [];
    vi.spyOn(g, 'beginFill').mockImplementation(function (this: PIXI.Graphics, color?, alpha?: number) {
      calls.push({ color: Number(color ?? 0), alpha: Number(alpha ?? 1) });
      return this;
    });
    return calls;
  }

  it('drawTileL1 skips the border stroke when ownerBorder=false but still draws the wash', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const lineStyles = spyLineStyle(g);
    const tile = mineTile(5, 5);
    drawTileL1(g, tile, 0xffffff, MINE_TINT, false, 76, false, 'terrain_grass', null, 5, 5, 'w1', false);

    expect(beginFills.some(f => f.color === MINE_TINT && f.alpha === 0.16)).toBe(true); // wash still drawn
    expect(lineStyles.some(l => l.width === 1.6 && l.color === MINE_TINT)).toBe(false); // border suppressed
  });

  it('drawTileL1 draws the border stroke when ownerBorder=true (default)', () => {
    const g = new PIXI.Graphics();
    const lineStyles = spyLineStyle(g);
    const tile = mineTile(5, 5);
    drawTileL1(g, tile, 0xffffff, MINE_TINT, false, 76, false, 'terrain_grass', null, 5, 5, 'w1');
    expect(lineStyles.some(l => l.width === 1.6 && l.color === MINE_TINT)).toBe(true);
  });

  it('drawTileL2 skips its (heavier) border stroke when ownerBorder=false but keeps the stronger wash', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const lineStyles = spyLineStyle(g);
    drawTileL2(g, 0xffffff, MINE_TINT, false, 38, false);
    expect(beginFills.some(f => f.color === MINE_TINT && f.alpha === 0.42)).toBe(true);
    expect(lineStyles.some(l => l.width === 1.4 && l.color === MINE_TINT)).toBe(false);
  });

  it('drawTileL2 draws the border stroke when ownerBorder=true (default)', () => {
    const g = new PIXI.Graphics();
    const lineStyles = spyLineStyle(g);
    drawTileL2(g, 0xffffff, MINE_TINT, false, 38);
    expect(lineStyles.some(l => l.width === 1.4 && l.color === MINE_TINT)).toBe(true);
  });
});
