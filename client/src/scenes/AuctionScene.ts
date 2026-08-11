// AuctionScene — SLG auction scene (S8-5). Thin assembly file.
//
// The scene is split by domain — each part lives in ./AuctionScene/*.ts and is composed here over
// AuctionSceneCore (./AuctionScene/core.ts, which owns all instance state + data loading + shared
// modal/toast primitives + pointer-input/lifecycle, but NOT the render() dispatcher — see core.ts's
// header comment). To add a handler: find the matching domain class (list / bid / trade actions /
// create-listing) or add a new one — do NOT grow this file. AuctionSceneCallbacks is re-exported so
// existing importers (`from './AuctionScene'`) keep resolving to this file, not the directory.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain instance (Core takes a `render` callback instead of
// owning render() itself, mirroring SectScene); the initial loadData() call also moves here, since
// loadData's first synchronous line calls `core.render()`, which needs every domain instance to exist.
// The item-picker overlay (cancelItemPicker/renderItemPicker) is plain functions in
// itemPickerRender.ts, not a domain instance — called directly with `core`.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { tearDownChildren } from '../render/sketchUi';
import { AuctionSceneCore } from './AuctionScene/core';
import type { AuctionSceneCallbacks } from './AuctionScene/core';
import { BidPanel } from './AuctionScene/bid';
import { TradeActionsPanel } from './AuctionScene/tradeActions';
import { CreateListingPanel } from './AuctionScene/createListing';
import { ListPanel } from './AuctionScene/list';
import { cancelItemPicker, renderItemPicker } from './AuctionScene/itemPickerRender';

export type { AuctionSceneCallbacks } from './AuctionScene/core';

/**
 * AuctionScene — the SLG auction scene registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class AuctionScene implements Scene {
  readonly container;

  private readonly core: AuctionSceneCore;
  private readonly bid: BidPanel;
  private readonly trade: TradeActionsPanel;
  private readonly createListing: CreateListingPanel;
  private readonly list: ListPanel;

  constructor(layout: ILayout, input: InputManager, cb: AuctionSceneCallbacks) {
    this.core = new AuctionSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;
    this.bid = new BidPanel(this.core);
    this.trade = new TradeActionsPanel(this.core);
    this.createListing = new CreateListingPanel(this.core);
    this.list = new ListPanel(this.core, this.bid, this.trade, this.createListing);

    // ensureRefBand's async fetch callback and update()'s caret-blink tick need to rebuild the
    // create-form modal in place — wire the lazy hook now that CreateListingPanel exists, before the
    // first real render (see core.ts's file-header comment).
    this.core.reopenCreateForm = () => this.createListing.openCreateForm();

    void this.core.loadData();
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
    tearDownChildren(core.bodyLayer);
    // Keep static header; only rebuild body hits (not back button)
    core.hitRects = [];
    core.renderHeaderCurrency();

    // Item picker overlay: back button cancels the picker and returns to the create form.
    if (core.itemPickerOpen) {
      core.hitRects.push({ rect: core.backRect, action: () => cancelItemPicker(core) });
      renderItemPicker(core);
      return;
    }

    core.hitRects.push({ rect: core.backRect, action: () => core.cb.onBack() });

    const contentX = this.list.renderSidebar();
    const filterH = core.activeTab === 'all' ? this.list.renderFilterBar(contentX) : 0;
    const listData = core.activeTab === 'all' ? core.allAuctions : core.activeTab === 'mine' ? core.myListings : this.list.myBids();
    this.list.renderList(listData, contentX, filterH);
    this.list.renderCreateButton(contentX);
  }
}
