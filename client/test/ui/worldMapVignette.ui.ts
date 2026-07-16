// Regression coverage for D-CITY-8's client "表现层" (world-map base HP bar + full-screen
// red-tint VFX, task #4): the VignetteMixin drawing/decay logic (WorldMapRenderer/vignette.ts)
// and the WorldMapNet.applyTileUpdate trigger that decides WHEN to flash it.
//
// The HP bar itself needed no client change (tileGraphics.ts's existing drawHpBar already draws
// for any damaged tile, own base included, once the server started mapping durability into the
// existing WorldTileView.hp/maxHp fields) — see design/game/SLG_CITY_DESIGN.md §8.2. This file
// only covers the new vignette.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — PIXI.Graphics builds
// real (CPU-only) geometry with no renderer/WebGL, so graphicsData.length is a reliable
// "did this actually draw something" check without needing a canvas pixel read.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView } from '../../src/net/WorldApiClient';
import type { TileUpdate } from '../../src/net/proto/transport';

/** Flush the microtask/macrotask queue so a mocked-promise-driven async chain (applyTileUpdate's
 * loadMapViewport().then(...)) has settled before assertions run. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── VignetteMixin: flashDamageVignette / updateVignette / drawVignette ──────────────────────

function buildRendererCtx(): WorldMapContext {
  return {
    w: 390,
    h: 844,
    vignetteGfx: new PIXI.Graphics(),
    vignetteAlpha: 0,
  } as unknown as WorldMapContext;
}

describe('WorldMapRenderer vignette (D-CITY-8 base-damage flash)', () => {
  it('flashDamageVignette sets alpha to 1 and draws a non-empty screen-edge overlay', () => {
    const ctx = buildRendererCtx();
    const view = new WorldMapRenderer(ctx);
    view.flashDamageVignette();
    expect(ctx.vignetteAlpha).toBe(1);
    expect(ctx.vignetteGfx.geometry.graphicsData.length).toBeGreaterThan(0);
  });

  it('updateVignette decays alpha over the ~0.55s fade window and keeps redrawing while active', () => {
    const ctx = buildRendererCtx();
    const view = new WorldMapRenderer(ctx);
    view.flashDamageVignette();

    view.updateVignette(0.2);
    expect(ctx.vignetteAlpha).toBeGreaterThan(0);
    expect(ctx.vignetteAlpha).toBeLessThan(1);
    expect(ctx.vignetteGfx.geometry.graphicsData.length).toBeGreaterThan(0);

    view.updateVignette(10); // well past the fade window
    expect(ctx.vignetteAlpha).toBe(0);
    // Once fully faded, the overlay must be cleared — not left painted at the last alpha.
    expect(ctx.vignetteGfx.geometry.graphicsData.length).toBe(0);
  });

  it('updateVignette is a no-op when alpha is already 0 (no redundant redraw every frame)', () => {
    const ctx = buildRendererCtx();
    const view = new WorldMapRenderer(ctx);
    expect(ctx.vignetteAlpha).toBe(0);
    view.updateVignette(0.016);
    expect(ctx.vignetteAlpha).toBe(0);
    expect(ctx.vignetteGfx.geometry.graphicsData.length).toBe(0);
  });

  it('drawVignette clears the overlay outright when alpha is 0', () => {
    const ctx = buildRendererCtx();
    const view = new WorldMapRenderer(ctx);
    // Paint something first, then force alpha back to 0 and redraw — must come back empty.
    view.flashDamageVignette();
    ctx.vignetteAlpha = 0;
    view.drawVignette();
    expect(ctx.vignetteGfx.geometry.graphicsData.length).toBe(0);
  });
});

// ── WorldMapNet.applyTileUpdate: only flash when OUR OWN base's hp just dropped ─────────────

const WORLD_ID = 'world:1:0';
const BASE_TILE_ID = `${WORLD_ID}:5:5`;

function makeTile(overrides: Partial<WorldTileView> = {}): WorldTileView {
  return { x: 5, y: 5, type: 'base', level: 1, maxHp: 500, hp: 500, ...overrides } as WorldTileView;
}

/** Builds a minimal fake ctx wired for applyTileUpdate → loadMapViewport's zoom===1 branch, with
 * worldApi.getMap mocked to resolve with a single tile at (5,5) carrying `pushedHp`. */
function buildNetHarness(opts: { mainBaseTile?: string | null; cachedHp?: number; pushedHp: number }) {
  const flashDamageVignette = vi.fn();
  const renderMap = vi.fn();
  const getMap = vi.fn().mockResolvedValue({ tiles: [makeTile({ hp: opts.pushedHp })] });

  const tileCache = new Map<string, WorldTileView>();
  if (opts.cachedHp != null) tileCache.set('5:5', makeTile({ hp: opts.cachedHp }));

  const me = opts.mainBaseTile === null ? null : ({ joined: true, mainBaseTile: opts.mainBaseTile ?? BASE_TILE_ID } as PlayerWorldView);

  const ctx = {
    destroyed: false,
    zoom: 1,
    me,
    tileCache,
    cb: { worldId: WORLD_ID, worldApi: { getMap } },
    view: { viewportCenter: () => ({ cx: 5, cy: 5, r: 2 }), renderMap, flashDamageVignette },
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, flashDamageVignette, renderMap, getMap };
}

describe('WorldMapNet.applyTileUpdate — base-damage vignette trigger (D-CITY-8)', () => {
  it('flashes when the pushed tile IS our own main base and its hp dropped', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ cachedHp: 500, pushedHp: 350 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).toHaveBeenCalledTimes(1);
  });

  it('does NOT flash when hp increased (regen tick / wall upgrade rebasing durabilityMax)', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ cachedHp: 300, pushedHp: 450 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).not.toHaveBeenCalled();
  });

  it('does NOT flash when hp is unchanged', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ cachedHp: 500, pushedHp: 500 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).not.toHaveBeenCalled();
  });

  it('does NOT flash when the pushed tile is not our main base (some other tile changed)', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ mainBaseTile: `${WORLD_ID}:9:9`, cachedHp: 500, pushedHp: 100 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).not.toHaveBeenCalled();
  });

  it('does NOT flash when the player has no main base yet (mainBaseTile unset)', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ mainBaseTile: null, cachedHp: 500, pushedHp: 100 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).not.toHaveBeenCalled();
  });

  it('does NOT flash on the very first push with nothing cached yet (no prior hp to compare against)', async () => {
    const { net, flashDamageVignette } = buildNetHarness({ pushedHp: 350 }); // cachedHp omitted — cold tileCache
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(flashDamageVignette).not.toHaveBeenCalled();
  });

  it('still refreshes the viewport and re-renders regardless of whether it flashed', async () => {
    const { net, renderMap } = buildNetHarness({ cachedHp: 500, pushedHp: 350 });
    net.applyTileUpdate({ tileId: BASE_TILE_ID } as TileUpdate);
    await flush();
    expect(renderMap).toHaveBeenCalledTimes(1);
  });
});
