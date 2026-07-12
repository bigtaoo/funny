// Market list tab: left sidebar (Market/My Auctions/My Bids), the category filter bar, the auction row list,
// and the bottom "create listing" button.
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import { buildIcon, type IconKind } from '../../render/icons';
import { FILTER_H, ROW_H, FILTERS, type AucFilter, type AucTab } from './base';
import { type Constructor, type AuctionSceneBaseCtor } from './base';

export interface ListHandlers {
  renderSidebar(): number;
  renderFilterBar(contentX: number): number;
  renderList(auctions: AuctionView[], contentX: number, filterH?: number): void;
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
      const createBtnH = 52;
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

      const totalH = auctions.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

      const now = Date.now();
      let cy = listY - this.scrollY;
      for (const auc of auctions) {
        if (cy + ROW_H < listY || cy > listY + listH) { cy += ROW_H; continue; }

        const row = sketchPanel(contentW - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, contentW) });
        row.x = contentX + 6; row.y = cy;
        this.bodyLayer.addChild(row);

        const isAuction = auc.saleMode === 'auction';

        // Item-class glyph (equipment/card/material) at the row's left edge.
        const clsIcon = buildIcon(this.itemKind(auc.itemType, auc.item?.['material'] as string | undefined), 30, C.dark);
        clsIcon.x = contentX + 14; clsIcon.y = cy + 10;
        this.bodyLayer.addChild(clsIcon);

        const itemLbl = txt(this.auctionLabel(auc), 17, C.dark);
        itemLbl.x = contentX + 52; itemLbl.y = cy + 8;
        this.bodyLayer.addChild(itemLbl);

        // Sale-mode glyph after the label (tag = buy-now, gavel = auction).
        const modeIcon = buildIcon(this.saleModeKind(isAuction ? 'auction' : 'fixed'), 20, isAuction ? C.red : C.mid);
        modeIcon.x = itemLbl.x + itemLbl.width + 8; modeIcon.y = cy + 7;
        this.bodyLayer.addChild(modeIcon);

        // Fixed-price: show the unit sale price; auction: show the current bid (or the starting price when no bids).
        const priceText = isAuction
          ? `${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`
          : `${t('auction.price')}: ${auc.price}`;
        const priceLbl = txt(priceText, 15, C.accent);
        priceLbl.x = contentX + 52; priceLbl.y = cy + 32;
        this.bodyLayer.addChild(priceLbl);

        if (isAuction && auc.buyoutPrice) {
          const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), 13, C.mid);
          boLbl.x = contentX + 52; boLbl.y = cy + 54;
          this.bodyLayer.addChild(boLbl);
        }

        const remaining = Math.max(0, Math.ceil((auc.expireAt - now) / 60000));
        const expLbl = txt(`${remaining}m`, 14, C.mid);
        expLbl.x = contentX + contentW - 88; expLbl.y = cy + 8;
        this.bodyLayer.addChild(expLbl);

        if (this.activeTab === 'all') {
          const aucId = auc.auctionId;
          const btn = sketchPanel(68, 32, { fill: C.dark, border: C.accent, seed: seedFor(cy, 0, 68) });
          btn.x = contentX + contentW - 80; btn.y = cy + 18;
          this.bodyLayer.addChild(btn);
          const bl = txt(isAuction ? t('auction.bid') : t('auction.buy'), 15, C.light);
          bl.anchor.set(0.5, 0.5); bl.x = contentX + contentW - 46; bl.y = cy + 34;
          this.bodyLayer.addChild(bl);
          this.hitRects.push({
            rect: { x: contentX + contentW - 80, y: cy + 18, w: 68, h: 32 },
            action: isAuction ? () => this.openBidForm(auc) : () => this.confirmBuy(aucId, auc.price),
          });
        } else if (this.activeTab === 'mine') {
          const cancelBtn = sketchPanel(68, 32, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 1, 68) });
          cancelBtn.x = contentX + contentW - 80; cancelBtn.y = cy + 18;
          this.bodyLayer.addChild(cancelBtn);
          const cl = txt(t('auction.cancel'), 15, C.red);
          cl.anchor.set(0.5, 0.5); cl.x = contentX + contentW - 46; cl.y = cy + 34;
          this.bodyLayer.addChild(cl);
          const aucId = auc.auctionId;
          this.hitRects.push({ rect: { x: contentX + contentW - 80, y: cy + 18, w: 68, h: 32 }, action: () => this.confirmCancel(aucId) });
        } else {
          // My Bids: informational only (leading bidder, not the owner) — no action button, just a status badge.
          const badge = txt(t('auction.leading'), 14, C.accent, true);
          badge.anchor.set(1, 0.5); badge.x = contentX + contentW - 20; badge.y = cy + 34;
          this.bodyLayer.addChild(badge);
        }

        cy += ROW_H;
      }
    }

    renderCreateButton(contentX: number): void {
      const { w, h } = this;
      const contentW = w - contentX;
      const btnY = h - 56;
      const btn = sketchPanel(200, 44, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 200) });
      btn.x = contentX + contentW / 2 - 100; btn.y = btnY;
      this.bodyLayer.addChild(btn);
      const bl = txt(`+ ${t('auction.create')}`, 16, C.light);
      bl.anchor.set(0.5, 0.5); bl.x = contentX + contentW / 2; bl.y = btnY + 22;
      this.bodyLayer.addChild(bl);
      this.hitRects.push({ rect: { x: contentX + contentW / 2 - 100, y: btnY, w: 200, h: 44 }, action: () => this.openCreateForm() });
    }
  };
}
