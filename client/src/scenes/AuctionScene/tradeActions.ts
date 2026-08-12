// Buy-now and cancel-listing actions (market row buttons), each gated behind a confirm modal.
// Converted from TradeActionsMixin(Base) to composition (2026-08-11) — see core.ts's file-header comment.
import { ui as C } from '../../render/sketchUi';
import { t } from '../../i18n';
import { WorldApiError } from '../../net/WorldApiClient';
import type { AuctionSceneCore } from './core';
import { withTimeout } from '../../ui/busyTracker';

export class TradeActionsPanel {
  constructor(private readonly core: AuctionSceneCore) {}

  confirmBuy(auctionId: string, price: number): void {
    const msg = t('auction.confirmBuy').replace('{price}', String(price));
    this.core.showConfirmModal(msg, () => void this.doBuy(auctionId));
  }

  async doBuy(auctionId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.buyAuction(auctionId));
      core.showToast(t('auction.bought'));
      await Promise.all([core.loadData(), core.cb.reloadSave?.()]);
    } catch (e) {
      // Lost the race: another buyer took it (or it closed/expired) in the poll gap since our snapshot.
      // Refresh so the now-stale card drops off, and tell the user plainly it's gone.
      if (e instanceof WorldApiError && (e.code === 'AUCTION_CLOSED' || e.code === 'AUCTION_NOT_FOUND')) {
        core.showToast(t('auction.err.soldOut'), C.red);
        await core.loadData();
      } else {
        core.showToast(core.errorMsg(e), C.red);
      }
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmCancel(auctionId: string): void {
    this.core.showConfirmModal(t('auction.confirmCancel'), () => void this.doCancel(auctionId));
  }

  async doCancel(auctionId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.cancelAuction(auctionId));
      core.showToast(t('auction.cancelled'));
      await core.loadData();
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }
}
