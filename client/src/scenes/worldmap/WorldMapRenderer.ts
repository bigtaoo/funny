// WorldMapRenderer — SLG overworld map/tile rendering + view transforms. Thin assembly file.
//
// The renderer is split by concern — each part lives in ./WorldMapRenderer/*.ts as an independent
// class constructed with the shared `WorldMapRendererCore` (./WorldMapRenderer/core.ts, which owns
// `ctx` + the memoized NPC-city node list) and composed here. To add behavior: find the matching
// domain class (build / viewport / pool / city / fog / vignette / lifecycle) or add a new one — do
// NOT grow this file. Importers resolve `from './WorldMapRenderer'` to this file (not the
// directory), so the class export stays stable.
//
// 2026-08-12: converted from the former `XMixin(Base)` inheritance chain (7 applications deep) to
// composition — see claudedocs/client-modules.md's split-form priority note. The old chain had TWO
// genuine bidirectional dependencies, both hubbed on pool.ts:
//   1. pool.ts called `this.refreshCityLayer()` (city.ts); city.ts called `this.isBaseAnchor()`
//      (pool.ts).
//   2. pool.ts called `this.renderOverlay()` (fog.ts); fog.ts's `renderMap()` called
//      `this.invalidatePool()` (pool.ts) — the two were in fact fully equivalent (`renderMap()`
//      was a one-line forward to `invalidatePool()`).
// Rather than patch each pair separately (e.g. two LobbyScene-style lazy hooks), both pairs traced
// back to the SAME misdrawn boundary: pool.ts's `buildPool()`/`invalidatePool()`/`refreshPool()`
// were the actual trigger for "map data changed, redraw everything" (called from build.ts's
// build(), viewport.ts's setZoom(), and — via the renderMap() alias — a dozen external call sites
// in WorldMapNet/WorldMapInput/WorldMapPanels), but that orchestration lived inside the pool
// domain, which has no business calling into city or fog. So the fix hoists the trigger here: pool
// no longer calls city or fog at all (city still calls pool.isBaseAnchor() — a one-directional
// City → Pool dependency, not a cycle); this assembly's invalidatePool()/refreshPool() explicitly
// sequence `pool.*` + `city.refreshCityLayer()` + `fog.renderOverlay()`, and build.ts/viewport.ts
// (which need that same full-refresh bundle mid-method, before this assembly has finished
// constructing) take it as an injected `refreshMap` callback closing over `this` — safe because,
// like every constructor in this chain, `build()`/`setZoom()` only ever run after the outer
// `new WorldMapRenderer(ctx)` call has fully returned (WorldMapScene calls `ctx.view.build()`
// as a separate statement afterward), by which point every sibling field below is assigned.
import { WorldMapRendererCore } from './WorldMapRenderer/core';
import { WorldMapRendererBuild } from './WorldMapRenderer/build';
import { WorldMapRendererViewport } from './WorldMapRenderer/viewport';
import { WorldMapRendererPool } from './WorldMapRenderer/pool';
import { WorldMapRendererCity } from './WorldMapRenderer/city';
import { WorldMapRendererFog } from './WorldMapRenderer/fog';
import { WorldMapRendererVignette } from './WorldMapRenderer/vignette';
import { WorldMapRendererLifecycle } from './WorldMapRenderer/lifecycle';
import type { WorldMapContext } from './WorldMapContext';

/**
 * WorldMapRenderer — the map/tile renderer wired into WorldMapScene via ctx.view.
 * Assembled from the per-domain composition over WorldMapRendererCore (see the file-header
 * comment above).
 */
export class WorldMapRenderer {
  private readonly core: WorldMapRendererCore;
  private readonly pool: WorldMapRendererPool;
  private readonly city: WorldMapRendererCity;
  private readonly fog: WorldMapRendererFog;
  private readonly vignette: WorldMapRendererVignette;
  private readonly buildPanel: WorldMapRendererBuild;
  private readonly viewport: WorldMapRendererViewport;
  private readonly lifecycle: WorldMapRendererLifecycle;

  constructor(ctx: WorldMapContext) {
    this.core = new WorldMapRendererCore(ctx);
    this.pool = new WorldMapRendererPool(this.core);
    this.city = new WorldMapRendererCity(this.core, this.pool);
    this.fog = new WorldMapRendererFog(this.core);
    this.vignette = new WorldMapRendererVignette(this.core);
    const refreshMap = (): void => this.invalidatePool();
    this.buildPanel = new WorldMapRendererBuild(this.core, this.pool, refreshMap);
    this.viewport = new WorldMapRendererViewport(this.core, this.pool, refreshMap);
    this.lifecycle = new WorldMapRendererLifecycle(this.core, this.fog, this.vignette, this.buildPanel, refreshMap);
  }

  // ── build (./WorldMapRenderer/build.ts) ───────────────────────────────────
  build(): void {
    this.buildPanel.build();
  }

  // ── viewport (./WorldMapRenderer/viewport.ts) ─────────────────────────────
  viewportCenter(): { cx: number; cy: number; r: number } {
    return this.viewport.viewportCenter();
  }

  setZoom(z: 1 | 2 | 3): void {
    this.viewport.setZoom(z);
  }

  centerAt(tx: number, ty: number): void {
    this.viewport.centerAt(tx, ty);
  }

  clampPan(): void {
    this.viewport.clampPan();
  }

  screenToTile(sx: number, sy: number): { x: number; y: number } {
    return this.viewport.screenToTile(sx, sy);
  }

  // ── pool + city + fog orchestration (see the file-header comment) ────────
  /**
   * Full "map data changed" refresh: invalidate the tile pool, reposition/redraw city sprites,
   * and redraw the interactive overlay. The one entry point that legitimately needs to know
   * about all three domains — do not push this logic back down into pool.ts (see file header).
   */
  invalidatePool(): void {
    this.pool.invalidatePool();
    this.city.refreshCityLayer();
    this.fog.renderOverlay();
  }

  /** Legacy entry point — called from action handlers after data changes. Alias of invalidatePool(). */
  renderMap(): void {
    this.invalidatePool();
  }

  /** Reposition city sprites + (at L1/L2) the tile pool — used by the drag-to-pan input path. */
  refreshPool(): void {
    this.city.refreshCityLayer();
    this.pool.refreshPool();
  }

  refreshCityLayer(): void {
    this.city.refreshCityLayer();
  }

  renderOverlay(dt?: number): void {
    this.fog.renderOverlay(dt);
  }

  renderMapL3(): void {
    this.fog.renderMapL3();
  }

  // ── vignette (./WorldMapRenderer/vignette.ts) ─────────────────────────────
  flashDamageVignette(): void {
    this.vignette.flashDamageVignette();
  }

  // ── lifecycle (./WorldMapRenderer/lifecycle.ts) ───────────────────────────
  update(dt: number): void {
    this.lifecycle.update(dt);
  }

  bootstrap(): void {
    this.lifecycle.bootstrap();
  }

  destroy(): void {
    this.lifecycle.destroy();
  }
}
