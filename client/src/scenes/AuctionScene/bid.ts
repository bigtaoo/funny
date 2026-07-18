// Bid modal for auction-mode listings: min-bid computation, the bid form, and placing the bid.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { t } from '../../i18n';
import { WorldApiError, type AuctionView } from '../../net/WorldApiClient';
import { type Constructor, type AuctionSceneBaseCtor } from './base';

export interface BidHandlers {
  openBidForm(auc: AuctionView): void;
  confirmBid(auc: AuctionView): void;
  doBid(auctionId: string, amount: number): Promise<void>;
  closeBidModal(): void;
}

export function BidMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<BidHandlers> {
  return class extends Base {
    /** auc.price = the current highest bid (when a bid exists) or the starting price. With a bid, the new bid must be at least +5% higher (server-authoritative). */
    private minBidFor(auc: AuctionView): number {
      return auc.topBid ? Math.max(auc.price + 1, Math.ceil(auc.price * 1.05)) : auc.price;
    }

    openBidForm(auc: AuctionView): void {
      const fresh = this.bidAuction?.auctionId !== auc.auctionId;
      const minBid = this.minBidFor(auc);
      this.bidAuction = auc;
      if (fresh) this.bidAmount = minBid;
      this.bidAmount = Math.max(this.bidAmount, minBid);

      const { w, h } = this;
      const ml = this.modalLayer;
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;

      const hasBuyout = !!auc.buyoutPrice;
      // 2x the original hand-tuned panel (mw 300 / mh 184), to fit the quick-add row + buyout button.
      const mw = Math.min(600, w - 60);
      const mh = 276 + (hasBuyout ? 80 : 0);
      const mx = (w - mw) / 2;
      const my = (h - mh) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 26;
      const titleLbl = txt(this.auctionLabel(auc), FS.bodyLg, C.dark, true);
      titleLbl.x = mx + 24; titleLbl.y = cy;
      ml.addChild(titleLbl);
      cy += 36;

      const curLbl = txt(`${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`, FS.body, C.accent);
      curLbl.x = mx + 24; curLbl.y = cy;
      ml.addChild(curLbl);
      cy += 32;

      if (auc.buyoutPrice) {
        const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), FS.tiny, C.mid);
        boLbl.x = mx + 24; boLbl.y = cy;
        ml.addChild(boLbl);
        cy += 28;
      }

      this.addNumInput(ml, mx + 12, cy, t('auction.bid') + ':', this.bidAmount, (v) => { this.bidAmount = Math.max(minBid, v); this.openBidForm(auc); }, 1.5);
      cy += 50;

      // Quick-add buttons: +1 / +5 / +10 on top of the current bid amount.
      const stepBtnW = 84; const stepBtnH = 40; const stepGap = 14;
      const stepsTotalW = stepBtnW * 3 + stepGap * 2;
      let stepX = mx + mw / 2 - stepsTotalW / 2;
      for (const [i, step] of [1, 5, 10].entries()) {
        const stepBtn = sketchPanel(stepBtnW, stepBtnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(cy, i, stepBtnW) });
        stepBtn.x = stepX; stepBtn.y = cy;
        ml.addChild(stepBtn);
        const stepLbl = txt(`+${step}`, FS.body, C.dark);
        stepLbl.anchor.set(0.5, 0.5); stepLbl.x = stepX + stepBtnW / 2; stepLbl.y = cy + stepBtnH / 2;
        ml.addChild(stepLbl);
        this.modalHits.push({ rect: { x: stepX, y: cy, w: stepBtnW, h: stepBtnH }, action: () => { this.bidAmount = Math.max(minBid, this.bidAmount + step); this.openBidForm(auc); } });
        stepX += stepBtnW + stepGap;
      }
      cy += stepBtnH + 16;

      if (auc.buyoutPrice) {
        const boBtnW = mw - 48; const boBtnH = 48;
        const boBtn = sketchPanel(boBtnW, boBtnH, { fill: 0xfff3d6, border: C.accent, seed: seedFor(cy, 0, boBtnW) });
        boBtn.x = mx + 24; boBtn.y = cy;
        ml.addChild(boBtn);
        const boLbl = txt(t('auction.buyoutNow').replace('{price}', String(auc.buyoutPrice)), FS.body, C.accent, true);
        boLbl.anchor.set(0.5, 0.5); boLbl.x = mx + 24 + boBtnW / 2; boLbl.y = cy + boBtnH / 2;
        ml.addChild(boLbl);
        const buyoutPrice = auc.buyoutPrice;
        this.modalHits.push({ rect: { x: boBtn.x, y: boBtn.y, w: boBtnW, h: boBtnH }, action: () => { this.bidAmount = buyoutPrice; this.confirmBid(auc); } });
      }

      // Bid/Cancel buttons, sized to match the unified confirm dialog's button convention.
      const btnW = 126; const btnH = 42;
      const btnY = my + mh - 16 - btnH;
      const okBtn = sketchButton(btnW, btnH, seedFor(0, 3, btnW));
      okBtn.x = mx + mw / 2 - 12 - btnW; okBtn.y = btnY;
      ml.addChild(okBtn);
      const ol = txt(t('auction.bid'), FS.bodyLg, C.light, true);
      ol.anchor.set(0.5, 0.5); ol.x = okBtn.x + btnW / 2; ol.y = okBtn.y + btnH / 2;
      ml.addChild(ol);
      this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: btnW, h: btnH }, action: () => this.confirmBid(auc) });

      const caBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 4, btnW) });
      caBtn.x = mx + mw / 2 + 12; caBtn.y = btnY;
      ml.addChild(caBtn);
      const cl = txt(t('common.cancel'), FS.bodyLg, C.dark);
      cl.anchor.set(0.5, 0.5); cl.x = caBtn.x + btnW / 2; cl.y = caBtn.y + btnH / 2;
      ml.addChild(cl);
      this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: btnW, h: btnH }, action: () => this.closeBidModal() });
    }

    confirmBid(auc: AuctionView): void {
      const amount = this.bidAmount;
      const msg = t('auction.confirmBid').replace('{price}', String(amount));
      this.showConfirmModal(msg, () => void this.doBid(auc.auctionId, amount));
    }

    async doBid(auctionId: string, amount: number): Promise<void> {
      this.closeBidModal();
      try {
        await this.cb.worldApi.placeBid(auctionId, amount);
        this.showToast(t('auction.bidPlaced'));
        await this.loadData();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
        // Auction ended in the poll gap (bought out / expired) — refresh so the stale card drops off.
        if (e instanceof WorldApiError && (e.code === 'AUCTION_CLOSED' || e.code === 'AUCTION_NOT_FOUND')) {
          await this.loadData();
        }
      }
    }

    closeBidModal(): void {
      this.bidAuction = null;
      this.closeModal();
    }
  };
}
