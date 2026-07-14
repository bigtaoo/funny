/**
 * worldMapCameraTopInset.test.ts — regression coverage for the 2026-07-13 SLG header
 * unification: WorldMapScene's top now reserves `ctx.topInset` (the SceneHeader bar
 * height) exactly like `HUD_H` is already reserved at the bottom. The camera's
 * clamping/centering math (WorldMapRenderer/viewport.ts) has to treat the visible
 * band as `[topInset, h - HUD_H]` instead of `[0, h - HUD_H]`, or the map ends up
 * centered/clamped behind the now-opaque header bar.
 *
 * ViewportMixin itself has no PIXI import, but WorldMapRendererBase (its usual
 * super-class, ./WorldMapRenderer/base.ts) pulls in `@nw/shared` for the NPC-city
 * node list — unaliased in this project's default (non-`.ui.ts`) vitest config,
 * which deliberately scopes plain `.test.ts` runs to the PIXI/`@nw/shared`-free
 * game-logic core. So this test mixes ViewportMixin onto a minimal stand-in base
 * (same constructor/`cityNodes()` shape, no `@nw/shared` import) instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { ViewportMixin } from '../src/scenes/worldmap/WorldMapRenderer/viewport';
import { HUD_H } from '../src/scenes/worldmap/constants';
import { tileToScreen } from '../src/render/isoGrid';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';

class FakeRendererBase {
  protected readonly ctx: WorldMapContext;
  constructor(ctx: WorldMapContext) { this.ctx = ctx; }
  protected cityNodes(): unknown[] { return []; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Renderer = ViewportMixin(FakeRendererBase as any);

/** Same renderer, but clampPan is stubbed to a no-op — isolates centerAt/setZoom's own pan
 *  math from clampPan's separate (also topInset-aware, tested on its own below) clamping.
 *  A plain instance override (rather than a `class ... extends Renderer` subclass) sidesteps
 *  a TS quirk where re-extending a mixin-produced intersection constructor type loses the
 *  inherited methods' parameter types. */
function newNoClampRenderer(ctx: WorldMapContext): InstanceType<typeof Renderer> {
  const r = new Renderer(ctx);
  r.clampPan = () => {};
  return r;
}

function makeCtx(overrides: Partial<WorldMapContext> & { tp?: number } = {}): WorldMapContext {
  const { tp, ...rest } = overrides;
  const base = {
    w: 1000,
    h: 800,
    topInset: 80,
    panX: 0,
    panY: 0,
    mapW: 10,
    mapH: 10,
    zoom: 1,
    panels: { renderHud: vi.fn() },
    net: { loadMapViewport: vi.fn().mockResolvedValue(undefined) },
    ...rest,
  };
  if (tp !== undefined) {
    // Fixed tile size, for tests that don't care about per-zoom scaling.
    return { ...base, tp } as unknown as WorldMapContext;
  }
  // Real WorldMapContext.tp is a getter over zoomCfgs[zoom-1].tile — different per zoom
  // level. setZoom's re-centering math only actually moves the camera when old/new tile
  // sizes differ, so a fixed `tp` (same value regardless of `this.ctx.zoom`) would make
  // that test pass trivially. Mirror the real per-zoom-level tile size instead.
  const ZOOM_TP: Record<number, number> = { 1: 20, 2: 10, 3: 5 };
  return {
    ...base,
    get tp(): number { return ZOOM_TP[(this as { zoom: number }).zoom]!; },
  } as unknown as WorldMapContext;
}

const BOTTOM = 800 - HUD_H; // 744 — bottom of the visible band, unaffected by topInset

describe('WorldMapRenderer viewport — topInset-aware camera math', () => {
  it('clampPan centers a map smaller than the band within [topInset, bottom], not [0, bottom]', () => {
    // mapW=mapH=10, tp=20 → the map's projected diamond is only 100px tall, comfortably
    // smaller than any reasonable band height, so clampPan takes the "lock centered" branch.
    const ctx = makeCtx({ mapW: 10, mapH: 10, panY: 999 /* arbitrary pre-clamp value */ });
    const r = new Renderer(ctx);
    r.clampPan();

    const minSy = tileToScreen(0, 0, ctx.tp).y;
    const maxSy = tileToScreen(ctx.mapW, ctx.mapH, ctx.tp).y;
    const contentMid = (minSy + ctx.panY + maxSy + ctx.panY) / 2;
    // The content's vertical midpoint must land on the midpoint of the RESERVED band
    // (topInset..bottom), not the midpoint of the full screen (0..bottom).
    expect(contentMid).toBeCloseTo((ctx.topInset + BOTTOM) / 2, 5);
  });

  it('clampPan bounds a map larger than the band to [topInset, bottom], not [0, bottom]', () => {
    // mapW=mapH=200 → projected diamond is 2000px tall, far exceeding the ~660px band,
    // so clampPan takes the "keep the viewport inside the map" clamp branch.
    const minSy = tileToScreen(0, 0, 20).y;
    const maxSy = tileToScreen(200, 200, 20).y;

    const north = makeCtx({ mapW: 200, mapH: 200, panY: 999999 }); // try to scroll past the north edge
    new Renderer(north).clampPan();
    // Clamped so the map's TOP edge sits exactly at topInset (not 0).
    expect(minSy + north.panY).toBeCloseTo(north.topInset, 5);

    const south = makeCtx({ mapW: 200, mapH: 200, panY: -999999 }); // try to scroll past the south edge
    new Renderer(south).clampPan();
    // Clamped so the map's BOTTOM edge sits exactly at `bottom` (h - HUD_H) — this edge
    // is untouched by topInset, only the top edge should move.
    expect(maxSy + south.panY).toBeCloseTo(BOTTOM, 5);

    // Regression check: with topInset=0 the north clamp lands back at the old y=0 edge —
    // proves the 80px shift above is really coming from topInset, not some other constant.
    const northNoInset = makeCtx({ mapW: 200, mapH: 200, panY: 999999, topInset: 0 });
    new Renderer(northNoInset).clampPan();
    expect(minSy + northNoInset.panY).toBeCloseTo(0, 5);
  });

  it('centerAt places the target tile at the vertical midpoint of the reserved band', () => {
    const ctx = makeCtx({ topInset: 80 });
    const r = newNoClampRenderer(ctx);
    r.centerAt(5, 5);

    const s = tileToScreen(5, 5, ctx.tp);
    expect(ctx.panX).toBeCloseTo(ctx.w / 2 - s.x, 5);
    expect(ctx.panY).toBeCloseTo((ctx.topInset + BOTTOM) / 2 - s.y, 5);

    // Same call with topInset=0 must land the tile higher on screen (no header reserved) —
    // guards against centerAt silently ignoring topInset.
    const ctxNoInset = makeCtx({ topInset: 0 });
    const r2 = newNoClampRenderer(ctxNoInset);
    r2.centerAt(5, 5);
    expect(ctxNoInset.panY).toBeLessThan(ctx.panY);
  });

  it('viewportCenter reads the visible tile range from within the reserved band', () => {
    // A large map (so the visible window doesn't get edge-clamped against mapW/mapH)
    // centered with a big panY offset lets us assert the reported center tile actually
    // shifts when topInset changes — if topInset were ignored, both calls below would
    // report the same center tile.
    const big = { mapW: 400, mapH: 400 };
    const withInset = new Renderer(makeCtx({ ...big, topInset: 80, panX: -2000, panY: -2000 })).viewportCenter();
    const noInset = new Renderer(makeCtx({ ...big, topInset: 0, panX: -2000, panY: -2000 })).viewportCenter();
    expect(withInset.cy).not.toBe(noInset.cy);
  });

  it('setZoom re-centers using the reserved-band midpoint, not the full-screen midpoint', () => {
    const ctx = makeCtx({ zoom: 1, topInset: 80, panX: 0, panY: 0 });
    const r = newNoClampRenderer(ctx);
    (r as unknown as { buildPool(): void }).buildPool = vi.fn();
    (r as unknown as { invalidatePool(): void }).invalidatePool = vi.fn();
    r.setZoom(2);
    expect(ctx.zoom).toBe(2);
    expect(ctx.panels.renderHud).toHaveBeenCalled();

    const ctxNoInset = makeCtx({ zoom: 1, topInset: 0, panX: 0, panY: 0 });
    const r2 = newNoClampRenderer(ctxNoInset);
    (r2 as unknown as { buildPool(): void }).buildPool = vi.fn();
    (r2 as unknown as { invalidatePool(): void }).invalidatePool = vi.fn();
    r2.setZoom(2);

    // Both start centered on the same tile (0,0) at zoom 1 with panX=panY=0; re-centering
    // after the zoom change should still land on that same tile, but the topInset=80 run's
    // panY must differ from the topInset=0 run's — otherwise setZoom silently drops topInset.
    expect(ctx.panY).not.toBe(ctxNoInset.panY);
  });
});
