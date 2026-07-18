// Network actions + confirm/pick modals for the family scene: create, join, leave, dissolve, kick, set-role.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import type { FamilyView, FamilyMessageView } from '../../net/WorldApiClient';
import { type Constructor, type FamilySceneBaseCtor } from './base';

export interface ActionHandlers {
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmKick(targetId: string, name: string): void;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  doSendMsg(): Promise<void>;
  submitMessage(body: string): Promise<void>;
  openJoinRequests(): void;
}

export function ActionsMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<ActionHandlers> {
  return class extends Base {
    async doCreate(): Promise<void> {
      if (!this.createName.trim() || !this.createTag.trim()) {
        this.showToast(t('family.err.badTag'), C.red); return;
      }
      try {
        this.family = await this.cb.worldApi.createFamily(this.createName.trim(), this.createTag.trim());
        this.members = this.family.members ?? [];
        this.messages = [];
        this.mode = 'myFamily';
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async openJoinList(): Promise<void> {
      try {
        const list = await this.cb.worldApi.listFamilies();
        this.showPickModal(list);
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    private showPickModal(families: FamilyView[]): void {
      const { w, h } = this;
      const ml = this.modalLayer;
      tearDownChildren(ml);
      this.modalHits = [];
      this.modalOpen = true;

      const mw = Math.min(300, w - 32);
      const mh = Math.min(300, h - 80);
      const mx = (w - mw) / 2;
      const my = (h - mh) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeModal() });

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
        this.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => void this.doJoin(famId) });
        cy += 40;
      }
    }

    private async doJoin(familyId: string): Promise<void> {
      this.closeModal();
      try {
        await this.cb.worldApi.requestJoinFamily(familyId);
        this.showToast(t('family.joinRequested'), C.dark);
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    openJoinRequests(): void {
      this.showJoinRequestsModal();
    }

    private showJoinRequestsModal(): void {
      const { w, h } = this;
      const ml = this.modalLayer;
      ml.removeChildren();
      this.modalHits = [];
      this.modalOpen = true;

      const mw = Math.min(340, w - 32);
      const mh = Math.min(360, h - 80);
      const mx = (w - mw) / 2;
      const my = (h - mh) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeModal() });

      const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
      panel.x = mx; panel.y = my;
      ml.addChild(panel);

      const title = txt(t('family.pendingRequests', { n: this.joinRequests.length }), FS.heading, C.dark, true);
      title.x = mx + 12; title.y = my + 10;
      ml.addChild(title);

      if (this.joinRequests.length === 0) {
        const lbl = txt(t('family.noPendingRequests'), FS.tiny, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
        ml.addChild(lbl);
        return;
      }

      let cy = my + 40;
      for (const reqv of this.joinRequests) {
        const row = sketchPanel(mw - 16, 40, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
        row.x = mx + 8; row.y = cy;
        ml.addChild(row);
        const nameLbl = txt(reqv.displayName ?? reqv.publicId ?? reqv.accountId, FS.tiny, C.dark);
        nameLbl.x = mx + 14; nameLbl.y = cy + 12;
        ml.addChild(nameLbl);

        const approveW = 56, rejectW = 56, btnH = 26, gap = 6;
        const rejectX = mx + mw - 8 - rejectW;
        const approveX = rejectX - gap - approveW;

        const approveBtn = sketchPanel(approveW, btnH, { fill: 0xe0f0e0, border: 0x4a8a4a, seed: seedFor(cy, 1, approveW) });
        approveBtn.x = approveX; approveBtn.y = cy + 7;
        ml.addChild(approveBtn);
        const al = txt(t('family.approve'), FS.label, 0x2f6b2f);
        al.anchor.set(0.5, 0.5); al.x = approveX + approveW / 2; al.y = cy + 7 + btnH / 2;
        ml.addChild(al);
        const rid = reqv.requestId;
        this.modalHits.push({ rect: { x: approveX, y: cy + 7, w: approveW, h: btnH }, action: () => void this.doRespondJoinRequest(rid, true) });

        const rejectBtn = sketchPanel(rejectW, btnH, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 2, rejectW) });
        rejectBtn.x = rejectX; rejectBtn.y = cy + 7;
        ml.addChild(rejectBtn);
        const rl = txt(t('family.reject'), FS.label, C.red);
        rl.anchor.set(0.5, 0.5); rl.x = rejectX + rejectW / 2; rl.y = cy + 7 + btnH / 2;
        ml.addChild(rl);
        this.modalHits.push({ rect: { x: rejectX, y: cy + 7, w: rejectW, h: btnH }, action: () => void this.doRespondJoinRequest(rid, false) });

        cy += 44;
      }
    }

    private async doRespondJoinRequest(requestId: string, accept: boolean): Promise<void> {
      try {
        await this.cb.worldApi.respondJoinRequest(requestId, accept);
        this.showToast(t(accept ? 'family.requestApproved' : 'family.requestRejected'), C.dark);
        if (accept && this.family) {
          // Roster changed — refetch (also refreshes joinRequests) and close, since the modal's
          // row list is now stale.
          await this.loadMyFamily(this.family.familyId);
          this.closeModal();
        } else {
          this.joinRequests = this.joinRequests.filter((r) => r.requestId !== requestId);
          if (this.joinRequests.length > 0) this.showJoinRequestsModal();
          else this.closeModal();
        }
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmLeave(): void {
      this.showConfirm(t('family.confirmLeave'), () => void this.doLeave());
    }

    private async doLeave(): Promise<void> {
      this.closeModal();
      if (!this.family) return;
      try {
        await this.cb.worldApi.leaveFamily();
        this.family = null; this.members = []; this.messages = [];
        this.mode = 'noFamily';
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmDissolve(): void {
      this.showConfirm(t('family.confirmDissolve'), () => void this.doDissolve());
    }

    private async doDissolve(): Promise<void> {
      this.closeModal();
      if (!this.family) return;
      try {
        await this.cb.worldApi.dissolveFamily();
        this.family = null; this.members = []; this.messages = [];
        this.mode = 'noFamily';
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    confirmKick(targetId: string, name: string): void {
      this.showConfirm(t('family.confirmKick'), () => void this.doKick(targetId));
    }

    private async doKick(targetId: string): Promise<void> {
      this.closeModal();
      if (!this.family) return;
      try {
        await this.cb.worldApi.kickMember(targetId);
        this.members = this.members.filter(m => m.accountId !== targetId);
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void> {
      if (!this.family) return;
      try {
        await this.cb.worldApi.setRole(targetId, role);
        const m = this.members.find(mem => mem.accountId === targetId);
        if (m) m.role = role;
        this.render();
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
    }

    async submitMessage(body: string): Promise<void> {
      if (!body || !this.family) return;
      // Optimistic echo: show the sender's own message instantly instead of blocking on
      // POST + full channel refetch (two sequential round-trips ≈ 2–3s of frozen UI — the
      // "Send does nothing" complaint). The channel is newest-first (server sorts ts desc),
      // so prepend and reset the channel scroll to the top so the new line is in view.
      const optimistic: FamilyMessageView = {
        id: `pending-${body.length}-${this.messages.length}`,
        senderId: this.cb.myAccountId,
        senderName: this.cb.playerName,
        body,
        ts: Number.MAX_SAFE_INTEGER,
      };
      this.messages = [optimistic, ...this.messages];
      this.scrollYChannel = 0;
      if (!this.destroyed) this.render();
      try {
        await this.cb.worldApi.sendFamilyMessage(this.family.familyId, body, this.cb.playerName);
        await this.loadChannel(); // replaces the optimistic echo with the authoritative list
      } catch (err) {
        // Roll back the echo and surface the error.
        this.messages = this.messages.filter((m) => m !== optimistic);
        this.showToast(this.errorMsg(err), C.red);
      }
      if (!this.destroyed) this.render();
    }

    async doSendMsg(): Promise<void> {
      // Source the body from this.sendText, not this.sendInput.value — clicking Send blurs the
      // hidden DOM input first (its 'blur' handler already nulled this.sendInput by the time this
      // click handler runs), so sendInput can be null here even though the user has typed text.
      // sendText mirrors the input's value on every keystroke, so it's always current regardless
      // of DOM focus state.
      const body = this.sendText.trim();
      if (this.sendInput) { this.sendInput.remove(); this.sendInput = null; }
      this.sendText = '';
      if (body) {
        await this.submitMessage(body);
      } else {
        this.openSendInput();
      }
    }
  };
}
