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
import type { FamilySceneCore } from './core';
import type { DataHandlers } from './data';

export interface ActionsHandlers {
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmKick(targetId: string, name: string): void;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  openJoinRequests(): void;
}

export class ActionsPanel implements ActionsHandlers {
  constructor(private readonly core: FamilySceneCore, private readonly data: DataHandlers) {}

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
      this.showPickModal(list);
    } catch (e) {
      core.showToast(core.errorMsg(e), C.red);
    }
  }

  private showPickModal(families: FamilyView[]): void {
    const core = this.core;
    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;

    const mw = Math.min(300, w - 32);
    const mh = Math.min(300, h - 80);
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => core.closeModal() });

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    if (families.length === 0) {
      const lbl = txt(t('family.noFamily'), FS.tiny, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    let cy = my + 10;
    for (const fam of families.slice(0, 6)) {
      const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
      row.x = mx + 8; row.y = cy;
      ml.addChild(row);
      const lbl = txt(`[${fam.tag}] ${fam.name} (${fam.memberCount})`, FS.tiny, C.dark);
      lbl.x = mx + 14; lbl.y = cy + 10;
      ml.addChild(lbl);
      const famId = fam.familyId;
      core.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => void this.doJoin(famId) });
      cy += 40;
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
    this.showJoinRequestsModal();
  }

  // 2x the size of every other confirm-style modal in this scene — approving/rejecting a
  // join request is a more consequential action (changes the roster) and was easy to miss
  // at the old, small size (user feedback 2026-07-18).
  private showJoinRequestsModal(): void {
    const core = this.core;
    const { w, h } = core;
    const ml = core.modalLayer;
    tearDownChildren(ml); // free prior modal Text (title/rows/labels) — bare removeChildren orphaned them
    core.modalHits = [];
    core.modalOpen = true;

    const mw = Math.min(680, w - 32);
    const mh = Math.min(720, h - 80);
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => core.closeModal() });

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const title = txt(t('family.pendingRequests', { n: core.joinRequests.length }), FS.heading * 2, C.dark, true);
    title.x = mx + 24; title.y = my + 20;
    ml.addChild(title);

    if (core.joinRequests.length === 0) {
      const lbl = txt(t('family.noPendingRequests'), FS.tiny * 2, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    const busy = core.bt.busy;
    let cy = my + 80;
    for (const reqv of core.joinRequests) {
      const row = sketchPanel(mw - 32, 80, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 32) });
      row.x = mx + 16; row.y = cy;
      ml.addChild(row);
      const nameLbl = txt(reqv.displayName ?? reqv.publicId ?? reqv.accountId, FS.tiny * 2, C.dark);
      nameLbl.x = mx + 28; nameLbl.y = cy + 24;
      ml.addChild(nameLbl);

      // Button width follows the measured label width (not a fixed literal) — locales like
      // German ("Ablehnen"/"Annehmen") run longer than English and would clip a fixed box.
      const btnH = 52, gap = 12, btnPadX = 28;
      const approveColor = busy ? C.mid : 0x2f6b2f;
      const rejectColor = busy ? C.mid : C.red;
      const al = txt(t('family.approve'), FS.label * 2, approveColor);
      const approveW = al.width + btnPadX * 2;
      const rl = txt(t('family.reject'), FS.label * 2, rejectColor);
      const rejectW = rl.width + btnPadX * 2;

      const rejectX = mx + mw - 16 - rejectW;
      const approveX = rejectX - gap - approveW;

      const approveBtn = sketchPanel(approveW, btnH, { fill: 0xe0f0e0, border: approveColor, seed: seedFor(cy, 1, approveW) });
      approveBtn.x = approveX; approveBtn.y = cy + 14;
      ml.addChild(approveBtn);
      al.anchor.set(0.5, 0.5); al.x = approveX + approveW / 2; al.y = cy + 14 + btnH / 2;
      ml.addChild(al);
      const rid = reqv.requestId;
      if (!busy) core.modalHits.push({ rect: { x: approveX, y: cy + 14, w: approveW, h: btnH }, action: () => void this.doRespondJoinRequest(rid, true) });

      const rejectBtn = sketchPanel(rejectW, btnH, { fill: 0xf0e0e0, border: rejectColor, seed: seedFor(cy, 2, rejectW) });
      rejectBtn.x = rejectX; rejectBtn.y = cy + 14;
      ml.addChild(rejectBtn);
      rl.anchor.set(0.5, 0.5); rl.x = rejectX + rejectW / 2; rl.y = cy + 14 + btnH / 2;
      ml.addChild(rl);
      if (!busy) core.modalHits.push({ rect: { x: rejectX, y: cy + 14, w: rejectW, h: btnH }, action: () => void this.doRespondJoinRequest(rid, false) });

      cy += 88;
    }
  }

  private async doRespondJoinRequest(requestId: string, accept: boolean): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.bt.start();
    this.showJoinRequestsModal(); // redraw immediately so approve/reject grey out while in flight
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
        if (core.joinRequests.length > 0) this.showJoinRequestsModal();
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
}
