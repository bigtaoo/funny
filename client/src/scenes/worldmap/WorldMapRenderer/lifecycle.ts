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
import { overlayInkSignature } from './fog';

/**
 * Redraw rate for the capital-protection shield bubbles (dashed dome + glow pulse). Deliberately
 * far below frame rate: each step rebuilds two `Graphics` per shielded city, and nothing in the
 * animation is fast enough for the difference to be visible.
 */
const SHIELD_ANIM_FPS = 10;
import { t } from '../../../i18n';
import { tileToScreen, ISO_RATIO } from '../../../render/isoGrid';
import { BASE_FOOTPRINT, citySpriteTiles, cityGroundFwdPx } from '@nw/shared';
import { BASE_SPRITE_TILES } from '../logic/constants';
import type { WorldMapRendererCore } from './core';
import type { WorldMapRendererFog } from './fog';
import type { WorldMapRendererVignette } from './vignette';
import type { WorldMapRendererBuild } from './build';
import { markFeatureUsed } from '../../../assets/prefetchPolicy';
import { decorationsQuiet } from '../../../render/idleQuiet';

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
    // advanced only on a viewport refetch or an incoming push, sitting visibly frozen in between. This just
    // repaints the HUD from existing state — no network — so it's cheap and safe to run continuously
    // (and is the prerequisite for P1-2 removing the poll: without it, countdowns would freeze
    // entirely once nothing periodically calls renderHud()).
    ctx.hudTickTimer += dt;
    if (ctx.hudTickTimer >= 1) {
      ctx.hudTickTimer = 0;
      ctx.panels.renderHud();
    }
    // Busy cover for an in-flight mutating request (ctx.bt) — same `if (bt.tick(dt)) render()`
    // contract every other scene's update() uses; here it repaints only its own layer.
    if (ctx.bt.tick(dt)) ctx.panels.renderBusyOverlay();
    if (ctx.toastTimer > 0) {
      ctx.toastTimer -= dt * 1000;
      if (ctx.toastTimer <= 0) tearDownChildren(ctx.toastLayer);
    }
    this.vignette.updateVignette(dt);
    this.updateGuide(dt);
    // Protection-shield bubbles (S8-8 follow-up, 2026-08-08): re-animate every active shield's
    // dashed ring/pulse every frame instead of only on the sporadic redraws refreshCityLayer
    // gets (pan/zoom/poll) — see WorldMapContext.shieldGeom / WorldMapRenderer/shieldFx.ts.
    ctx.shieldAnimT += dt;
    // ...but at SHIELD_ANIM_FPS, not at frame rate. Each shield redraw is two full `Graphics`
    // rebuilds (a dashed dome ring + a glow), and a slow dash crawl plus a pulse is indistinguishable
    // stepped 10 times a second from stepped 60 — the same "hand-drawn does not need to be smooth"
    // call art-direction §5.4 makes for everything else here.
    ctx.shieldAnimAcc += dt;
    // ...and not at all once nobody has touched the map for a while: the bubble is ambience, and a
    // held one stops re-arming the render loop's idle throttle (render/idleQuiet.ts). The break-pop
    // flashes below are NOT gated — those are one-shot reactions to something that just happened.
    const shieldStep = ctx.shieldAnimAcc >= 1 / SHIELD_ANIM_FPS && !decorationsQuiet();
    if (shieldStep) ctx.shieldAnimAcc = 0;
    if (shieldStep && ctx.shieldGeom.size > 0) {
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
    // Overlay ink: repaint only when its inputs actually changed (fog.ts's renderOverlayInk explains
    // what it draws, and why repainting it every frame was the SLG map's stutter). The signature is
    // derived from camera + server state rather than announced by the ~15 sites that write it;
    // `overlayInkDirty` stays as the explicit "repaint regardless" channel for the rest.
    if (ctx.overlayInkDirty || overlayInkSignature(ctx) !== ctx.overlayInkSig) {
      this.fog.renderOverlayInk();
    }
    // Tokens, on the other hand, DO move every frame: a march rides its route between the server
    // ticks instead of jumping on each one, and an occupy hold plays its 'attacking' clip
    // throughout. This is sprite transforms and clip playback only — no Graphics rebuild.
    //
    // Also runs with zero live entries but leftover pooled runtimes (all marches just arrived/were
    // recalled, or the camera zoomed out to L3) so the sync passes' cleanup actually tears the
    // orphans down — otherwise their sprites would linger forever, since nothing else would reach
    // that loop. The sync passes gate their own zoom<3-only drawing internally, so no zoom check
    // is needed here.
    if (
      ctx.marches.length > 0 || ctx.marchTokenRuntimes.size > 0 ||
      ctx.occupations.length > 0 || ctx.occupyTokenRuntimes.size > 0 ||
      ctx.stationed.length > 0 || ctx.stationedTokenRuntimes.size > 0
    ) {
      this.fog.syncTokens(dt);
    }
  }

  /**
   * SLG opening guide chain (ONBOARDING_DESIGN §4.2): step1 highlights the player's own main city
   * until tapped (WorldMapInput.onTileClick sets ctx.guideStep back to null on hit); step4 is a
   * target-less closing tip shown once back from the city, after step3 (CityScene's own "return"
   * highlight) has completed. Both are just derived from current flags/state every frame — cheap
   * (one tileToScreen call + a Graphics redraw), and naturally re-decided on every call, so there is
   * no separate "clear it" bookkeeping to get wrong.
   */
  private updateGuide(dt: number): void {
    const ctx = this.core.ctx;
    if (!ctx.guide) return; // only assigned by WorldMapRendererBuild.build() — some UI tests skip it
    const viewport = { w: ctx.w, h: ctx.h };
    ctx.guide.update(dt);
    if (ctx.guideStep === 'step1' && ctx.me?.mainBaseTile) {
      const parsed = ctx.parseTileStrict(ctx.me.mainBaseTile);
      if (parsed) {
        const [bx, by] = parsed;
        const size = citySpriteTiles(BASE_FOOTPRINT, BASE_SPRITE_TILES) * ctx.tp;
        const s = tileToScreen(bx, by, ctx.tp);
        const groundY = ctx.panY + s.y + cityGroundFwdPx(BASE_FOOTPRINT, ctx.tp, ISO_RATIO);
        const cx = ctx.panX + s.x;
        ctx.guide.showAt(
          { x: cx - size / 2, y: groundY - size, w: size, h: size },
          t('guide.world.step1.body'),
          viewport,
          { onSkip: () => { ctx.cb.setFlag?.('guide.world.step1', true); ctx.guideStep = null; } },
        );
      }
      return;
    }
    if ((ctx.cb.getFlag?.('guide.world.step3') ?? false) && !(ctx.cb.getFlag?.('guide.world.step4') ?? false)) {
      ctx.guide.showCard(
        t('guide.world.step4.body'), t('guide.gotIt'),
        () => ctx.cb.setFlag?.('guide.world.step4', true),
        viewport,
      );
      return;
    }
    ctx.guide.hide();
  }

  /** Load the map atlases behind the loading cover, then reveal the map fully textured. */
  bootstrap(): void {
    const ctx = this.core.ctx;
    // This is the SLG map's own asset-demand site, so it is where "this player uses the world map"
    // is true — next session `idlePrefetch` will warm the 2.0 MB / ~13.7 MB-decoded world atlas
    // ahead of this cover instead of behind it (ASSET_PACKAGING §14). Marked here rather than in
    // the loaders below because the prefetch calls those same loaders, which would make the wave
    // self-justifying after a single run.
    markFeatureUsed('world');
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
    if (ctx.hiddenInput) { ctx.hiddenInput.close(); ctx.hiddenInput = null; }
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
