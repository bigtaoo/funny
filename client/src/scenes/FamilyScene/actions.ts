// Network actions + confirm/pick modals for the family scene: create, join, leave, dissolve, kick, set-role.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import type { FamilyView } from '../../net/WorldApiClient';
import { type Constructor, type FamilySceneBaseCtor } from './base';

export interface ActionHandlers {
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmKick(targetId: string, name: string): void;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  doSendMsg(): Promise<void>;
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
      ml.removeChildren();
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
        const lbl = txt(t('family.noFamily'), 13, C.dark);
        lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
        ml.addChild(lbl);
        return;
      }

      let cy = my + 10;
      for (const fam of families.slice(0, 6)) {
        const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
        row.x = mx + 8; row.y = cy;
        ml.addChild(row);
        const lbl = txt(`[${fam.tag}] ${fam.name} (${fam.memberCount})`, 12, C.dark);
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
        await this.cb.worldApi.joinFamily(familyId);
        await this.loadMyFamily(familyId);
        this.render();
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

    async doSendMsg(): Promise<void> {
      // Handled inline by openSendInput
    }
  };
}
