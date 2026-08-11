// ShopScene (S2-6 + B-PROMO) — direct-purchase shop. Thin assembly file.
//
// The scene is split by domain — each part lives in ./ShopScene/*.ts and is composed here over
// ShopSceneCore (./ShopScene/core.ts, which owns all instance state + the constructor + the shared
// card/button/toast primitives + hidden-input + input/lifecycle, but NOT the render() dispatcher —
// see core.ts's header comment). To add a handler: find the matching domain class (shop / coins /
// actions) or add a new one — do NOT grow this file. ShopSceneCallbacks / ShopActionResult are
// re-exported so existing importers (`from './ShopScene'`) keep resolving to this file, not the
// directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about both tab-domain classes (Core takes a `render` callback instead of
// owning render() itself).
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { tearDownChildren, drawLoadingOverlay } from '../render/sketchUi';
import { ShopSceneCore } from './ShopScene/core';
import type { ShopSceneCallbacks } from './ShopScene/core';
import { ShopPanel } from './ShopScene/shop';
import { CoinsPanel } from './ShopScene/coins';
import { ActionsPanel } from './ShopScene/actions';

export type { ShopSceneCallbacks, ShopActionResult } from './ShopScene/core';

/**
 * ShopScene — the direct-purchase shop registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class ShopScene implements Scene {
  readonly container;

  private readonly core: ShopSceneCore;
  private readonly actions: ActionsPanel;
  private readonly shop: ShopPanel;
  private readonly coins: CoinsPanel;

  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks) {
    this.core = new ShopSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.actions = new ActionsPanel(this.core);
    this.shop = new ShopPanel(this.core, this.actions);
    this.coins = new CoinsPanel(this.core, this.actions);

    // Enter-to-redeem shortcut on the hidden promo-code input: wired here (not in Core's
    // setupHiddenInput) since it needs ActionsPanel.onRedeem(), which doesn't exist until now.
    this.core.hiddenInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.actions.onRedeem(); }
    });

    this.render();
    void this.actions.loadItems();
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
    tearDownChildren(core.container); // free Text textures on each rebuild
    core.hits = [];

    core.drawBackground();
    const tbH = core.drawHeader();
    const top = core.drawGroupTabs(tbH);

    // Body grid lives in a masked layer so overscrolled cells never bleed into the fixed header / tab strip.
    // Mask height is set per-tab (see viewH below) so a partial next row always peeks above the fold.
    const body = new PIXI.Container();
    core.container.addChild(body);
    const mask = new PIXI.Graphics();
    core.container.addChild(mask);
    body.mask = mask;
    core.bodyMask = mask;

    if (core.tab === 'coins') {
      this.coins.drawCoinsGrid(body, top);
    } else {
      this.shop.drawShopGrid(body, top);
    }

    if (core.bt.loadingVisible) drawLoadingOverlay(core.container, core.w, core.h, core.bt.dots, t('common.processing'));
  }
}
