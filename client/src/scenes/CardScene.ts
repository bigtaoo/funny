// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10). Thin assembly file.
//
// The scene is split by domain — each part lives in ./CardScene/*.ts and is composed here over
// CardSceneCore (./CardScene/core.ts, which owns all instance state + the layer scaffold + shared
// portrait/modal/toast primitives + input/lifecycle, but NOT the render() dispatcher — see core.ts's
// header comment). To add a handler: find the matching domain class (list / skins / detail / feed /
// actions) or add a new one — do NOT grow this file. CardCallbacks / CardActionResult are re-exported
// so existing importers (`from './CardScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain instance (Core takes a `render` callback instead of
// owning render() itself). Construction order matches the one-directional call graph (list → detail;
// detail → actions/feed; actions → feed): feed first (only depends on Core), then actions (needs
// feed for playFusionAnim), then detail (needs actions + feed), then skins (Core only), then list
// (needs detail). feed's own call into actions.doFuse is the one edge that runs the other way — it
// goes through the `core.doFuse` lazy hook (wired right below, immediately after ActionsPanel is
// constructed) instead of a direct reference, since actions.ts doesn't exist yet when feed.ts is
// constructed — see core.ts's file-header comment for why merging the two wasn't the fix here.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { tearDownChildren, drawLoadingOverlay } from '../render/sketchUi';
import { CardSceneCore } from './CardScene/core';
import type { CardCallbacks } from './CardScene/core';
import { ListPanel } from './CardScene/list';
import { SkinsPanel } from './CardScene/skins';
import { DetailPanel } from './CardScene/detail';
import { FeedPanel } from './CardScene/feed';
import { ActionsPanel } from './CardScene/actions';

export type { CardCallbacks, CardActionResult, CardRosterView, CardSceneTab } from './CardScene/core';

/**
 * CardScene — the Hero Roster scene registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class CardScene implements Scene {
  readonly container;

  private readonly core: CardSceneCore;
  private readonly feed: FeedPanel;
  private readonly actions: ActionsPanel;
  private readonly detail: DetailPanel;
  private readonly skins: SkinsPanel;
  private readonly list: ListPanel;

  constructor(layout: ILayout, input: InputManager, cb: CardCallbacks) {
    this.core = new CardSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.feed = new FeedPanel(this.core);
    this.actions = new ActionsPanel(this.core, this.feed);
    // feed.ts's fuse-confirm button needs to call ActionsPanel.doFuse, but actions.ts is constructed
    // after feed.ts (feed has no CardScene-internal deps, actions needs feed) — wire the lazy hook
    // now, immediately after the real ActionsPanel exists, before any real render/interaction.
    this.core.doFuse = (targetId, materialIds, onSettled) => this.actions.doFuse(targetId, materialIds, onSettled);
    this.detail = new DetailPanel(this.core, this.actions, this.feed);
    this.skins = new SkinsPanel(this.core);
    this.list = new ListPanel(this.core, this.detail);

    this.render();
  }

  update(dt: number): void {
    this.core.update(dt);
  }

  destroy(): void {
    this.core.destroy();
  }

  /** Re-render just the SLG-derived bits of already-visible roster cells — see CardRosterView. */
  applyCardState(): void {
    this.list.applyCardState();
  }

  private render(): void {
    const core = this.core;
    if (core.destroyed) return;
    tearDownChildren(core.bodyLayer);
    core.hitRects = [];
    tearDownChildren(core.loadingLayer);
    core.activeSpinners = [];
    core.hitRects.push({ rect: core.backRect, action: () => core.cb.onBack() });

    this.list.renderHeaderCurrency();
    this.list.renderSidebar();
    if (core.tab === 'skins') this.skins.renderSkinsTab();
    else this.list.renderList();

    if (core.fuseRingOpen) {
      // The fusion ring owns its own redraw (feedRedraw) and must not be reopened-over or closed by
      // a generic render() pass — see fuseRingOpen's doc comment (core.ts).
    } else if (core.tab === 'list' && core.detailId) {
      this.detail.openDetail(core.detailId);
    } else if (core.modalOpen) {
      core.closeModal();
    }

    if (core.bt.loadingVisible) drawLoadingOverlay(core.loadingLayer, core.w, core.h, core.bt.dots, t('common.processing'));
  }
}
