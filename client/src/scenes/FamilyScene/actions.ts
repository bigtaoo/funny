// Network actions + confirm/pick modals for the family scene: create, join, leave, dissolve, kick, set-role.
//
// ActionsPanel depends on DataPanel (via the narrow DataHandlers interface — loadMyFamily), but
// Data has no dependency back on Actions: one-way, so a plain independent class over `core` + `data`
// (2026-08-11 converted from the former `XMixin(Base)` inheritance chain, per
// claudedocs/client-modules.md's split-form priority note). RenderPanel depends on Actions in turn.
//
// Sending a channel message (submitMessage/doSendMsg) used to live here and call back into
// input.ts's openSendInput() — see core.ts's file-header comment for why that pair moved to
// InputPanel instead of staying split across Actions/Input.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import type { FamilyView } from '../../net/WorldApiClient';
import { withTimeout } from '../../ui/busyTracker';
import { EMBLEM_KEYS, EMBLEM_COLORS, loadEmblemAtlas, type EmblemKey } from '../../render/emblemIcon';
import { drawEmblemPickerDialog, type EmblemPickerState } from '../../ui/dialogs/emblemPickerDialog';
import type { FamilySceneCore } from './core';
import type { DataHandlers } from './data';
import { drawFamilyPickModal, drawJoinRequestsModal } from './modals';

export interface ActionsHandlers {
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmKick(targetId: string, name: string): void;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  openJoinRequests(): void;
  openEmblemPicker(): void;
}

export class ActionsPanel implements ActionsHandlers {
  constructor(private readonly core: FamilySceneCore, private readonly data: DataHandlers) {}

  /** In-progress pick for the emblem-picker modal (see emblemPickerDialog.ts) — reset each time the modal opens. */
  private pendingEmblem: EmblemPickerState = { key: EMBLEM_KEYS[0], color: EMBLEM_COLORS[0] };

  async doCreate(): Promise<void> {
    const core = this.core;
    if (!core.createName.trim() || !core.createTag.trim()) {
      core.showToast(t('family.err.badTag'), C.red); return;
    }
    if (core.bt.busy) return;
    core.bt.start();
    core.render();
    try {
      core.family = await withTimeout(core.cb.worldApi.createFamily(core.createName.trim(), core.createTag.trim()));
      core.members = core.family.members ?? [];
      core.messages = [];
      core.mode = 'myFamily';
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async openJoinList(): Promise<void> {
    const core = this.core;
    try {
      const list = await core.cb.worldApi.listFamilies();
      drawFamilyPickModal(core, list, (familyId) => void this.doJoin(familyId));
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  private async doJoin(familyId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.requestJoinFamily(familyId));
      core.showToast(t('family.joinRequested'), C.dark);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  openJoinRequests(): void {
    this.openRequestsModal();
  }

  /** (Re)draw the approval sheet — `keepScroll` on the in-flight repaint so greying the buttons
   *  doesn't scroll a long backlog back to the top. See ./modals.ts. */
  private openRequestsModal(keepScroll = false): void {
    drawJoinRequestsModal(this.core, (requestId, accept) => void this.doRespondJoinRequest(requestId, accept), keepScroll);
  }

  private async doRespondJoinRequest(requestId: string, accept: boolean): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start();
    this.openRequestsModal(true); // redraw immediately so approve/reject grey out while in flight
    try {
      await withTimeout(core.cb.worldApi.respondJoinRequest(requestId, accept));
      core.showToast(t(accept ? 'family.requestApproved' : 'family.requestRejected'), C.dark);
      if (accept && core.family) {
        // Roster changed — refetch (also refreshes joinRequests) and close, since the modal's
        // row list is now stale.
        await this.data.loadMyFamily(core.family.familyId);
        core.closeModal();
      } else {
        core.joinRequests = core.joinRequests.filter((r) => r.requestId !== requestId);
      }
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      if (core.modalOpen) {
        if (core.joinRequests.length > 0) this.openRequestsModal(true);
        else core.closeModal();
      }
    }
  }

  confirmLeave(): void {
    this.core.showConfirm(t('family.confirmLeave'), () => void this.doLeave());
  }

  private async doLeave(): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    if (!core.family) return;
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.leaveFamily());
      core.family = null; core.members = []; core.messages = [];
      core.mode = 'noFamily';
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmDissolve(): void {
    this.core.showConfirm(t('family.confirmDissolve'), () => void this.doDissolve());
  }

  private async doDissolve(): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    if (!core.family) return;
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.dissolveFamily());
      core.family = null; core.members = []; core.messages = [];
      core.mode = 'noFamily';
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  confirmKick(targetId: string, name: string): void {
    this.core.showConfirm(t('family.confirmKick'), () => void this.doKick(targetId));
  }

  private async doKick(targetId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.closeModal();
    if (!core.family) return;
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.kickMember(targetId));
      core.members = core.members.filter(m => m.accountId !== targetId);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  async doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void> {
    const core = this.core;
    if (!core.family || core.bt.busy) return;
    core.bt.start();
    core.render();
    try {
      await withTimeout(core.cb.worldApi.setRole(targetId, role));
      const m = core.members.find(mem => mem.accountId === targetId);
      if (m) m.role = role;
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  /** Leader-only (family-emblem-art-prompts.md, 2026-08-14): opens the shared emblem-picker modal
   *  seeded with the family's current badge (or the first key/colour if none chosen yet). */
  openEmblemPicker(): void {
    const core = this.core;
    if (!core.family || !core.isFamilyLeader) return;
    this.pendingEmblem = {
      key: (core.family.emblemKey as EmblemKey | undefined) ?? EMBLEM_KEYS[0],
      color: core.family.emblemColor ?? EMBLEM_COLORS[0],
    };
    core.modalOpen = true;
    // Atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts) — the dialog draws a tinted placeholder
    // per cell until this resolves, then redraws with the real icons.
    void loadEmblemAtlas().then(() => { if (core.modalOpen) this.redrawEmblemPicker(); }).catch(() => { /* placeholder stays */ });
    this.redrawEmblemPicker();
  }

  /** Redraws the emblem-picker modal in place — called after every tap (pick icon/colour) and while
   *  the confirm POST is in flight, mirroring showJoinRequestsModal's self-redraw pattern above. */
  private redrawEmblemPicker(): void {
    const core = this.core;
    core.modalHits = drawEmblemPickerDialog(
      core.modalLayer, core.w, core.h, this.pendingEmblem, core.bt.busy,
      (key) => { this.pendingEmblem = { ...this.pendingEmblem, key }; this.redrawEmblemPicker(); },
      (color) => { this.pendingEmblem = { ...this.pendingEmblem, color }; this.redrawEmblemPicker(); },
      () => void this.doSetEmblem(),
      () => core.closeModal(),
    );
  }

  private async doSetEmblem(): Promise<void> {
    const core = this.core;
    if (core.bt.busy || !core.family) return;
    core.bt.start();
    this.redrawEmblemPicker();
    try {
      const { key, color } = this.pendingEmblem;
      await withTimeout(core.cb.worldApi.setFamilyEmblem(key, color));
      core.family = { ...core.family, emblemKey: key, emblemColor: color };
      core.closeModal();
      core.showToast(t('family.emblemUpdated'), C.dark);
      core.render(); // header/info-band badge needs the fresh family object
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    } finally {
      core.bt.stop();
      if (core.modalOpen) this.redrawEmblemPicker();
    }
  }
}
