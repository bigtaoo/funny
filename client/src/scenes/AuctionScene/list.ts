// Market list tab: left sidebar (Market/My Auctions/My Bids), the category filter bar, the auction row list,
// and the bottom "create listing" button.
// Converted from ListMixin(Base) to composition (2026-08-11) — see core.ts's file-header comment.
// Depends one-directionally on Bid/TradeActions/CreateListing (row actions open their flows; none of
// those three ever call back into List) via narrow interfaces, mirroring DefenseEditorScene/render.ts's
// `saveActions: SaveActionsHandlers` pattern — BidOpener/TradeOpener live in ./listCell (the cell is
// what wires those two), CreateFormOpener below.
// How ONE cell is drawn moved to ./listCell.ts (2026-09-12, the 500-line convention); this file keeps
// the tab chrome and the grid geometry that places the cells.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { serverNow } from '../../net/serverClock';
import { FILTER_H, AUC_CELL_GAP, AUC_CELL_H, aucGrid, FILTERS, type AucFilter, type AucTab } from './types';
import type { AuctionSceneCore } from './core';
import { itemKind } from './itemLabels';
import { renderAuctionCell, type BidOpener, type TradeOpener, type CellActions } from './listCell';

/** Narrow slice of CreateListingPanel that List's "+ List Item" button needs. */
export interface CreateFormOpener {
  openCreateForm(): void;
}

// card/skin filter chips → rosterIcon/skinIcon (AI art pilot batch 2, design/product/tab-icon-art-prompts.md
// §batch2): same "卡"/"皮肤" concept the [Cards|Equipment|Skins] peer tabs already draw with dedicated AI
// art. itemKind() itself stays generic 'cards'/'brush' — it also feeds the per-row item-type badge and
// the create-listing content badge (different render context, not part of this tab-icon batch).
const FILTER_ICON_OVERRIDE: Partial<Record<AucFilter, IconKind>> = { card: 'rosterIcon', skin: 'skinIcon' };

export class ListPanel {
  /**
   * The row-action bundle every cell is handed (./listCell). Built once from the very instances the
   * assembly passed in — `bid`/`trade` stay own fields because composition-wiring.ui.ts asserts List
   * reaches those two through the SAME objects the facade holds, not copies.
   */
  private readonly cellActions: CellActions;

  constructor(
    private readonly core: AuctionSceneCore,
    private readonly bid: BidOpener,
    private readonly trade: TradeOpener,
    private readonly createListing: CreateFormOpener,
  ) {
    this.cellActions = { bid: this.bid, trade: this.trade };
  }

  /**
   * Listings for the "My Bids" tab: every auction I have bid on, in the order the server ranked them
   * (live first, soonest to end first; then closed history newest-first).
   *
   * Was a client-side filter over `allAuctions` on `topBid.bidderId === myAccountId`, which could only
   * ever surface listings I was LEADING — being outbid made the listing disappear from the tab entirely,
   * exactly when the player most needs to see it. Now server data (GET /auction/myBids, backed by bid
   * records), so being outbid, winning and losing are all still listed; the per-cell badge below reads
   * `core.myBidIndex` for which of those it is.
   */
  myBids(): AuctionView[] {
    return this.core.myBids.map((b) => b.auction);
  }

  /**
   * Market / My Auctions / My Bids. Landscape: a left nav rail (`sidebarNavW`, matching every
   * other hub's left tab rail) below the header — returns its width so body content (filter bar /
   * list / create button) starts clear of it. Portrait: a bottom nav bar instead (§18) — returns
   * 0 (no width reservation); the list/create-button height math reserves `bottomNavH` off the
   * bottom instead (see renderList/renderCreateButton).
   */
  renderSidebar(): number {
    const core = this.core;
    const { w, h, landscape } = core;
    const tabs: AucTab[] = ['all', 'mine', 'bids'];
    const labelKeys: Record<AucTab, 'auction.tabAll' | 'auction.tabMine' | 'auction.tabBids'> = {
      all: 'auction.tabAll', mine: 'auction.tabMine', bids: 'auction.tabBids',
    };
    // 'mine' keeps the generic 'cards' glyph deliberately (AI art pilot batch 2 judged this NOT the
    // same "卡" concept as rosterIcon — "My Auctions" covers cards/equipment/materials/skins alike, not
    // specifically cards; see design/product/tab-icon-art-prompts.md §batch2 for the reasoning).
    // 'all' → shopTabIcon (AI art batch 3, pure reuse): same literal "price tag" concept as the shop-group
    // hub's own tab, reused here rather than minting a second price-tag icon. 'bids' → bidTabIcon (AI
    // art batch 3, new concept: auction gavel), a pure recognizability upgrade — no reuse conflict on
    // 'hammer' itself (elsewhere it's only ever the equipment-enhance action button).
    const icons: Record<AucTab, IconKind> = { all: 'shopTabIcon', mine: 'cards', bids: 'bidTabIcon' };
    const hubTabs: HubTab[] = tabs.map((tab) => ({ label: t(labelKeys[tab]), active: tab === core.activeTab, icon: icons[tab] }));
    const onSelect = (i: number): void => {
      const tab = tabs[i]!;
      if (core.activeTab !== tab) { core.activeTab = tab; core.scrollY = 0; core.render(); }
    };
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, hubTabs, onSelect);
      core.hitRects.push(...hits);
      return 0;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(core.bodyLayer, sidebarW, core.headerH, h, hubTabs, onSelect);
    core.hitRects.push(...hits);
    return sidebarW;
  }

  renderFilterBar(contentX: number): number {
    const core = this.core;
    const { w } = core;
    const y = core.headerH;
    const contentW = w - contentX;
    const chipW = contentW / FILTERS.length;
    const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterMaterial' | 'auction.filterEquipment' | 'auction.filterCard' | 'auction.filterSkin'> = {
      '': 'auction.filterAll', material: 'auction.filterMaterial', equipment: 'auction.filterEquipment', card: 'auction.filterCard', skin: 'auction.filterSkin',
    };
    // 1.5x the original chip metrics (padding/icon/font) — approved 15.07.2026 category-bar
    // enlargement pass. Chip width itself is unchanged (still contentW / FILTERS.length), so the
    // label is measured and scaled down if it would otherwise overflow the chip (see maxLblW below).
    const pad = 9;
    const iconSize = 30;
    const fontSize = FS.bodyLg;
    for (let i = 0; i < FILTERS.length; i++) {
      const f = FILTERS[i]!;
      const active = f === core.allFilter;
      const chip = sketchPanel(chipW - pad, FILTER_H - 12, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 3, chipW) });
      chip.x = contentX + i * chipW + pad / 2; chip.y = y + 3;
      core.bodyLayer.addChild(chip);
      const midY = y + 3 + (FILTER_H - 12) / 2;
      const hasIcon = f !== '';
      const iconGap = hasIcon ? iconSize + 8 : 0;
      // Category glyph prefix (the 'all' filter stays text-only).
      if (hasIcon) {
        const fi = buildIcon(FILTER_ICON_OVERRIDE[f] ?? itemKind(f), iconSize, active ? C.light : C.dark);
        fi.x = contentX + i * chipW + pad / 2 + 12; fi.y = midY - iconSize / 2;
        core.bodyLayer.addChild(fi);
      }
      const lbl = txt(t(keys[f]), fontSize, active ? C.light : C.dark);
      const maxLblW = chipW - pad - 20 - iconGap;
      if (lbl.width > maxLblW) lbl.scale.set(Math.max(0.5, maxLblW / lbl.width));
      lbl.anchor.set(0.5, 0.5);
      lbl.x = contentX + i * chipW + pad / 2 + 12 + iconGap + maxLblW / 2;
      lbl.y = midY;
      core.bodyLayer.addChild(lbl);
      core.hitRects.push({
        rect: { x: contentX + i * chipW + pad / 2, y: y + 3, w: chipW - pad, h: FILTER_H - 12 },
        fn: () => { if (core.allFilter !== f) { core.allFilter = f; core.scrollY = 0; void core.loadData(); } },
      });
    }
    return FILTER_H;
  }

  renderList(auctions: AuctionView[], contentX: number, filterH = 0): void {
    const core = this.core;
    const { w, h } = core;
    const listY = core.headerH + filterH;
    const createBtnH = 100; // reserves room for the 2x "+ List Item" button below
    // Portrait's tab nav is a bottom bar instead of a left rail (§18) — reserve bottomNavH off the
    // bottom, below the create button (which itself shifts up by the same amount).
    const availH = h - listY - createBtnH - 10 - (core.landscape ? 0 : bottomNavH(h));
    const contentW = w - contentX;
    const emptyKeys: Record<AucTab, 'auction.empty' | 'auction.myEmpty' | 'auction.bidsEmpty'> = {
      all: 'auction.empty', mine: 'auction.myEmpty', bids: 'auction.bidsEmpty',
    };
    // Default to "nothing to scroll" — overwritten below once the real grid geometry is known;
    // covers the loading/empty early-returns so a stale wheel event can't scroll a hidden list.
    core.scrollMax = 0;

    if (core.loading) {
      const lbl = txt(t('world.loading'), FS.small, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      return;
    }

    if (auctions.length === 0) {
      const lbl = txt(t(emptyKeys[core.activeTab]), FS.small, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      return;
    }

    // Card grid (mirrors CardScene's roster grid): as many columns as fit AUC_CELL_W_TARGET, wrapping rows.
    const left = contentX + AUC_CELL_GAP;
    const avail = contentW - AUC_CELL_GAP * 2;
    const { cols, cellW } = aucGrid(contentW);
    const rows = Math.ceil(auctions.length / cols);
    const totalH = rows * (AUC_CELL_H + AUC_CELL_GAP) + AUC_CELL_GAP;
    // `peekViewportH`'s mid-row shrink is deliberately NOT used here — it would exclude a row that
    // fits fine and leave a dead gap (2026-07-23 correction, UI_DESIGN.md §25). So the viewport is
    // the naive availH (also the wheel-scroll bounds, see wheelScroll.ts) and a partly-visible row
    // is CROPPED by a mask instead of being dropped.
    //
    // The mask is new (2026-09-12) and the draw-cull it replaces was never sound: `y <= listY +
    // availH` draws any row whose TOP is inside the viewport in full, so the bottom row always ran
    // up to a cell-height past the viewport, over the "+ List Item" button beneath it — and the
    // matching top test let a row scrolled half-way up paint over the filter bar. It went unseen
    // because whether it bit depended on where the row boundaries happened to land: raising
    // AUC_CELL_H by 20 was enough to put the last row's price and countdown straight through the
    // create button on three viewports. Same gridLayer + clip shape the craft/inventory grids use.
    core.scrollMax = Math.max(0, totalH - availH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, core.scrollMax));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + availH;

    const gridLayer = new PIXI.Container();
    core.bodyLayer.addChild(gridLayer);
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(contentX, listY, contentW, availH).endFill();
    core.bodyLayer.addChild(clip);
    gridLayer.mask = clip;
    const outerLayer = core.bodyLayer;
    core.bodyLayer = gridLayer;

    const now = serverNow();
    auctions.forEach((auc, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + AUC_CELL_GAP);
      const y = listY + AUC_CELL_GAP + row * (AUC_CELL_H + AUC_CELL_GAP) - core.scrollY;
      if (y + AUC_CELL_H >= listY && y <= listY + availH) {
        renderAuctionCell(core, this.cellActions, auc, x, y, cellW, now);
      }
    });
    core.bodyLayer = outerLayer;

    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: availH }, core.scrollY, Math.max(0, totalH - availH));
  }

  renderCreateButton(contentX: number): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const contentW = w - contentX;
    // 2x the previous 200x44 button.
    const btnW = 400; const btnH = 88;
    // Portrait's tab nav is a bottom bar (§18) — this button sits just above it instead of at the
    // screen edge.
    const btnY = h - btnH - 12 - (landscape ? 0 : bottomNavH(h));
    const btn = sketchButton(btnW, btnH, seedFor(0, 0, btnW));
    btn.x = contentX + contentW / 2 - btnW / 2; btn.y = btnY;
    core.bodyLayer.addChild(btn);
    drawButtonLabel(core.bodyLayer, contentX + contentW / 2 - btnW / 2, btnY, btnW, btnH,
      t('auction.create'), 'tag', C.light, FS.title, { bold: false });
    core.hitRects.push({ rect: { x: contentX + contentW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH }, fn: () => this.createListing.openCreateForm() });
  }
}
