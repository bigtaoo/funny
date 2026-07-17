// Bid modal for auction-mode listings: min-bid computation, the bid form, and placing the bid.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { t } from '../../i18n';
import { buildIcon } from '../../render/icons';
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
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const mw = Math.min(300, w - 30);
      const mh = 184;
      const mx = (w - mw) / 2;
      const my = (h - mh) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      let cy = my + 14;
      const titleLbl = txt(this.auctionLabel(auc), FS.tiny, C.dark);
      titleLbl.x = mx + 12; titleLbl.y = cy;
      ml.addChild(titleLbl);
      cy += 24;

      const curLbl = txt(`${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`, FS.micro, C.accent);
      curLbl.x = mx + 12; curLbl.y = cy;
      ml.addChild(curLbl);
      cy += 20;

      if (auc.buyoutPrice) {
        const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), FS.micro, C.mid);
        boLbl.x = mx + 12; boLbl.y = cy;
        ml.addChild(boLbl);
        cy += 18;
      }

      this.addNumInput(ml, mx, cy + 6, t('auction.bid') + ':', this.bidAmount, (v) => { this.bidAmount = Math.max(minBid, v); this.openBidForm(auc); });

      const okBtn = sketchButton(80, 28, seedFor(0, 3, 80));
      okBtn.x = mx + mw / 2 - 88; okBtn.y = my + mh - 36;
      ml.addChild(okBtn);
      const ol = txt(t('auction.bid'), FS.tiny, C.light);
      ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = my + mh - 22;
      ml.addChild(ol);
      this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: () => this.confirmBid(auc) });

      const caBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 4, 80) });
      caBtn.x = mx + mw / 2 + 8; caBtn.y = my + mh - 36;
      ml.addChild(caBtn);
      const cl = buildIcon('close', 14, C.dark);
      cl.x = mx + mw / 2 + 48 - 7; cl.y = my + mh - 22 - 7;
      ml.addChild(cl);
      this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeBidModal() });
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
