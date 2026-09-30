/**
 * Stage-level mount for the player-safety overlays (App Review 1.2 — see ui/moderation.ts): the
 * report dialog, the block confirmation, the blocked-players list, and a player card for surfaces
 * that have no ProfilePopup of their own.
 *
 * Same stage-level reasoning as app.ts's appeal/feedback/subscription dialogs: these open from any
 * scene (world chat, family, sect, DM, mail…) and must not be torn down by — or tear down — the
 * scene underneath. Two differences from those:
 *
 *  * They draw in DESIGN space under a container carrying `gameLayer`'s transform, so a card opened
 *    from an in-scene ProfilePopup keeps the same size and font floor; a screen-sized dim underneath
 *    covers the letterbox bands too.
 *  * One overlay at a time: report/block usually open *from* the player card, so a new request
 *    replaces whatever is up. `input.holdForModal(true)` is raised once per mount and released once
 *    per close (exactly-once, guarded by the `current` slot), the same gate the other dialogs use so
 *    a tap on the dialog never also reaches the scene's InputManager hit-rects.
 *  * Taps are delivered to the overlay through the InputManager's modal-tap channel (design-space
 *    coordinates, the same DOM-fed path every scene relies on) as well as the overlays' own PIXI
 *    `pointertap`s — on the web build the latter never reached this transformed stage-level
 *    container at all (checked in Chrome, 2026-09-29), so the manual path is the one that counts;
 *    each overlay dedupes a tap that arrives both ways (ProfilePopup.handleTap / ModerationCard.fire).
 */
import * as PIXI from 'pixi.js-legacy';
import { ProfilePopup } from './ProfilePopup';
import { ReportDialog, BlockConfirmDialog, BlockedPlayersDialog } from './ModerationDialogs';
import {
  setModerationSink, submitReport, confirmBlock, unblockPlayer, reloadBlockedPlayers, blockedPlayers,
  type ModerationRequest,
} from '../moderation';
import { showToastMessage } from '../../net/log';
import { t } from '../../i18n/index';

export interface ModerationHostDeps {
  stage: PIXI.Container;
  /** Screen size in stage units (app.screen). */
  screen(): { width: number; height: number };
  /** The contain-scaled game layer whose transform the overlay copies. */
  gameLayer: PIXI.Container;
  /** Design-space size the overlay lays out in. */
  designSize(): { w: number; h: number };
  input: {
    holdForModal(on: boolean): void;
    onModalTap(fn: (x: number, y: number) => void): () => void;
  };
}

interface Mounted {
  root: PIXI.Container;
  destroy(): void;
  /** Design-space tap from the InputManager modal channel. */
  tap(x: number, y: number): void;
}

interface Built {
  node: PIXI.Container;
  destroy(): void;
  tap(x: number, y: number): void;
}

export interface ModerationHost {
  /** Close whatever is up (no-op when nothing is). */
  close(): void;
  /** Whether an overlay is currently mounted. */
  readonly isOpen: boolean;
}

export function installModerationHost(deps: ModerationHostDeps): ModerationHost {
  const { stage, input } = deps;
  let current: Mounted | null = null;

  const close = (): void => {
    if (!current) return;
    const m = current;
    current = null;
    stage.removeChild(m.root);
    // Deferred: close usually runs from inside the overlay's own pointertap, and destroying the
    // node PIXI is still dispatching on is asking for a null deref in the event boundary.
    setTimeout(() => m.destroy(), 0);
    input.holdForModal(false);
  };

  /** Close `root` only if it is still the mounted overlay (a replaced card's late hide must not close its successor). */
  const closeIf = (root: PIXI.Container): void => { if (current?.root === root) close(); };

  const mount = (build: (w: number, h: number, root: PIXI.Container) => Built): void => {
    close();
    const { width, height } = deps.screen();
    const root = new PIXI.Container();
    root.name = 'overlay:moderation';
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.25).drawRect(0, 0, width, height).endFill();
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, width, height);
    root.addChild(dim);
    const inner = new PIXI.Container();
    inner.scale.set(deps.gameLayer.scale.x, deps.gameLayer.scale.y);
    inner.position.set(deps.gameLayer.x, deps.gameLayer.y);
    root.addChild(inner);
    const { w, h } = deps.designSize();
    const built = build(w, h, root);
    inner.addChild(built.node);
    stage.addChild(root);
    current = { root, destroy: () => { built.destroy(); root.destroy({ children: true }); }, tap: (x, y) => built.tap(x, y) };
    input.holdForModal(true);
  };

  const open = (req: ModerationRequest): void => {
    switch (req.kind) {
      case 'card':
        mount((w, h, root) => {
          const popup = new ProfilePopup(w, h);
          popup.onHide = () => closeIf(root);
          popup.show({
            name: req.target.name,
            publicId: req.target.publicId,
            ...(req.target.avatarId ? { avatarId: req.target.avatarId } : {}),
            actions: req.actions,
          });
          return {
            node: popup.container,
            destroy: () => { popup.onHide = null; popup.destroy(); },
            tap: (x, y) => { popup.handleTap(x, y); },
          };
        });
        return;
      case 'report':
        mount((w, h, root) => {
          const dlg = new ReportDialog(w, h, req.target, {
            onSubmit: async (category) => {
              await submitReport(req.target, category);
              showToastMessage(t('moderation.reportSent'), 'success');
            },
            onClose: () => closeIf(root),
          });
          return { node: dlg.container, destroy: () => dlg.destroy(), tap: (x, y) => dlg.handleTap(x, y) };
        });
        return;
      case 'block':
        mount((w, h, root) => {
          const dlg = new BlockConfirmDialog(w, h, req.target, {
            onConfirm: () => {
              // Hidden the moment Block is tapped (confirmBlock marks it locally before the request),
              // so the dialog closes straight away rather than waiting on the round trip.
              closeIf(root);
              confirmBlock(req.target).then(
                () => showToastMessage(t('moderation.blockDone', { name: req.target.name }), 'success'),
                () => showToastMessage(t('moderation.blockFailed'), 'error'),
              );
            },
            onClose: () => closeIf(root),
          });
          return { node: dlg.container, destroy: () => dlg.destroy(), tap: (x, y) => dlg.handleTap(x, y) };
        });
        return;
      case 'blockedList':
        mount((w, h, root) => {
          const dlg = new BlockedPlayersDialog(w, h, blockedPlayers(), {
            load: () => reloadBlockedPlayers(),
            onUnblock: async (p) => {
              try {
                await unblockPlayer(p.publicId);
                showToastMessage(t('moderation.unblockDone', { name: p.displayName || `#${p.publicId}` }), 'success');
              } catch (e) {
                showToastMessage(t('moderation.unblockFailed'), 'error');
                throw e;
              }
            },
            onClose: () => closeIf(root),
          });
          return { node: dlg.container, destroy: () => dlg.destroy(), tap: (x, y) => dlg.handleTap(x, y) };
        });
        return;
    }
  };

  // Only the overlay mounted at the moment of the tap receives it; a tap that replaces it (card →
  // report) is not re-delivered to the replacement.
  input.onModalTap((x, y) => { current?.tap(x, y); });
  setModerationSink(open);
  return {
    close,
    get isOpen() { return current !== null; },
  };
}
