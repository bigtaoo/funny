// Network actions for the roster: fuse, lock/unlock, injury recover. Each wraps the callback in a
// BusyTracker + withTimeout guard, shows a toast on success/failure, and re-renders. Depends on
// FeedPanel (via the narrow PlayFusionAnimSource — only playFusionAnim, not the whole feed surface)
// for the fusion animation played after a successful fuse.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import { CardSceneCore } from './core';

/** The one method ActionsPanel needs from FeedPanel — narrowed per claudedocs/client-modules.md's
 *  composition rule (constructor takes the smallest interface that covers the actual cross-domain
 *  call, not the whole sibling class). */
export interface PlayFusionAnimSource {
  playFusionAnim(): Promise<void>;
}

/** Network-actions domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class ActionsPanel {
  constructor(
    private readonly core: CardSceneCore,
    private readonly feed: PlayFusionAnimSource,
  ) {}

  /**
   * `onSettled`, when given, replaces the default "close the modal" finish: it's called with whether
   * the fuse succeeded and owns deciding what happens to the fusion panel next (feed.ts uses this to
   * auto-continue onto another same-level target instead of closing — CHARACTER_CARDS_DESIGN §3.2).
   */
  async doFuse(targetId: string, materialIds: string[], onSettled?: (success: boolean) => void): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start();
    // Redraw the fusion ring itself (busy → Fuse disabled) instead of a full core.render(), which
    // would re-open the underlying card detail modal (detailId stays set through this whole flow)
    // and blow away the ring — the animation needs to play over the ring, not the detail popup.
    // fuseInProgress additionally suppresses the busy-dots re-render that update() would otherwise
    // fire every 0.4s (same teardown, but mid-animation it destroys the live VFX graphics).
    core.fuseInProgress = true;
    core.feedRedraw?.();
    let success = false;
    try {
      const res = await withTimeout(core.cb.fuseCards(targetId, materialIds));
      if (res.ok) {
        success = true;
        await this.feed.playFusionAnim();
        core.showToast(t('roster.fuseOk'), C.green);
      } else {
        core.showToast(t(res.key), C.red);
      }
    } catch (e) {
      core.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.fuseErr'), C.red);
    } finally {
      core.bt.stop();
      core.fuseInProgress = false;
      if (onSettled) {
        onSettled(success);
      } else {
        core.closeModal();
        core.detailId = null;
        core.render();
      }
    }
  }

  async doSetLock(cardId: string, locked: boolean): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start(); core.render();
    try {
      const res = await withTimeout(core.cb.setCardLock(cardId, locked));
      if (res.ok) core.showToast(locked ? t('roster.lockOk') : t('roster.unlockOk'), C.green);
      else core.showToast(t(res.key), C.red);
    } catch (e) {
      core.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.err.generic'), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async doRecover(cardId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy || !core.cb.recoverCard) return;
    core.bt.start(); core.render();
    try {
      const res = await withTimeout(core.cb.recoverCard(cardId));
      if (res.ok) core.showToast(t('roster.recoverOk'), C.green);
      else core.showToast(t(res.key), C.red);
    } catch (e) {
      core.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'roster.recoverErr'), C.red);
    } finally {
      core.bt.stop();
      core.detailId = null;
      core.render();
    }
  }
}
