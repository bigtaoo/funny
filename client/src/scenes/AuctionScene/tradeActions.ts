// Buy-now and cancel-listing actions (market row buttons), each gated behind a confirm modal.
import { ui as C } from '../../render/sketchUi';
import { t } from '../../i18n';
import { WorldApiError } from '../../net/WorldApiClient';
import { type Constructor, type AuctionSceneBaseCtor } from './base';

export interface TradeActionsHandlers {
  confirmBuy(auctionId: string, price: number): void;
  doBuy(auctionId: string): Promise<void>;
  confirmCancel(auctionId: string): void;
  doCancel(auctionId: string): Promise<void>;
}

export function TradeActionsMixin<TBase extends AuctionSceneBaseCtor>(Base: TBase): TBase & Constructor<TradeActionsHandlers> {
  return class extends Base {
    confirmBuy(auctionId: string, price: number): void {
      const msg = t('auction.confirmBuy').replace('{price}', String(price));
      this.showConfirmModal(msg, () => void this.doBuy(auctionId));
    }

    async doBuy(auctionId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.buyAuction(auctionId);
        this.showToast(t('auction.bought'));
        await Promise.all([this.loadData(), this.cb.reloadSave?.()]);
      } catch (e) {
        // Lost the race: another buyer took it (or it closed/expired) in the poll gap since our snapshot.
        // Refresh so the now-stale card drops off, and tell the user plainly it's gone.
        if (e instanceof WorldApiError && (e.code === 'AUCTION_CLOSED' || e.code === 'AUCTION_NOT_FOUND')) {
          this.showToast(t('auction.err.soldOut'), C.red);
          await this.loadData();
        } else {
          this.showToast(this.errorMsg(e), C.red);
        }
      }
    }

    confirmCancel(auctionId: string): void {
      this.showConfirmModal(t('auction.confirmCancel'), () => void this.doCancel(auctionId));
    }

    async doCancel(auctionId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.cancelAuction(auctionId);
        this.showToast(t('auction.cancelled'));
        await this.loadData();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }
  };
}
