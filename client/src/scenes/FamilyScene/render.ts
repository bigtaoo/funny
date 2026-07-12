// Per-mode rendering for the family scene: loading / noFamily / create form / myFamily (members + channel).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { type Constructor, type FamilySceneBaseCtor, type FamilyTab, ROW_H } from './base';

export interface RenderHandlers {
  renderLoading(): void;
  renderNoFamily(): void;
  renderCreate(): void;
  renderMyFamily(): void;
}

export function RenderMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderLoading(): void {
      const lbl = txt(t('world.loading'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    renderNoFamily(): void {
      const { w, h } = this;
      const lbl = txt(t('family.noFamily'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - 40;
      this.bodyLayer.addChild(lbl);

      const createBtn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 120) });
      createBtn.x = w / 2 - 130; createBtn.y = h / 2;
      this.bodyLayer.addChild(createBtn);
      const cl = txt(t('family.create'), 13, C.light);
      cl.anchor.set(0.5, 0.5); cl.x = w / 2 - 70; cl.y = h / 2 + 18;
      this.bodyLayer.addChild(cl);
      this.hitRects.push({ rect: { x: w / 2 - 130, y: h / 2, w: 120, h: 36 }, action: () => { this.mode = 'create'; this.render(); } });

      const joinBtn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 120) });
      joinBtn.x = w / 2 + 10; joinBtn.y = h / 2;
      this.bodyLayer.addChild(joinBtn);
      const jl = txt(t('family.listAll'), 13, C.light);
      jl.anchor.set(0.5, 0.5); jl.x = w / 2 + 70; jl.y = h / 2 + 18;
      this.bodyLayer.addChild(jl);
      this.hitRects.push({ rect: { x: w / 2 + 10, y: h / 2, w: 120, h: 36 }, action: () => void this.openJoinList() });
    }

    renderCreate(): void {
      const { w, h } = this;

      const lbl1 = txt(t('family.name') + ':', 13, C.dark);
      lbl1.x = 20; lbl1.y = this.headerH + 20;
      this.bodyLayer.addChild(lbl1);

      const nameField = sketchPanel(w - 120, 32, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - 120) });
      nameField.x = 100; nameField.y = this.headerH + 14;
      this.bodyLayer.addChild(nameField);
      const nl = txt(caretDisplay(this.createName, this.createField === 'name' && this.caretOn, ' '), 13, C.dark);
      nl.x = 108; nl.y = this.headerH + 22;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: 100, y: this.headerH + 14, w: w - 120, h: 32 }, action: () => this.openInputFor('name') });

      const lbl2 = txt(t('family.tag') + ':', 13, C.dark);
      lbl2.x = 20; lbl2.y = this.headerH + 70;
      this.bodyLayer.addChild(lbl2);

      const tagField = sketchPanel(100, 32, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, 100) });
      tagField.x = 100; tagField.y = this.headerH + 64;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, this.createField === 'tag' && this.caretOn, ' '), 13, C.dark);
      tl.x = 108; tl.y = this.headerH + 72;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: 100, y: this.headerH + 64, w: 100, h: 32 }, action: () => this.openInputFor('tag') });

      const hint = txt('[A-Z0-9] 2-5 chars', 11, C.mid);
      hint.x = 210; hint.y = this.headerH + 72;
      this.bodyLayer.addChild(hint);

      const okBtn = sketchPanel(100, 34, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 100) });
      okBtn.x = w / 2 - 110; okBtn.y = this.headerH + 120;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('family.create'), 13, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = w / 2 - 60; ok.y = this.headerH + 137;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: w / 2 - 110, y: this.headerH + 120, w: 100, h: 34 }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(100, 34, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, 100) });
      cancelBtn.x = w / 2 + 10; cancelBtn.y = this.headerH + 120;
      this.bodyLayer.addChild(cancelBtn);
      const ca = buildIcon('close', 15, C.dark);
      ca.x = w / 2 + 60 - 7.5; ca.y = this.headerH + 137 - 7.5;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: w / 2 + 10, y: this.headerH + 120, w: 100, h: 34 }, action: () => { this.mode = 'noFamily'; this.render(); } });
    }

    renderMyFamily(): void {
      if (!this.family) return;
      const { w, h } = this;

      // Rail itself is now drawn unconditionally by the base render() dispatcher (see base.ts).

      // Tab bar — starts to the right of the social hub rail so it doesn't sit on top of it,
      // matching the EquipmentScene/GachaScene convention.
      const left = this.railW;
      const tabs: FamilyTab[] = ['members', 'channel'];
      const tabW = (w - left) / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tx = left + i * tabW;
        const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = tx; tp.y = this.headerH;
        this.bodyLayer.addChild(tp);
        const tl = txt(t(tab === 'members' ? 'family.tabMembers' : 'family.channel'), 13, active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = this.headerH + 18;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: tx, y: this.headerH, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const contentY = this.headerH + 36;
      const contentH = h - contentY - 10;

      if (this.activeTab === 'members') {
        this.renderMembers(contentY, contentH);
      } else {
        this.renderChannel(contentY, contentH);
      }
    }

    private renderMembers(y0: number, maxH: number): void {
      const { w } = this;
      const left = this.railW;
      const me = this.cb.myAccountId;

      const myRole = this.members.find(m => m.accountId === me)?.role ?? 'member';
      const isLeader = myRole === 'leader';

      const listH = this.members.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, listH - maxH)));

      let cy = y0 - this.scrollY;
      for (const mem of this.members) {
        if (cy + ROW_H < y0 || cy > y0 + maxH) { cy += ROW_H; continue; }
        const bar = new PIXI.Graphics();
        sketchAccentBar(bar, ROW_H - 4, mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : C.mid);
        bar.x = left + 6; bar.y = cy + 2;
        this.bodyLayer.addChild(bar);

        const roleLbl = txt(t(`family.${mem.role as 'leader' | 'member' | 'elder'}`), 10, C.mid);
        roleLbl.x = left + 16; roleLbl.y = cy + 4;
        this.bodyLayer.addChild(roleLbl);
        const nameLbl = txt(mem.displayName ?? mem.publicId ?? '', 13, C.dark);
        nameLbl.x = left + 16; nameLbl.y = cy + 18;
        this.bodyLayer.addChild(nameLbl);

        // Action buttons for leader (promote/demote elders + kick).
        if (isLeader && mem.accountId !== me) {
          const accId = mem.accountId;

          // Role toggle: members → elder, elders → member. (Leader role only changes via transfer/dissolve.)
          if (mem.role !== 'leader') {
            const toElder = mem.role === 'member';
            const roleBtn = sketchPanel(50, 22, { fill: 0xeef0e0, border: 0xd4a030, seed: seedFor(cy, 2, 50) });
            roleBtn.x = w - 116; roleBtn.y = cy + 10;
            this.bodyLayer.addChild(roleBtn);
            const rl = txt(t(toElder ? 'family.setElder' : 'family.setMember'), 10, 0xb8881a);
            rl.anchor.set(0.5, 0.5); rl.x = w - 91; rl.y = cy + 21;
            this.bodyLayer.addChild(rl);
            const nextRole: 'elder' | 'member' = toElder ? 'elder' : 'member';
            this.hitRects.push({ rect: { x: w - 116, y: cy + 10, w: 50, h: 22 }, action: () => void this.doSetRole(accId, nextRole) });
          }

          const kickBtn = sketchPanel(50, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 0, 50) });
          kickBtn.x = w - 60; kickBtn.y = cy + 10;
          this.bodyLayer.addChild(kickBtn);
          const kl = txt(t('family.kick'), 11, C.red);
          kl.anchor.set(0.5, 0.5); kl.x = w - 35; kl.y = cy + 21;
          this.bodyLayer.addChild(kl);
          this.hitRects.push({ rect: { x: w - 60, y: cy + 10, w: 50, h: 22 }, action: () => this.confirmKick(accId, mem.displayName ?? mem.publicId ?? '') });
        }

        cy += ROW_H;
      }

      // Bottom bar: Sect hub entry (left) + Leave / Dissolve (right).
      const isLdr = myRole === 'leader';
      const barY = y0 + maxH - 36;
      const midX = (left + w) / 2;

      const sectBtn = sketchPanel(110, 32, { fill: C.dark, border: C.accent, seed: seedFor(2, 0, 110) });
      sectBtn.x = midX - 120; sectBtn.y = barY;
      this.bodyLayer.addChild(sectBtn);
      const sbl = txt(t('family.sect'), 13, C.light);
      sbl.anchor.set(0.5, 0.5); sbl.x = midX - 65; sbl.y = barY + 16;
      this.bodyLayer.addChild(sbl);
      this.hitRects.push({ rect: { x: midX - 120, y: barY, w: 110, h: 32 }, action: () => this.cb.onOpenSect() });

      const btnLabel = isLdr ? t('family.dissolve') : t('family.leave');
      const btnColor = isLdr ? C.red : C.accent;
      const btn = sketchPanel(110, 32, { fill: 0xf8f8f0, border: btnColor, seed: seedFor(0, 0, 110) });
      btn.x = midX + 10; btn.y = barY;
      this.bodyLayer.addChild(btn);
      const bl = txt(btnLabel, 13, btnColor);
      bl.anchor.set(0.5, 0.5); bl.x = midX + 65; bl.y = barY + 16;
      this.bodyLayer.addChild(bl);
      this.hitRects.push({
        rect: { x: midX + 10, y: barY, w: 110, h: 32 },
        action: () => isLdr ? this.confirmDissolve() : this.confirmLeave(),
      });
    }

    private renderChannel(y0: number, maxH: number): void {
      const { w } = this;
      const left = this.railW;
      const inputH = 44;
      const listH2 = maxH - inputH - 6;

      // Message list
      const msgH = this.messages.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, msgH - listH2)));

      let cy = y0 - this.scrollY;
      for (const msg of this.messages) {
        if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
        const nameLbl = txt(msg.senderName ?? msg.senderId, 11, C.accent);
        nameLbl.x = left + 12; nameLbl.y = cy + 4;
        this.bodyLayer.addChild(nameLbl);
        const bodyLbl = txt(msg.body, 12, C.dark);
        bodyLbl.x = left + 12; bodyLbl.y = cy + 18;
        this.bodyLayer.addChild(bodyLbl);
        cy += ROW_H;
      }

      // Input area
      const inputY = y0 + listH2 + 4;
      const fieldW = w - left - 80;
      const field = sketchPanel(fieldW, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, fieldW) });
      field.x = left + 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      const fl = txt(t('family.msgPlaceholder'), 12, C.mid);
      fl.x = left + 12; fl.y = inputY + 10;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: left + 6, y: inputY, w: fieldW, h: 36 }, action: () => this.openSendInput() });

      const sendBtn = sketchPanel(66, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 66) });
      sendBtn.x = w - 72; sendBtn.y = inputY;
      this.bodyLayer.addChild(sendBtn);
      const sl = txt(t('family.send'), 13, C.light);
      sl.anchor.set(0.5, 0.5); sl.x = w - 39; sl.y = inputY + 18;
      this.bodyLayer.addChild(sl);
      this.hitRects.push({ rect: { x: w - 72, y: inputY, w: 66, h: 36 }, action: () => void this.doSendMsg() });
    }
  };
}
