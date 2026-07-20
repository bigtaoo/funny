// Network actions for the roster: fuse, lock/unlock, injury recover. Each wraps the callback in a
// BusyTracker + withTimeout guard, shows a toast on success/failure, and re-renders.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import { type Constructor, type CardSceneBaseCtor } from './base';

export interface ActionHandlers {
  /**
   * `onSettled`, when given, replaces the default "close the modal" finish: it's called with whether
   * the fuse succeeded and owns deciding what happens to the fusion panel next (feed.ts uses this to
   * auto-continue onto another same-level target instead of closing — CHARACTER_CARDS_DESIGN §3.2).
   */
  doFuse(targetId: string, materialIds: string[], onSettled?: (success: boolean) => void): Promise<void>;
  doSetLock(cardId: string, locked: boolean): Promise<void>;
  doRecover(cardId: string): Promise<void>;
}

export function ActionsMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<ActionHandlers> {
  return class extends Base {
    async doFuse(targetId: string, materialIds: string[], onSettled?: (success: boolean) => void): Promise<void> {
      if (this.bt.busy) return;
      this.bt.start();
      // Redraw the fusion ring itself (busy → Fuse disabled) instead of a full this.render(), which
      // would re-open the underlying card detail modal (detailId stays set through this whole flow)
      // and blow away the ring — the animation needs to play over the ring, not the detail popup.
      this.feedRedraw?.();
      let success = false;
      try {
        const res = await withTimeout(this.cb.fuseCards(targetId, materialIds));
        if (res.ok) {
          success = true;
          await this.playFusionAnim?.();
          this.showToast(t('roster.fuseOk'), C.green);
        } else {
          this.showToast(t(res.key), C.red);
        }
      } catch (e) {
        this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.fuseErr'), C.red);
      } finally {
        this.bt.stop();
        if (onSettled) {
          onSettled(success);
        } else {
          this.closeModal();
          this.detailId = null;
          this.render();
        }
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
