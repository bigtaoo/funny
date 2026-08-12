// Scene lifecycle: per-frame update (loading spinner, toast timer, L3 flush),
// atlas bootstrap behind the loading cover, and teardown of pooled Graphics / city sprites.
import * as PIXI from 'pixi.js-legacy';
import { loadResAtlas } from '../../../render/atlas/resAtlasLoader';
import { loadCityAtlas } from '../../../render/atlas/cityAtlasLoader';
import { loadPlayerBaseAtlas } from '../../../render/atlas/playerBaseAtlasLoader';
import { loadTerrainAtlas } from '../../../render/atlas/terrainAtlasLoader';
import { loadBuildingAtlas } from '../../../render/atlas/buildingAtlasLoader';
import { tearDownChildren } from '../../../render/sketchUi';
import { destroyTokenEntry } from './tokens';
import { drawShieldDome, drawShieldGlow, drawShieldBreakFx, SHIELD_BREAK_LIFE } from './shieldFx';
import { updateLoadingErase, cancelLoadingErase } from './loadingReveal';
import type { WorldMapRendererCore } from './core';
import type { WorldMapRendererFog } from './fog';
import type { WorldMapRendererVignette } from './vignette';
import type { WorldMapRendererBuild } from './build';

export interface LifecycleHandlers {
  update(dt: number): void;
  bootstrap(): void;
  destroy(): void;
}

export class WorldMapRendererLifecycle implements LifecycleHandlers {
  constructor(
    private readonly core: WorldMapRendererCore,
    private readonly fog: WorldMapRendererFog,
    private readonly vignette: WorldMapRendererVignette,
    private readonly build: WorldMapRendererBuild,
    /** Full pool+city+overlay refresh (WorldMapRenderer.invalidatePool()/renderMap()) — bootstrap()
     *  needs it once the atlases settle, same as the pre-conversion `this.renderMap()` mixin call did. */
    private readonly refreshMap: () => void,
  ) {}

  update(dt: number): void {
    const ctx = this.core.ctx;
    // Spin the loading ring while the first-paint cover is up.
    if (ctx.loadingSpinner) {
      ctx.loadingAngle += dt * 4;
      ctx.loadingSpinner.rotation = ctx.loadingAngle;
    }
    // Eraser-wipe reveal of the loading cover, once hideLoading() has handed it off (loadingReveal.ts).
    if (ctx.loadingEraseLayer) updateLoadingErase(ctx, dt);
    // Once-per-second HUD countdown refresh (P1-1): march/siege remaining-time text previously only
    // advanced on the ~5s poll tick or an incoming push, sitting visibly frozen in between. This just
    // repaints the HUD from existing state — no network — so it's cheap and safe to run continuously
    // (and is the prerequisite for P1-2 removing the poll: without it, countdowns would freeze
    // entirely once nothing periodically calls renderHud()).
    ctx.hudTickTimer += dt;
    if (ctx.hudTickTimer >= 1) {
      ctx.hudTickTimer = 0;
      ctx.panels.renderHud();
    }
    if (ctx.toastTimer > 0) {
      ctx.toastTimer -= dt * 1000;
      if (ctx.toastTimer <= 0) tearDownChildren(ctx.toastLayer);
    }
    this.vignette.updateVignette(dt);
    // Protection-shield bubbles (S8-8 follow-up, 2026-08-08): re-animate every active shield's
    // dashed ring/pulse every frame instead of only on the sporadic redraws refreshCityLayer
    // gets (pan/zoom/poll) — see WorldMapContext.shieldGeom / WorldMapRenderer/shieldFx.ts.
    ctx.shieldAnimT += dt;
    if (ctx.shieldGeom.size > 0) {
      for (const [key, geom] of ctx.shieldGeom) {
        const cityC = ctx.citySprites.get(key);
        const shieldFx = cityC?.getChildByName('shieldFx') as PIXI.Graphics | undefined;
        const shieldGlowFx = cityC?.getChildByName('shieldGlowFx') as PIXI.Graphics | undefined;
        if (!shieldFx || !shieldGlowFx) { ctx.shieldGeom.delete(key); continue; }
        drawShieldDome(shieldFx, geom, ctx.shieldAnimT);
        drawShieldGlow(shieldGlowFx, geom, ctx.shieldAnimT);
      }
    }
    // One-shot "shield just broke" pop flashes (2026-08-08 follow-up) — age out and self-remove
    // past SHIELD_BREAK_LIFE; see city.ts refreshCityLayer for where these get queued.
    if (ctx.shieldBreakFx.size > 0) {
      for (const [key, fx] of ctx.shieldBreakFx) {
        fx.age += dt;
        const cityC = ctx.citySprites.get(key);
        const shieldBreakFx = cityC?.getChildByName('shieldBreakFx') as PIXI.Graphics | undefined;
        if (!shieldBreakFx || fx.age >= SHIELD_BREAK_LIFE) {
          shieldBreakFx?.clear();
          ctx.shieldBreakFx.delete(key);
          continue;
        }
        drawShieldBreakFx(shieldBreakFx, fx, fx.age);
      }
    }
    // L3 overview: flush dirty flag at most once per frame (60fps cap).
    if (ctx.l3Dirty && ctx.zoom === 3) {
      this.fog.renderMapL3();
    }
    // March tokens ride the route between poll ticks — redraw every frame while any are in
    // flight, so their position advances smoothly instead of jumping on each ~5s poll. Also
    // fires with zero live marches but leftover pooled runtimes (all marches just arrived/were
    // recalled, or the camera zoomed out to L3) so syncMarchTokens' cleanup pass actually tears
    // the orphans down — otherwise their sprites would linger forever, since nothing would ever
    // call renderOverlay again to reach that cleanup loop. renderOverlay/syncMarchTokens already
    // gate their zoom<3-only drawing internally, so no zoom check is needed here. Occupy-hold
    // tokens (syncOccupyTokens) need the same continuous redraw for their whole hold duration —
    // otherwise the 'attacking' clip would only ever advance on the ~5s occupations poll tick.
    if (
      ctx.marches.length > 0 || ctx.marchTokenRuntimes.size > 0 ||
      ctx.occupations.length > 0 || ctx.occupyTokenRuntimes.size > 0 ||
      ctx.stationed.length > 0 || ctx.stationedTokenRuntimes.size > 0
    ) {
      this.fog.renderOverlay(dt);
    }
  }

  /** Load the map atlases behind the loading cover, then reveal the map fully textured. */
  bootstrap(): void {
    const ctx = this.core.ctx;
    const atlasLoads = [
      loadTerrainAtlas().catch((err) => console.warn('[WorldMapScene] terrain atlas load failed:', err)),
      loadCityAtlas().catch((err) => console.warn('[WorldMapScene] city atlas load failed:', err)),
      loadPlayerBaseAtlas().catch((err) => console.warn('[WorldMapScene] player base atlas load failed:', err)),
      loadResAtlas().catch((err) => console.warn('[WorldMapScene] res atlas load failed:', err)),
      loadBuildingAtlas().catch((err) => console.warn('[WorldMapScene] building atlas load failed:', err)),
    ];
    Promise.allSettled(atlasLoads).then(() => {
      if (ctx.destroyed) return;
      this.refreshMap();
      this.build.hideLoading();
    });
    // Safety net: reveal anyway if an atlas hangs, so the player is never stuck on the cover.
    ctx.loadingTimeout = setTimeout(() => {
      if (!ctx.destroyed) { this.refreshMap(); this.build.hideLoading(); }
    }, 8000);
  }

  destroy(): void {
    const ctx = this.core.ctx;
    if (ctx.loadingTimeout) { clearTimeout(ctx.loadingTimeout); ctx.loadingTimeout = null; }
    cancelLoadingErase(ctx);
    if (ctx.hiddenInput) { ctx.hiddenInput.remove(); ctx.hiddenInput = null; }
    for (const s of ctx.pool) s.g.destroy();
    ctx.pool = [];
    for (const c of ctx.citySprites.values()) c.destroy({ children: true });
    ctx.citySprites.clear();
    ctx.shieldGeom.clear();
    ctx.shieldBreakFx.clear();
    for (const entry of ctx.marchTokenRuntimes.values()) destroyTokenEntry(entry);
    ctx.marchTokenRuntimes.clear();
    ctx.marchAttackUntil.clear();
    for (const entry of ctx.occupyTokenRuntimes.values()) destroyTokenEntry(entry);
    ctx.occupyTokenRuntimes.clear();
    for (const entry of ctx.stationedTokenRuntimes.values()) destroyTokenEntry(entry);
    ctx.stationedTokenRuntimes.clear();
  }
}
