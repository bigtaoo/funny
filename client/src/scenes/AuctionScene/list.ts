// Market list tab: left sidebar (Market/My Auctions/My Bids), the category filter bar, the auction row list,
// and the bottom "create listing" button.
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { FILTER_H, AUC_CELL_GAP, AUC_CELL_H, AUC_CELL_W_TARGET, FILTERS, type AucFilter, type AucTab } from './base';
import { type Constructor, type AuctionSceneBaseCtor } from './base';

export interface ListHandlers {
  renderSidebar(): number;
  renderFilterBar(contentX: number): number;
  renderList(auctions: AuctionView[], contentX: number, filterH?: number): void;
  renderAuctionCell(auc: AuctionView, x: number, y: number, cellW: number, now: number): void;
  renderCreateButton(contentX: number): void;
  myBids(): AuctionView[];
}

export function ListMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<ListHandlers> {
  return class extends Base {
    /** Auctions where I'm currently the top bidder ("My Bids") — derived client-side from the open market list (no dedicated endpoint). */
    myBids(): AuctionView[] {
      const me = this.cb.myAccountId;
      if (!me) return [];
      return this.allAuctions.filter((a) => a.saleMode === 'auction' && a.topBid?.bidderId === me);
    }

    /**
     * Left nav rail (`sidebarNavW`, matching every other hub's left tab rail) below the header:
     * Market / My Auctions / My Bids. Returns the x where the body content (filter bar / list /
     * create button) should start.
     */
    renderSidebar(): number {
      const { w, h, landscape } = this;
      const sidebarW = sidebarNavW(w, h, landscape);
      const tabs: AucTab[] = ['all', 'mine', 'bids'];
      const labelKeys: Record<AucTab, 'auction.tabAll' | 'auction.tabMine' | 'auction.tabBids'> = {
        all: 'auction.tabAll', mine: 'auction.tabMine', bids: 'auction.tabBids',
      };
      const icons: Record<AucTab, IconKind> = { all: 'tag', mine: 'cards', bids: 'hammer' };
      const hubTabs: HubTab[] = tabs.map((tab) => ({ label: t(labelKeys[tab]), active: tab === this.activeTab, icon: icons[tab] }));
      const { hits } = drawSidebarTabs(this.bodyLayer, sidebarW, this.headerH, h, hubTabs, (i) => {
        const tab = tabs[i]!;
        if (this.activeTab !== tab) { this.activeTab = tab; this.scrollY = 0; this.render(); }
      });
      for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
      return sidebarW;
    }

    renderFilterBar(contentX: number): number {
      const { w } = this;
      const y = this.headerH;
      const contentW = w - contentX;
      const chipW = contentW / FILTERS.length;
      const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterMaterial' | 'auction.filterEquipment' | 'auction.filterCard'> = {
        '': 'auction.filterAll', material: 'auction.filterMaterial', equipment: 'auction.filterEquipment', card: 'auction.filterCard',
      };
      for (let i = 0; i < FILTERS.length; i++) {
        const f = FILTERS[i]!;
        const active = f === this.allFilter;
        const chip = sketchPanel(chipW - 6, FILTER_H - 8, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 3, chipW) });
        chip.x = contentX + i * chipW + 3; chip.y = y + 2;
        this.bodyLayer.addChild(chip);
        const midY = y + 2 + (FILTER_H - 8) / 2;
        // Category glyph prefix (the 'all' filter stays text-only).
        if (f !== '') {
          const fi = buildIcon(this.itemKind(f), 20, active ? C.light : C.dark);
          fi.x = contentX + i * chipW + 9; fi.y = midY - 10;
          this.bodyLayer.addChild(fi);
        }
        const lbl = txt(t(keys[f]), 14, active ? C.light : C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + i * chipW + chipW / 2 + (f !== '' ? 10 : 0); lbl.y = midY;
        this.bodyLayer.addChild(lbl);
        this.hitRects.push({
          rect: { x: contentX + i * chipW + 3, y: y + 2, w: chipW - 6, h: FILTER_H - 8 },
          action: () => { if (this.allFilter !== f) { this.allFilter = f; this.scrollY = 0; void this.loadData(); } },
        });
      }
      return FILTER_H;
    }

    renderList(auctions: AuctionView[], contentX: number, filterH = 0): void {
      const { w, h } = this;
      const listY = this.headerH + filterH;
      const createBtnH = 100; // reserves room for the 2x "+ List Item" button below
      const listH = h - listY - createBtnH - 10;
      const contentW = w - contentX;
      const emptyKeys: Record<AucTab, 'auction.empty' | 'auction.myEmpty' | 'auction.bidsEmpty'> = {
        all: 'auction.empty', mine: 'auction.myEmpty', bids: 'auction.bidsEmpty',
      };

      if (this.loading) {
        const lbl = txt(t('world.loading'), 16, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      if (auctions.length === 0) {
        const lbl = txt(t(emptyKeys[this.activeTab]), 16, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + listH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      // Card grid (mirrors CardScene's roster grid): as many columns as fit AUC_CELL_W_TARGET, wrapping rows.
      const left = contentX + AUC_CELL_GAP;
      const avail = contentW - AUC_CELL_GAP * 2;
      const cols = Math.max(1, Math.floor((avail + AUC_CELL_GAP) / (AUC_CELL_W_TARGET + AUC_CELL_GAP)));
      const cellW = (avail - AUC_CELL_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(auctions.length / cols);
      const totalH = rows * (AUC_CELL_H + AUC_CELL_GAP) + AUC_CELL_GAP;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      const now = Date.now();
      auctions.forEach((auc, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + AUC_CELL_GAP);
        const y = listY + AUC_CELL_GAP + row * (AUC_CELL_H + AUC_CELL_GAP) - this.scrollY;
        if (y + AUC_CELL_H >= listY && y <= listY + listH) {
          this.renderAuctionCell(auc, x, y, cellW, now);
        }
      });

      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: listH }, this.scrollY, Math.max(0, totalH - listH));
    }

    /**
     * Auction card cell: a framed item-class glyph on the left (CardScene roster-card treatment),
     * with name/price/status stacked to its right and the row action pinned bottom-right.
     */
    renderAuctionCell(auc: AuctionView, x: number, y: number, cellW: number, now: number): void {
      const pad = 14;
      const isAuction = auc.saleMode === 'auction';

      const cell = sketchPanel(cellW, AUC_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // ── Left: framed item-class glyph (square, spans the cell's inner height) ──
      const imgSize = AUC_CELL_H - pad * 2;
      const imgX = x + pad; const imgY = y + pad;
      const frame = sketchPanel(imgSize, imgSize, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgSize) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      const iconSize = Math.round(imgSize * 0.55);
      const clsIcon = buildIcon(this.itemKind(auc.itemType, auc.item?.['material'] as string | undefined), iconSize, C.dark);
      clsIcon.x = imgX + (imgSize - iconSize) / 2; clsIcon.y = imgY + (imgSize - iconSize) / 2;
      this.bodyLayer.addChild(clsIcon);

      // Sale-mode glyph badge, top-right corner of the frame (tag = buy-now, gavel = auction).
      const modeIcon = buildIcon(this.saleModeKind(isAuction ? 'auction' : 'fixed'), 22, isAuction ? C.red : C.mid);
      modeIcon.x = imgX + imgSize - 22; modeIcon.y = imgY;
      this.bodyLayer.addChild(modeIcon);

      // ── Right: info column (name, price, buyout, countdown) ──
      const ax = imgX + imgSize + 16;
      const rightW = x + cellW - pad - ax;

      const itemLbl = txt(this.auctionLabel(auc), 19, C.dark, true);
      itemLbl.x = ax; itemLbl.y = y + pad;
      itemLbl.style.wordWrap = true; itemLbl.style.wordWrapWidth = Math.max(20, rightW);
      this.bodyLayer.addChild(itemLbl);

      let ay = y + pad + Math.max(28, itemLbl.height + 8);

      // Fixed-price: show the unit sale price; auction: show the current bid (or the starting price when no bids).
      const priceText = isAuction
        ? `${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`
        : `${t('auction.price')}: ${auc.price}`;
      const priceLbl = txt(priceText, 17, C.accent, true);
      priceLbl.x = ax; priceLbl.y = ay;
      this.bodyLayer.addChild(priceLbl);
      ay += 26;

      if (isAuction && auc.buyoutPrice) {
        const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), 14, C.mid);
        boLbl.x = ax; boLbl.y = ay;
        this.bodyLayer.addChild(boLbl);
      }

      // Countdown only makes sense for a live listing — closed history cells (sold/expired/cancelled) would
      // otherwise all read "0m". Those show a status badge instead (My-Listings branch below).
      if (auc.status === 'open') {
        const remaining = Math.max(0, Math.ceil((auc.expireAt - now) / 60000));
        const expLbl = txt(`${remaining}m`, 14, C.mid);
        expLbl.x = ax; expLbl.y = y + AUC_CELL_H - pad - 18;
        this.bodyLayer.addChild(expLbl);
      }

      // ── Bottom-right: action button / status badge ──
      const btnW = 96; const btnH = 40;
      const btnX = x + cellW - pad - btnW; const btnY = y + AUC_CELL_H - pad - btnH;

      if (this.activeTab === 'all') {
        const aucId = auc.auctionId;
        const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(y, 0, btnW) });
        btn.x = btnX; btn.y = btnY;
        this.bodyLayer.addChild(btn);
        const bl = txt(isAuction ? t('auction.bid') : t('auction.buy'), 16, C.light);
        bl.anchor.set(0.5, 0.5); bl.x = btnX + btnW / 2; bl.y = btnY + btnH / 2;
        this.bodyLayer.addChild(bl);
        this.hitRects.push({
          rect: { x: btnX, y: btnY, w: btnW, h: btnH },
          action: isAuction ? () => this.openBidForm(auc) : () => this.confirmBuy(aucId, auc.price),
        });
      } else if (this.activeTab === 'mine') {
        if (auc.status === 'open') {
          // Live listing → cancel action.
          const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xf0e0e0, border: C.red, seed: seedFor(y, 1, btnW) });
          cancelBtn.x = btnX; cancelBtn.y = btnY;
          this.bodyLayer.addChild(cancelBtn);
          const cl = txt(t('auction.cancel'), 16, C.red);
          cl.anchor.set(0.5, 0.5); cl.x = btnX + btnW / 2; cl.y = btnY + btnH / 2;
          this.bodyLayer.addChild(cl);
          const aucId = auc.auctionId;
          this.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, action: () => this.confirmCancel(aucId) });
        } else {
          // Closed history cell → status badge (sold = accent, expired/cancelled = muted), no action.
          const statusKey = auc.status === 'sold'
            ? 'auction.statusSold'
            : auc.status === 'cancelled'
              ? 'auction.statusCancelled'
              : 'auction.statusExpired';
          const badge = txt(t(statusKey), 15, auc.status === 'sold' ? C.accent : C.mid, true);
          badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
          this.bodyLayer.addChild(badge);
        }
      } else {
        // My Bids: informational only (leading bidder, not the owner) — no action button, just a status badge.
        const badge = txt(t('auction.leading'), 15, C.accent, true);
        badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
        this.bodyLayer.addChild(badge);
      }
    }

    renderCreateButton(contentX: number): void {
      const { w, h } = this;
      const contentW = w - contentX;
      // 2x the previous 200x44 button.
      const btnW = 400; const btnH = 88;
      const btnY = h - btnH - 12;
      const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
      btn.x = contentX + contentW / 2 - btnW / 2; btn.y = btnY;
      this.bodyLayer.addChild(btn);
      const bl = txt(`+ ${t('auction.create')}`, 32, C.light);
      bl.anchor.set(0.5, 0.5); bl.x = contentX + contentW / 2; bl.y = btnY + btnH / 2;
      this.bodyLayer.addChild(bl);
      this.hitRects.push({ rect: { x: contentX + contentW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH }, action: () => this.openCreateForm() });
    }
  };
}
