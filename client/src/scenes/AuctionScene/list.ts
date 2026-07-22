// Market list tab: left sidebar (Market/My Auctions/My Bids), the category filter bar, the auction row list,
// and the bottom "create listing" button.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import type { EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/equipmentAtlas';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { UNIT_ART_URLS, getArtTexture } from '../../render/cardArt';
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
      // 1.5x the original chip metrics (padding/icon/font) — approved 15.07.2026 category-bar
      // enlargement pass. Chip width itself is unchanged (still contentW / FILTERS.length), so the
      // label is measured and scaled down if it would otherwise overflow the chip (see maxLblW below).
      const pad = 9;
      const iconSize = 30;
      const fontSize = FS.bodyLg;
      for (let i = 0; i < FILTERS.length; i++) {
        const f = FILTERS[i]!;
        const active = f === this.allFilter;
        const chip = sketchPanel(chipW - pad, FILTER_H - 12, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 3, chipW) });
        chip.x = contentX + i * chipW + pad / 2; chip.y = y + 3;
        this.bodyLayer.addChild(chip);
        const midY = y + 3 + (FILTER_H - 12) / 2;
        const hasIcon = f !== '';
        const iconGap = hasIcon ? iconSize + 8 : 0;
        // Category glyph prefix (the 'all' filter stays text-only).
        if (hasIcon) {
          const fi = buildIcon(this.itemKind(f), iconSize, active ? C.light : C.dark);
          fi.x = contentX + i * chipW + pad / 2 + 12; fi.y = midY - iconSize / 2;
          this.bodyLayer.addChild(fi);
        }
        const lbl = txt(t(keys[f]), fontSize, active ? C.light : C.dark);
        const maxLblW = chipW - pad - 20 - iconGap;
        if (lbl.width > maxLblW) lbl.scale.set(Math.max(0.5, maxLblW / lbl.width));
        lbl.anchor.set(0.5, 0.5);
        lbl.x = contentX + i * chipW + pad / 2 + 12 + iconGap + maxLblW / 2;
        lbl.y = midY;
        this.bodyLayer.addChild(lbl);
        this.hitRects.push({
          rect: { x: contentX + i * chipW + pad / 2, y: y + 3, w: chipW - pad, h: FILTER_H - 12 },
          action: () => { if (this.allFilter !== f) { this.allFilter = f; this.scrollY = 0; void this.loadData(); } },
        });
      }
      return FILTER_H;
    }

    renderList(auctions: AuctionView[], contentX: number, filterH = 0): void {
      const { w, h } = this;
      const listY = this.headerH + filterH;
      const createBtnH = 100; // reserves room for the 2x "+ List Item" button below
      const availH = h - listY - createBtnH - 10;
      const contentW = w - contentX;
      const emptyKeys: Record<AucTab, 'auction.empty' | 'auction.myEmpty' | 'auction.bidsEmpty'> = {
        all: 'auction.empty', mine: 'auction.myEmpty', bids: 'auction.bidsEmpty',
      };

      if (this.loading) {
        const lbl = txt(t('world.loading'), FS.small, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
        this.bodyLayer.addChild(lbl);
        return;
      }

      if (auctions.length === 0) {
        const lbl = txt(t(emptyKeys[this.activeTab]), FS.small, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
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
      // Clamp the viewport so it always cuts mid-row when there's more below, so a partial next
      // card always peeks above the fold (see scrollPeek.ts).
      const listH = peekViewportH(availH, AUC_CELL_H + AUC_CELL_GAP, totalH);
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

      // ── Left: framed item picture (square, capped so a tall cell doesn't crowd out the text
      // column to its right — see renderItemPicture for the real per-item art). ──
      const imgSize = Math.min(AUC_CELL_H - pad * 2, 130);
      const imgX = x + pad; const imgY = y + (AUC_CELL_H - imgSize) / 2;
      const frame = sketchPanel(imgSize, imgSize, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgSize) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      this.renderItemPicture(auc, imgX + imgSize / 2, imgY + imgSize / 2, Math.round(imgSize * 0.62), seedFor(x, y, imgSize));

      // Sale-mode glyph badge, top-right corner of the frame (tag = buy-now, gavel = auction).
      const modeIcon = buildIcon(this.saleModeKind(isAuction ? 'auction' : 'fixed'), 22, isAuction ? C.red : C.mid);
      modeIcon.x = imgX + imgSize - 22; modeIcon.y = imgY;
      this.bodyLayer.addChild(modeIcon);

      // Designated-buyer badge: shown in "Market" when I'm the account this listing is exclusive to
      // (server already hides it from everyone else; this just distinguishes it from the open market).
      if (this.activeTab === 'all' && auc.designatedBuyerId && auc.designatedBuyerId === this.cb.myAccountId) {
        const badge = txt(t('auction.exclusive'), FS.tiny, C.light, true);
        badge.anchor.set(0, 0);
        const bx = x + pad; const by = y + pad;
        const bw = badge.width + 12; const bh = badge.height + 8;
        const badgeBg = sketchPanel(bw, bh, { fill: C.accent, border: C.accent, seed: seedFor(x, y, bw) });
        badgeBg.x = bx; badgeBg.y = by;
        this.bodyLayer.addChild(badgeBg);
        badge.x = bx + 6; badge.y = by + 4;
        this.bodyLayer.addChild(badge);
      }

      // ── Right: info column (name, price, buyout, countdown) ──
      const ax = imgX + imgSize + 16;
      const rightW = x + cellW - pad - ax;

      const itemLbl = txt(this.auctionLabel(auc), FS.bodyLg, C.dark, true);
      itemLbl.x = ax; itemLbl.y = y + pad;
      itemLbl.style.wordWrap = true; itemLbl.style.wordWrapWidth = Math.max(20, rightW);
      this.bodyLayer.addChild(itemLbl);

      let ay = y + pad + Math.max(28, itemLbl.height + 8);

      // Fixed-price: show the unit sale price; auction: show the current bid (or the starting price when no bids).
      const priceText = isAuction
        ? `${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`
        : `${t('auction.price')}: ${auc.price}`;
      const priceLbl = txt(priceText, FS.body, C.accent, true);
      priceLbl.x = ax; priceLbl.y = ay;
      priceLbl.style.wordWrap = true; priceLbl.style.wordWrapWidth = Math.max(20, rightW);
      this.bodyLayer.addChild(priceLbl);
      ay += Math.max(26, priceLbl.height + 8);

      if (isAuction && auc.buyoutPrice) {
        const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), FS.tiny, C.mid);
        boLbl.x = ax; boLbl.y = ay;
        boLbl.style.wordWrap = true; boLbl.style.wordWrapWidth = Math.max(20, rightW);
        this.bodyLayer.addChild(boLbl);
        ay += Math.max(20, boLbl.height + 6);
      }

      // Countdown only makes sense for a live listing — closed history cells (sold/expired/cancelled) would
      // otherwise all read "0d 0h 0m 0s". Those show a status badge instead (My-Listings branch below).
      // Stacked right below the price/buyout block (not pinned to the card's bottom edge — that left a
      // dead gap and put it fighting the buy button for the same row, see 16.07.2026 "看起来太乱了" report)
      // and shown as days/hours/minutes/seconds since listings run up to 72h.
      if (auc.status === 'open') {
        const remainingSec = Math.max(0, Math.floor((auc.expireAt - now) / 1000));
        const d = Math.floor(remainingSec / 86400);
        const h = Math.floor((remainingSec % 86400) / 3600);
        const m = Math.floor((remainingSec % 3600) / 60);
        const s = remainingSec % 60;
        const expLbl = txt(t('auction.timeLeft', { d, h, m, s }), FS.tiny, C.mid);
        expLbl.x = ax; expLbl.y = ay;
        expLbl.style.wordWrap = true; expLbl.style.wordWrapWidth = Math.max(20, rightW);
        this.bodyLayer.addChild(expLbl);
      }

      // ── Bottom-right: action button / status badge ──
      const btnW = 96; const btnH = 40;
      const btnX = x + cellW - pad - btnW; const btnY = y + AUC_CELL_H - pad - btnH;

      if (this.activeTab === 'all') {
        const aucId = auc.auctionId;
        // Own listings can surface in the market (e.g. a designated-buyer listing the seller is
        // allowed to see, see listAuctions). Self-purchase/self-bid is rejected server-side
        // (sellerId===buyerId → BAD_REQUEST), so show a passive marker instead of a dead Buy/Bid button.
        if (auc.sellerId === this.cb.myAccountId) {
          const ownLbl = txt(t('auction.yourListing'), FS.small, C.mid);
          ownLbl.anchor.set(1, 0.5); ownLbl.x = btnX + btnW; ownLbl.y = btnY + btnH / 2;
          this.bodyLayer.addChild(ownLbl);
        } else {
          const btn = sketchButton(btnW, btnH, seedFor(y, 0, btnW));
          btn.x = btnX; btn.y = btnY;
          this.bodyLayer.addChild(btn);
          const bl = txt(isAuction ? t('auction.bid') : t('auction.buy'), FS.small, C.light);
          bl.anchor.set(0.5, 0.5); bl.x = btnX + btnW / 2; bl.y = btnY + btnH / 2;
          this.bodyLayer.addChild(bl);
          this.hitRects.push({
            rect: { x: btnX, y: btnY, w: btnW, h: btnH },
            action: isAuction ? () => this.openBidForm(auc) : () => this.confirmBuy(aucId, auc.price),
          });
        }
      } else if (this.activeTab === 'mine') {
        if (auc.status === 'open') {
          // Live listing → cancel action.
          const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xf0e0e0, border: C.red, seed: seedFor(y, 1, btnW) });
          cancelBtn.x = btnX; cancelBtn.y = btnY;
          this.bodyLayer.addChild(cancelBtn);
          const cl = txt(t('auction.cancel'), FS.small, C.red);
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
          const badge = txt(t(statusKey), FS.small, auc.status === 'sold' ? C.accent : C.mid, true);
          badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
          this.bodyLayer.addChild(badge);
        }
      } else {
        // My Bids: informational only (leading bidder, not the owner) — no action button, just a status badge.
        const badge = txt(t('auction.leading'), FS.small, C.accent, true);
        badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
        this.bodyLayer.addChild(badge);
      }
    }

    /**
     * Real per-item picture for a market cell (mirrors GachaScene.drawEntryPicture): equipment gets
     * its per-slot/rarity procedural glyph, cards get the real unit art PNG, materials keep their
     * dedicated icon glyph. Centered at (cx, cy) in a `size`×`size` box.
     */
    private renderItemPicture(auc: AuctionView, cx: number, cy: number, size: number, seed: number): void {
      if (auc.itemType === 'equipment') {
        const inst = auc.item?.['instance'] as EquipmentInstance | undefined;
        const def = inst ? getEquipDef(inst.defId) : undefined;
        if (def) {
          const icon = buildEquipIcon(inst?.defId, def.slot, def.rarity, size, seed);
          icon.x = cx; icon.y = cy;
          this.bodyLayer.addChild(icon);
          return;
        }
      } else if (auc.itemType === 'card') {
        const inst = auc.item?.['instance'] as CardInstance | undefined;
        const cardDef = inst ? CARD_DEFS[inst.defId] : undefined;
        const artUrl = cardDef ? UNIT_ART_URLS[cardDef.unitType] : undefined;
        if (artUrl) {
          const tex = getArtTexture(artUrl);
          if (tex.baseTexture.valid) {
            const scale = Math.min(size / tex.width, size / tex.height);
            const sp = new PIXI.Sprite(tex);
            sp.anchor.set(0.5);
            sp.scale.set(scale);
            sp.position.set(cx, cy);
            this.bodyLayer.addChild(sp);
            return;
          }
          if (!this.artHooked.has(artUrl)) {
            this.artHooked.add(artUrl);
            tex.baseTexture.once('loaded', () => this.render());
          }
        }
      }
      // Material listing (or an equipment/card def that vanished) → dedicated icon glyph fallback.
      const icon = buildIcon(this.itemKind(auc.itemType, auc.item?.['material'] as string | undefined), size, C.dark);
      icon.x = cx - size / 2; icon.y = cy - size / 2;
      this.bodyLayer.addChild(icon);
    }

    renderCreateButton(contentX: number): void {
      const { w, h } = this;
      const contentW = w - contentX;
      // 2x the previous 200x44 button.
      const btnW = 400; const btnH = 88;
      const btnY = h - btnH - 12;
      const btn = sketchButton(btnW, btnH, seedFor(0, 0, btnW));
      btn.x = contentX + contentW / 2 - btnW / 2; btn.y = btnY;
      this.bodyLayer.addChild(btn);
      const bl = txt(`+ ${t('auction.create')}`, FS.title, C.light);
      bl.anchor.set(0.5, 0.5); bl.x = contentX + contentW / 2; bl.y = btnY + btnH / 2;
      this.bodyLayer.addChild(bl);
      this.hitRects.push({ rect: { x: contentX + contentW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH }, action: () => this.openCreateForm() });
    }
  };
}
