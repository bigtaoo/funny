// Scene scaffold + first-paint loading cover: builds the layer stack (bg / map clip / L3 / pool /
// city / fog / overlay / HUD / back / modal / toast) and the opaque loading sheet that hides the
// half-built map until the atlases settle.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { buildPaperBackground } from '../../../render/sketchUi';
import { makeText } from '../../../render/pixiText';
import { FS } from '../../../render/fontScale';
import { drawSceneHeader, HEADER_ACCENT } from '../../../ui/widgets/SceneHeader';
import { GuideOverlay } from '../../../render/GuideOverlay';
import { HUD_H } from '../logic/constants';
import { beginLoadingErase } from './loadingReveal';
import type { WorldMapRendererCore } from './core';
import type { WorldMapRendererPool } from './pool';

export interface BuildHandlers {
  build(): void;
  buildLoadingOverlay(): void;
  hideLoading(): void;
}

export class WorldMapRendererBuild implements BuildHandlers {
  constructor(
    private readonly core: WorldMapRendererCore,
    private readonly pool: WorldMapRendererPool,
    /** Full pool+city+overlay refresh (WorldMapRenderer.invalidatePool()) — build() needs it as
     *  its very last step, same as the pre-conversion `this.invalidatePool()` mixin call did. */
    private readonly refreshMap: () => void,
  ) {}

  build(): void {
    const ctx = this.core.ctx;
    const { w, h } = ctx;

    // Paper background
    const bg = buildPaperBackground('worldmap', w, h, { marginLine: false });
    ctx.container.addChild(bg);

    // Top-left back button + bar chrome — same SceneHeader every other scene uses, so the
    // title-row height reads consistently app-wide. No title text: the bar instead shows
    // live per-resource production (see renderHeaderHud) with the auction button pinned to
    // its far right. Drawn before the map so topInset is known when the map mask/loading
    // overlay below are sized.
    ctx.topLayer = new PIXI.Container();
    const hdr = drawSceneHeader(ctx.topLayer, w, h, null, { accent: HEADER_ACCENT.slg });
    ctx.backRect = hdr.backRect;
    ctx.headerBarH = hdr.headerH;
    // Portrait can't fit back button + three entry buttons + a five-resource readout on one row:
    // design width is pinned at 1080 while `sceneHeaderHeight` (and every size derived from it)
    // grows with the stretchy height axis, so on a tall phone the row overflowed itself — the
    // buttons landed on top of the back button and the readout ran past the right edge. Portrait
    // gets the readout on its own strip under the bar instead (renderHeaderHud draws it there and
    // switches the entry buttons to icon-only); landscape is unchanged, strip height 0.
    ctx.resStripH = h > w ? Math.round(hdr.headerH * 0.46) : 0;
    ctx.topInset = ctx.headerBarH + ctx.resStripH;

    // Map area (clip to the band between the header and the bottom chat HUD)
    const mapClip = new PIXI.Container();
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, ctx.topInset, w, h - HUD_H - ctx.topInset).endFill();
    mapClip.mask = mask;
    mapClip.addChild(mask);
    ctx.container.addChild(mapClip);

    // L3 overview graphics (underneath pool)
    ctx.mapGfxL3 = new PIXI.Graphics();
    mapClip.addChild(ctx.mapGfxL3);

    // Tile pool container (L1/L2)
    ctx.poolContainer = new PIXI.Container();
    mapClip.addChild(ctx.poolContainer);

    // City building sprites (above tiles, below overlay). sortableChildren + zIndex
    // (set per-sprite in refreshCityLayer) gives isometric-correct back-to-front draw order.
    ctx.cityLayer = new PIXI.Container();
    ctx.cityLayer.sortableChildren = true;
    mapClip.addChild(ctx.cityLayer);

    // Off-map cloud veil (above tiles/cities, below the interactive overlay so march
    // arrows / capital stars / selection — all on-map — always read on top).
    ctx.fogGfx = new PIXI.Graphics();
    mapClip.addChild(ctx.fogGfx);

    // Overlay: capitals, march arrows, selected tile highlight
    ctx.overlayGfx = new PIXI.Graphics();
    mapClip.addChild(ctx.overlayGfx);

    // March walk-cycle sprites (StickmanRuntime containers), above the route line/arrowhead.
    ctx.marchTokenLayer = new PIXI.Container();
    mapClip.addChild(ctx.marchTokenLayer);

    // HUD bar
    ctx.hudLayer = new PIXI.Container();
    ctx.container.addChild(ctx.hudLayer);

    // Header bar (built above, before the map) sits above the map/HUD layers.
    ctx.container.addChild(ctx.topLayer);

    // Production readout + auction button drawn on top of the header chrome; rebuilt
    // alongside hudLayer (renderHud) so production stays live, but layered after topLayer
    // so the header's paper fill doesn't hide it.
    ctx.headerHudLayer = new PIXI.Container();
    ctx.container.addChild(ctx.headerHudLayer);

    ctx.modalLayer = new PIXI.Container();
    ctx.container.addChild(ctx.modalLayer);

    ctx.toastLayer = new PIXI.Container();
    ctx.container.addChild(ctx.toastLayer);

    // Base-damage vignette (D-CITY-8) — screen-edge red flash, above every other layer
    // (including HUD/modals) so a siege hit reads even while a panel is open.
    ctx.vignetteGfx = new PIXI.Graphics();
    ctx.container.addChild(ctx.vignetteGfx);

    // SLG opening guide chain (ONBOARDING_DESIGN §4.2) — topmost persistent layer, above HUD/modals
    // too, so its highlight ring/bubble always reads on top; mounted once here (never touched by
    // refreshPool/refreshCityLayer/renderHud, all of which tear down other layers, not this one).
    ctx.guide = new GuideOverlay();
    ctx.container.addChild(ctx.guide.root);

    // Loading cover — top-most so the half-built / untextured map never peeks through.
    this.buildLoadingOverlay();

    this.pool.buildPool();
    ctx.panels.renderHud();
    this.refreshMap();
  }

  /**
   * The first-paint loading cover: an opaque notebook-paper sheet + a hand-drawn
   * spinning ink ring + localized "loading map…" caption. Hidden by hideLoading()
   * once the map atlases have settled (see constructor). Sized to the full scene so
   * nothing underneath — flat color tiles, fog, half-loaded city sprites — shows.
   */
  buildLoadingOverlay(): void {
    const ctx = this.core.ctx;
    const { w, h } = ctx;
    const layer = new PIXI.Container();

    const sheet = buildPaperBackground('worldmap-loading', w, h, { marginLine: false });
    layer.addChild(sheet);

    const cx = w / 2;
    const cy = (ctx.topInset + h - HUD_H) / 2;

    // Broken ink ring (open arc) — rotated each frame in update() while active.
    const spinner = new PIXI.Graphics();
    spinner.lineStyle(3, 0x3a3a3a, 0.9);
    spinner.arc(0, 0, 22, -Math.PI * 0.15, Math.PI * 1.25);
    spinner.position.set(cx, cy);
    layer.addChild(spinner);

    const label = makeText(t('world.loading'), {
      fontFamily: 'sans-serif', fontSize: FS.body, fill: 0x3a3a3a,
    });
    label.anchor.set(0.5);
    label.position.set(cx, cy + 50);
    layer.addChild(label);

    ctx.container.addChild(layer);
    ctx.loadingLayer = layer;
    ctx.loadingSpinner = spinner;
  }

  /** Reveal the map: clears the safety timeout and hands the first-paint loading cover off to its
   *  eraser-wipe reveal (loadingReveal.ts) instead of popping it away outright. Idempotent — see
   *  beginLoadingErase's doc comment. */
  hideLoading(): void {
    const ctx = this.core.ctx;
    if (ctx.loadingTimeout) { clearTimeout(ctx.loadingTimeout); ctx.loadingTimeout = null; }
    beginLoadingErase(ctx);
  }
}
