// Network actions for the roster: feed, lock/unlock, injury recover. Each wraps the callback in a
// BusyTracker + withTimeout guard, shows a toast on success/failure, and re-renders.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import { type Constructor, type CardSceneBaseCtor } from './base';

export interface ActionHandlers {
  doFeed(targetId: string, materialIds: string[]): Promise<void>;
  doSetLock(cardId: string, locked: boolean): Promise<void>;
  doRecover(cardId: string): Promise<void>;
}

export function ActionsMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<ActionHandlers> {
  return class extends Base {
    async doFeed(targetId: string, materialIds: string[]): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      this.closeModal();
      this.render();
      try {
        const res = await withTimeout(this.cb.feedCards(targetId, materialIds));
        if (res.ok) {
          this.showToast(t('roster.feedOk'), C.green);
        } else {
          this.showToast(t(res.key), C.red);
        }
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.feedErr'), C.red);
      } finally {
        this.bt.stop();
        this.detailId = null;
        this.render();
      }
    }

    async doSetLock(cardId: string, locked: boolean): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start(); this.render();
      try {
        const res = await withTimeout(this.cb.setCardLock(cardId, locked));
        if (res.ok) this.showToast(locked ? t('roster.lockOk') : t('roster.unlockOk'), C.green);
        else this.showToast(t(res.key), C.red);
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.err.generic'), C.red);
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    async doRecover(cardId: string): Promise<void> {
      if (this.bt.busy || !this.cb.recoverCard) return;
      this.bt.start(); this.render();
      try {
        const res = await withTimeout(this.cb.recoverCard(cardId));
        if (res.ok) this.showToast(t('roster.recoverOk'), C.green);
        else this.showToast(t(res.key), C.red);
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.recoverErr'), C.red);
      } finally {
        this.bt.stop();
        this.detailId = null;
        this.render();
      }
    }
  };
}
