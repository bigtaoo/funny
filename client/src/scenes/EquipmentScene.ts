// EquipmentScene — Equipment system client UI (E5, EQUIPMENT_DESIGN §11). Thin assembly file.
//
// The scene is split by domain — each part lives in ./EquipmentScene/*.ts and is composed here over
// EquipmentSceneCore (./EquipmentScene/core.ts, which owns all instance state + the layer scaffold +
// shared cost/rarity/glyph helpers + input/lifecycle, but NOT the render() dispatcher — see core.ts's
// header comment). To add a handler: find the matching domain class (inventory / craft / detail /
// assign / reforge) or add a new one — do NOT grow this file. EquipmentCallbacks / EquipResult /
// EnhanceResult are re-exported so existing importers (`from './EquipmentScene'`) keep resolving here.
//
// 2026-08-11: converted from the former `XMixin(Base)` inheritance chain to composition — see
// claudedocs/client-modules.md's split-form priority note. The render dispatcher lives here since
// only this assembly knows about every domain instance (Core takes a `render` callback instead of
// owning render() itself). Construction order matches the two bidirectional call-graph pairs found
// during the conversion (see core.ts's file-header comment for the full reasoning): reforge and
// assign first (each depends only on core), then detail (needs assign + reforge directly), then
// inventory (needs detail directly), then craft (depends only on core, any position). Two lazy hooks
// on Core are wired immediately after their real target is constructed — `cancelAssignHook` right
// after AssignPanel, `doEquipHook` right after DetailPanel, `refreshInstanceCellHook` right after
// InventoryPanel — same "default no-op field, overwritten right after the real sibling exists"
// pattern as CardScene's `doFuse`/AuctionScene's `reopenCreateForm`.
//
// Server-authoritative (L2): material/coin deduction, enhance dice rolls, and inventory state all
// live on the server. This scene only sends intent and reads receipts; cost/success-rate previews
// are mirrored from equipmentDefs, and the true result uses the server-pushed SaveData as the source
// of truth.
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { tearDownChildren, drawLoadingOverlay } from '../render/sketchUi';
import { preloadIconArt } from '../render/icons';
import { drawHubTabs, hubTabsHeight, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import { EquipmentSceneCore } from './EquipmentScene/core';
import { renderHeaderCurrency, renderMaterialsBand } from './EquipmentScene/headerRow';
import type { EquipmentCallbacks, EquipTab } from './EquipmentScene/core';
import { EQUIP_SUBTABS } from './EquipmentScene/types';
import { FILTER_H, MAT_BAND_H, TAB_LOADOUT_GAP } from './EquipmentScene/layout';
import { InventoryPanel } from './EquipmentScene/inventory';
import { CraftPanel } from './EquipmentScene/craft';
import { DetailPanel } from './EquipmentScene/detail';
import { AssignPanel } from './EquipmentScene/assign';
import { ReforgePanel } from './EquipmentScene/reforge';

export type { EquipmentCallbacks, EquipResult, EnhanceResult } from './EquipmentScene/core';

/**
 * EquipmentScene — the equipment hub scene registered against SceneManager, thin assembly over the
 * per-domain composition (see the file-header comment above).
 */
export class EquipmentScene implements Scene {
  readonly container;

  private readonly core: EquipmentSceneCore;
  private readonly reforge: ReforgePanel;
  private readonly assign: AssignPanel;
  private readonly detail: DetailPanel;
  private readonly inventory: InventoryPanel;
  private readonly craft: CraftPanel;

  constructor(layout: ILayout, input: InputManager, cb: EquipmentCallbacks) {
    this.core = new EquipmentSceneCore(layout, input, cb, () => this.render());
    this.container = this.core.container;

    this.reforge = new ReforgePanel(this.core);
    this.assign = new AssignPanel(this.core);
    // backAction() (fired from the header Back button, wired at Core-construction time before
    // AssignPanel exists) needs to cancel the card picker while in assign mode — wire the lazy hook
    // now, immediately after the real AssignPanel exists, before any real render/interaction.
    this.core.cancelAssignHook = () => this.assign.cancelAssign();
    this.detail = new DetailPanel(this.core, this.assign, this.reforge);
    // assign.ts's card-picker tap needs to call detail.ts's doEquip, but detail.ts is constructed
    // after assign.ts (detail needs `assign` for beginAssign/ownerCardId) — wire the lazy hook now.
    this.core.doEquipHook = (slot, instanceId, cardId) => this.detail.doEquip(slot, instanceId, cardId);
    this.inventory = new InventoryPanel(this.core, this.detail);
    // detail.ts's doEnhance needs inventory.ts's single-cell redraw optimization, but inventory.ts is
    // constructed after detail.ts (inventory needs `detail` for instanceActions/openDetail) — wire
    // the lazy hook now.
    this.core.refreshInstanceCellHook = (id) => this.inventory.refreshInstanceCell(id);
    this.craft = new CraftPanel(this.core);

    this.render();
    // Same fixup as CardScene.ts — the peer-group rail's [Cards|Equipment|Skins] icons are AI PNGs
    // that may not have decoded yet on this first render.
    void preloadIconArt().then(() => this.render());
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
    core.renderGeneration++;
    tearDownChildren(core.bodyLayer);
    core.hitRects = [];
    tearDownChildren(core.loadingLayer);
    // Back button (header is static art; its hit lives here so re-render keeps it).
    // While assigning, Back cancels the card picker rather than leaving the scene.
    core.hitRects.push({ rect: core.backRect, sound: 'sfx.ui.back', fn: () => core.backAction() });

    renderHeaderCurrency(core);
    this.inventory.renderSidebar();
    if (core.assign) {
      // The card picker replaces the header row entirely — hide the materials band left over from
      // whatever tab was showing before assign mode started (renderHeaderRow/renderMaterialsBand
      // aren't called on this path).
      tearDownChildren(core.materialsLayer);
      this.assign.renderAssign(core.cb.getSave());
      if (core.bt.loadingVisible) drawLoadingOverlay(core.loadingLayer, core.w, core.h, core.bt.dots, t('common.processing'));
      return;
    }
    const bodyTop = this.renderHeaderRow();
    if (core.activeTab === 'inv') this.inventory.renderInventory(bodyTop);
    else this.craft.renderCraft(bodyTop);

    // Re-open detail modal if an instance is selected (refreshes after actions);
    // otherwise ensure no stale modal (e.g. confirm) lingers after it cleared detailId.
    if (core.detailId) this.detail.openDetail(core.detailId);
    else if (core.modalOpen) core.closeModal();

    if (core.bt.loadingVisible) drawLoadingOverlay(core.loadingLayer, core.w, core.h, core.bt.dots, t('common.processing'));
  }

  /**
   * Header row below the header/sidebar: the slot filter bar (Inventory tab only), capped left
   * at the red margin rule so it lines up with the bag-list / item-grid split below it. Returns
   * the y where body content (loadout / grid) should start.
   *
   * Portrait draws the Inventory/Craft sub-tabs here too, as a `drawHubTabs` strip (§18) — the
   * left rail they used to nest under (InventoryPanel.renderSidebar) is a bottom bar in portrait,
   * so there's nothing left to nest under; a header strip is the existing "sub-view switch within
   * one scene" convention used everywhere else in the game. Content spans full width (no leftW
   * reservation) since nothing occupies the left edge in portrait.
   */
  private renderHeaderRow(): number {
    const core = this.core;
    const { w, h, landscape } = core;
    const top = core.headerH;

    if (!landscape) {
      const stripH = hubTabsHeight(h);
      const subTabs: HubTab[] = EQUIP_SUBTABS.map((tab) => ({
        label: t(tab.label), active: core.activeTab === tab.key, icon: tab.icon,
      }));
      const hits = drawHubTabs(core.bodyLayer, w, top, stripH, subTabs, (i) => {
        const key: EquipTab = i === 0 ? 'inv' : 'craft';
        if (core.activeTab !== key) { core.activeTab = key; core.scrollY = 0; core.render(); }
      });
      core.hitRects.push(...hits);

      let bottom = top + stripH;
      renderMaterialsBand(core, 0, bottom, w);
      bottom += MAT_BAND_H;
      if (core.activeTab === 'inv') {
        this.inventory.renderSlotFilter(0, bottom, w);
        // Breathing room before the loadout strip below — see the landscape branch's TAB_LOADOUT_GAP note.
        bottom += FILTER_H + TAB_LOADOUT_GAP;
      }
      return bottom;
    }

    const leftW = sidebarNavW(w, h, true);
    const rightX = leftW;
    const rightW = w - leftW;

    let rightBottom = top;
    // Materials band (both tabs) — the three crafting materials, relocated out of the header.
    renderMaterialsBand(core, rightX, rightBottom, rightW);
    rightBottom += MAT_BAND_H;
    if (core.activeTab === 'inv') {
      this.inventory.renderSlotFilter(rightX, rightBottom, rightW);
      // The slot filter bar and the loadout strip below it used to butt up against each other with
      // zero gap, reading as one fused block — the loadout's equipped-item star row visually looked
      // like it belonged to the tab bar itself rather than to a separate section (2026-08-01 fix).
      rightBottom += FILTER_H + TAB_LOADOUT_GAP;
    }

    return rightBottom;
  }
}
