// GachaScene (S2-6) — single / ten-pull lootbox with pity + reveal. Thin assembly file.
//
// The scene is split by domain — each part lives in ./GachaScene/*.ts as an independent class
// constructed with the shared `GachaSceneCore` (./GachaScene/core.ts, which owns all instance
// state, the constructor, the Scene lifecycle, the draw/redeem actions, input handling, and the
// shared helpers — but NOT the render() dispatcher, which lives here since only this assembly
// knows about every domain class). The legendary border-trail math is not a domain class at all:
// it is stateless geometry/colour used by both reveal.ts and core's update() loop, so it lives in
// ./GachaScene/trail.ts. To add a renderer: find the matching domain class (page / reveal / odds)
// or add a new one — do NOT grow the domain logic into this file, only its one-line dispatch call.
// GachaSceneCallbacks and the draw-result types are re-exported so existing importers
// (`from './GachaScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher used to live on
// GachaSceneBase and reach the domain mixins' draw methods via interface declaration merging
// (an "upward" call from base into a sibling); now Core takes a `render` callback injected from
// this assembly instead, so it never has to call sideways/upward into a domain class.
import type * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { preloadGachaTextures } from '../render/gachaArt';
import { GachaSceneCore } from './GachaScene/core';
import type { GachaSceneCallbacks } from './GachaScene/core';
import { PagePanel } from './GachaScene/page';
import { RevealPanel } from './GachaScene/reveal';
import { OddsPanel } from './GachaScene/odds';

export type { GachaSceneCallbacks, GachaDrawResult, FateRedeemResult } from './GachaScene/core';

/**
 * GachaScene — the lootbox scene registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class GachaScene implements Scene {
  readonly container: PIXI.Container;

  private readonly core: GachaSceneCore;
  private readonly page: PagePanel;
  private readonly reveal: RevealPanel;
  private readonly odds: OddsPanel;

  constructor(layout: ILayout, input: InputManager, cb: GachaSceneCallbacks) {
    this.core = new GachaSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.odds = new OddsPanel(this.core);
    this.reveal = new RevealPanel(this.core, this.odds);
    this.page = new PagePanel(this.core);

    this.render();
    void this.core.loadPools();
    void preloadGachaTextures();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  private render(): void {
    const core = this.core;
    if (core.destroyed) return;
    tearDownChildren(core.container);
    core.hits = [];
    core.revealFx = []; // torn down with the container above; repopulated by drawResultCard for legendary cards

    core.drawBackground();
    const tbH = this.page.drawHeader();
    // Landscape draws the rail first (disjoint region from the body, order doesn't matter). Portrait's
    // bottom bar is drawn AFTER the body so it always paints on top of a tall/unbounded body layout —
    // drawSidebar unshifts its own hits in that branch so hit-testing still resolves to the nav bar
    // first, matching the visual stacking, in case of an accidental rect overlap.
    if (core.landscape) this.page.drawSidebar(tbH);
    this.page.drawBody(tbH);
    if (!core.landscape) this.page.drawSidebar(tbH);
    if (core.reveal) this.reveal.drawReveal(core.reveal);
    if (core.oddsOpen && core.pool) this.odds.drawOdds(core.pool);
    if (core.bt.loadingVisible) drawLoadingOverlay(core.container, core.w, core.h, core.bt.dots, t('common.processing'));
  }
}
