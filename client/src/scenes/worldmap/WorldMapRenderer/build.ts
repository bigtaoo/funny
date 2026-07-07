// Scene scaffold + first-paint loading cover: builds the layer stack (bg / map clip / L3 / pool /
// city / fog / overlay / HUD / back / modal / toast) and the opaque loading sheet that hides the
// half-built map until the atlases settle.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { buildPaperBackground } from '../../../render/sketchUi';
import { drawFloatingBackButton } from '../../../ui/widgets/SceneHeader';
import { HUD_H } from '../constants';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';

export interface BuildHandlers {
  build(): void;
  buildLoadingOverlay(): void;
  hideLoading(): void;
}

export function BuildMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<BuildHandlers> {
  return class extends Base {
    build(): void {
      const { w, h } = this.ctx;

      // Paper background
      const bg = buildPaperBackground('worldmap', w, h, { marginLine: false });
      this.ctx.container.addChild(bg);

      // Map area (clip to above-HUD area)
      const mapClip = new PIXI.Container();
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff).drawRect(0, 0, w, h - HUD_H).endFill();
      mapClip.mask = mask;
      mapClip.addChild(mask);
      this.ctx.container.addChild(mapClip);

      // L3 overview graphics (underneath pool)
      this.ctx.mapGfxL3 = new PIXI.Graphics();
      mapClip.addChild(this.ctx.mapGfxL3);

      // Tile pool container (L1/L2)
      this.ctx.poolContainer = new PIXI.Container();
      mapClip.addChild(this.ctx.poolContainer);

      // City building sprites (above tiles, below overlay). sortableChildren + zIndex
      // (set per-sprite in refreshCityLayer) gives isometric-correct back-to-front draw order.
      this.ctx.cityLayer = new PIXI.Container();
      this.ctx.cityLayer.sortableChildren = true;
      mapClip.addChild(this.ctx.cityLayer);

      // Off-map cloud veil (above tiles/cities, below the interactive overlay so march
      // arrows / capital stars / selection — all on-map — always read on top).
      this.ctx.fogGfx = new PIXI.Graphics();
      mapClip.addChild(this.ctx.fogGfx);

      // Overlay: capitals, march arrows, selected tile highlight
      this.ctx.overlayGfx = new PIXI.Graphics();
      mapClip.addChild(this.ctx.overlayGfx);

      // HUD bar
      this.ctx.hudLayer = new PIXI.Container();
      this.ctx.container.addChild(this.ctx.hudLayer);

      // Top-left back button — static, on its own layer above the map/HUD.
      this.ctx.topLayer = new PIXI.Container();
      this.ctx.container.addChild(this.ctx.topLayer);
      this.ctx.backRect = drawFloatingBackButton(this.ctx.topLayer, h).backRect;

      this.ctx.modalLayer = new PIXI.Container();
      this.ctx.container.addChild(this.ctx.modalLayer);

      this.ctx.toastLayer = new PIXI.Container();
      this.ctx.container.addChild(this.ctx.toastLayer);

      // Loading cover — top-most so the half-built / untextured map never peeks through.
      this.buildLoadingOverlay();

      this.buildPool();
      this.ctx.panels.renderHud();
      this.invalidatePool();
    }

    /**
     * The first-paint loading cover: an opaque notebook-paper sheet + a hand-drawn
     * spinning ink ring + localized "loading map…" caption. Hidden by hideLoading()
     * once the map atlases have settled (see constructor). Sized to the full scene so
     * nothing underneath — flat color tiles, fog, half-loaded city sprites — shows.
     */
    buildLoadingOverlay(): void {
      const { w, h } = this.ctx;
      const layer = new PIXI.Container();

      const sheet = buildPaperBackground('worldmap-loading', w, h, { marginLine: false });
      layer.addChild(sheet);

      const cx = w / 2;
      const cy = (h - HUD_H) / 2;

      // Broken ink ring (open arc) — rotated each frame in update() while active.
      const spinner = new PIXI.Graphics();
      spinner.lineStyle(3, 0x3a3a3a, 0.9);
      spinner.arc(0, 0, 22, -Math.PI * 0.15, Math.PI * 1.25);
      spinner.position.set(cx, cy);
      layer.addChild(spinner);

      const label = new PIXI.Text(t('world.loading'), {
        fontFamily: 'sans-serif', fontSize: 18, fill: 0x3a3a3a,
      });
      label.anchor.set(0.5);
      label.position.set(cx, cy + 50);
      layer.addChild(label);

      this.ctx.container.addChild(layer);
      this.ctx.loadingLayer = layer;
      this.ctx.loadingSpinner = spinner;
    }

    /** Remove the first-paint loading cover (idempotent); clears the safety timeout. */
    hideLoading(): void {
      if (this.ctx.loadingTimeout) { clearTimeout(this.ctx.loadingTimeout); this.ctx.loadingTimeout = null; }
      if (this.ctx.loadingLayer) {
        this.ctx.loadingLayer.destroy({ children: true });
        this.ctx.loadingLayer = null;
        this.ctx.loadingSpinner = null;
      }
    }
  };
}
