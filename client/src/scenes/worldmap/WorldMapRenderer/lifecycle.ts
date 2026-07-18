// Scene lifecycle: per-frame update (loading spinner, toast timer, L3 flush, train-panel tick),
// atlas bootstrap behind the loading cover, and teardown of pooled Graphics / city sprites.
import { loadResAtlas } from '../../../render/resAtlasLoader';
import { loadCityAtlas } from '../../../render/cityAtlasLoader';
import { loadPlayerBaseAtlas } from '../../../render/playerBaseAtlasLoader';
import { loadTerrainAtlas } from '../../../render/terrainAtlasLoader';
import { loadBuildingAtlas } from '../../../render/buildingAtlasLoader';
import { tearDownChildren } from '../../../render/sketchUi';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface LifecycleHandlers {
  update(dt: number): void;
  bootstrap(): void;
  destroy(): void;
}

export function LifecycleMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<LifecycleHandlers> {
  return class extends Base {
    update(dt: number): void {
      // Spin the loading ring while the first-paint cover is up.
      if (this.ctx.loadingSpinner) {
        this.ctx.loadingAngle += dt * 4;
        this.ctx.loadingSpinner.rotation = this.ctx.loadingAngle;
      }
      if (this.ctx.toastTimer > 0) {
        this.ctx.toastTimer -= dt * 1000;
        if (this.ctx.toastTimer <= 0) tearDownChildren(this.ctx.toastLayer);
      }
      this.updateVignette(dt);
      // L3 overview: flush dirty flag at most once per frame (60fps cap).
      if (this.ctx.l3Dirty && this.ctx.zoom === 3) {
        this.renderMapL3();
      }
      // Tick the train panel's queue countdowns once per second while open.
      if (this.ctx.trainPanelOpen) {
        this.ctx.panelRepaint += dt;
        if (this.ctx.panelRepaint >= 1) {
          this.ctx.panelRepaint = 0;
          this.ctx.panels.renderTrainPanel();
        }
      }
      // March tokens ride the route between poll ticks — redraw every frame while any are in
      // flight, so their position advances smoothly instead of jumping on each ~5s poll. Also
      // fires with zero live marches but leftover pooled runtimes (all marches just arrived/were
      // recalled, or the camera zoomed out to L3) so syncMarchTokens' cleanup pass actually tears
      // the orphans down — otherwise their sprites would linger forever, since nothing would ever
      // call renderOverlay again to reach that cleanup loop. renderOverlay/syncMarchTokens already
      // gate their zoom<3-only drawing internally, so no zoom check is needed here.
      if (this.ctx.marches.length > 0 || this.ctx.marchTokenRuntimes.size > 0) {
        this.renderOverlay(dt);
      }
    }

    /** Load the map atlases behind the loading cover, then reveal the map fully textured. */
    bootstrap(): void {
      const atlasLoads = [
        loadTerrainAtlas().catch((err) => console.warn('[WorldMapScene] terrain atlas load failed:', err)),
        loadCityAtlas().catch((err) => console.warn('[WorldMapScene] city atlas load failed:', err)),
        loadPlayerBaseAtlas().catch((err) => console.warn('[WorldMapScene] player base atlas load failed:', err)),
        loadResAtlas().catch((err) => console.warn('[WorldMapScene] res atlas load failed:', err)),
        loadBuildingAtlas().catch((err) => console.warn('[WorldMapScene] building atlas load failed:', err)),
      ];
      Promise.allSettled(atlasLoads).then(() => {
        if (this.ctx.destroyed) return;
        this.renderMap();
        this.hideLoading();
      });
      // Safety net: reveal anyway if an atlas hangs, so the player is never stuck on the cover.
      this.ctx.loadingTimeout = setTimeout(() => {
        if (!this.ctx.destroyed) { this.renderMap(); this.hideLoading(); }
      }, 8000);
    }

    destroy(): void {
      if (this.ctx.loadingTimeout) { clearTimeout(this.ctx.loadingTimeout); this.ctx.loadingTimeout = null; }
      if (this.ctx.hiddenInput) { this.ctx.hiddenInput.remove(); this.ctx.hiddenInput = null; }
      for (const s of this.ctx.pool) s.g.destroy();
      this.ctx.pool = [];
      for (const c of this.ctx.citySprites.values()) c.destroy({ children: true });
      this.ctx.citySprites.clear();
      for (const { runtime } of this.ctx.marchTokenRuntimes.values()) runtime?.destroy();
      this.ctx.marchTokenRuntimes.clear();
      this.ctx.marchAttackUntil.clear();
    }
  };
}
