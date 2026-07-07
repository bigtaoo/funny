// Render domain: the mode-specific views (loading / no-sect / create form / my-sect with the
// families + channel tabs) plus the small center-message / center-button / bottom-bar-button helpers.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { type Constructor, type SectSceneBaseCtor, type SectTab, HUD_H, ROW_H } from './base';

export interface RenderHandlers {
  renderLoading(): void;
  renderNoSect(): void;
  renderCreate(): void;
  renderMySect(): void;
  renderFamilies(y0: number, maxH: number): void;
  renderBottomBar(y: number): void;
  renderChannel(y0: number, maxH: number): void;
  centerMessage(msg: string): void;
  addCenterButton(label: string, x: number, y: number, action: () => void, seed: number): void;
  addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number): void;
}

export function RenderMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderLoading(): void {
      const lbl = txt(t('world.loading'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    renderNoSect(): void {
      const { w, h } = this;

      // Players who aren't a family leader can't act on the sect.
      if (!this.inFamily) {
        this.centerMessage(t('sect.notInFamily'));
        return;
      }
      if (!this.isFamilyLeader) {
        this.centerMessage(t('sect.notLeader'));
        return;
      }

      const lbl = txt(t('sect.noSect'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - 50;
      this.bodyLayer.addChild(lbl);

      const hint = txt(t('sect.createHint'), 11, C.mid);
      hint.anchor.set(0.5, 0.5);
      hint.x = w / 2; hint.y = h / 2 - 28;
      this.bodyLayer.addChild(hint);

      this.addCenterButton(t('sect.create'), w / 2 - 130, h / 2, () => { this.mode = 'create'; this.render(); }, 0);
      this.addCenterButton(t('sect.browse'), w / 2 + 10, h / 2, () => void this.openBrowseList(), 1);
    }

    renderCreate(): void {
      const { w } = this;

      const lbl1 = txt(t('sect.name') + ':', 13, C.dark);
      lbl1.x = 20; lbl1.y = HUD_H + 20;
      this.bodyLayer.addChild(lbl1);

      const nameField = sketchPanel(w - 120, 32, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - 120) });
      nameField.x = 100; nameField.y = HUD_H + 14;
      this.bodyLayer.addChild(nameField);
      const nl = txt(caretDisplay(this.createName, this.createField === 'name' && this.caretOn, ' '), 13, C.dark);
      nl.x = 108; nl.y = HUD_H + 22;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: 100, y: HUD_H + 14, w: w - 120, h: 32 }, action: () => this.openInputFor('name') });

      const lbl2 = txt(t('sect.tag') + ':', 13, C.dark);
      lbl2.x = 20; lbl2.y = HUD_H + 70;
      this.bodyLayer.addChild(lbl2);

      const tagField = sketchPanel(100, 32, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, 100) });
      tagField.x = 100; tagField.y = HUD_H + 64;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, this.createField === 'tag' && this.caretOn, ' '), 13, C.dark);
      tl.x = 108; tl.y = HUD_H + 72;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: 100, y: HUD_H + 64, w: 100, h: 32 }, action: () => this.openInputFor('tag') });

      const okBtn = sketchPanel(100, 34, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 100) });
      okBtn.x = w / 2 - 110; okBtn.y = HUD_H + 120;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('sect.create'), 13, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = w / 2 - 60; ok.y = HUD_H + 137;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: w / 2 - 110, y: HUD_H + 120, w: 100, h: 34 }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(100, 34, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, 100) });
      cancelBtn.x = w / 2 + 10; cancelBtn.y = HUD_H + 120;
      this.bodyLayer.addChild(cancelBtn);
      const ca = buildIcon('close', 15, C.dark);
      ca.x = w / 2 + 60 - 7.5; ca.y = HUD_H + 137 - 7.5;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: w / 2 + 10, y: HUD_H + 120, w: 100, h: 34 }, action: () => { this.mode = 'noSect'; this.render(); } });
    }

    renderMySect(): void {
      if (!this.sect) return;
      const { w, h } = this;

      // Tab bar
      const tabs: SectTab[] = ['families', 'channel'];
      const tabW = w / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = i * tabW; tp.y = HUD_H;
        this.bodyLayer.addChild(tp);
        const tl = txt(t(tab === 'families' ? 'sect.tabFamilies' : 'sect.tabChannel'), 13, active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = i * tabW + tabW / 2; tl.y = HUD_H + 18;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: i * tabW, y: HUD_H, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const contentY = HUD_H + 36;
      const contentH = h - contentY - 10;

      if (this.activeTab === 'families') {
        this.renderFamilies(contentY, contentH);
      } else {
        this.renderChannel(contentY, contentH);
      }
    }

    renderFamilies(y0: number, maxH: number): void {
      if (!this.sect) return;
      const { w } = this;
      const sect = this.sect;

      // Sect summary line (name [tag] · families · prosperity).
      const summary = txt(
        `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
        12, C.mid,
      );
      summary.x = 12; summary.y = y0;
      this.bodyLayer.addChild(summary);

      // Removal vote banner.
      let listTop = y0 + 22;
      if (sect.removalVote) {
        const nom = sect.memberFamilies.find(f => f.familyId === sect.removalVote!.nomineeFamilyId);
        const banner = txt(
          t('sect.voteStatus', {
            name: nom ? `[${nom.tag}] ${nom.name}` : sect.removalVote.nomineeFamilyId,
            cur: sect.removalVote.voteCount,
            need: sect.removalVote.needed,
          }),
          11, C.red,
        );
        banner.x = 12; banner.y = listTop;
        this.bodyLayer.addChild(banner);
        listTop += 20;
      }

      const bottomBarH = 42;
      const listH = sect.memberFamilies.length * ROW_H;
      const viewH = (y0 + maxH - bottomBarH) - listTop;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, listH - viewH)));

      let cy = listTop - this.scrollY;
      for (const fam of sect.memberFamilies) {
        if (cy + ROW_H >= listTop && cy <= listTop + viewH) {
          const isLeaderFam = fam.familyId === sect.leaderFamilyId;
          const bar = new PIXI.Graphics();
          sketchAccentBar(bar, ROW_H - 4, isLeaderFam ? C.accent : C.mid);
          bar.x = 6; bar.y = cy + 2;
          this.bodyLayer.addChild(bar);

          if (isLeaderFam) {
            const ldr = txt(t('sect.leaderFamily'), 10, C.accent);
            ldr.x = 16; ldr.y = cy + 4;
            this.bodyLayer.addChild(ldr);
          }
          const nameLbl = txt(`[${fam.tag}] ${fam.name}`, 13, C.dark);
          nameLbl.x = 16; nameLbl.y = cy + 18;
          this.bodyLayer.addChild(nameLbl);
          const statLbl = txt(`${t('family.members', { n: fam.memberCount })} · ${t('sect.territory', { n: fam.territoryCount })}`, 10, C.mid);
          statLbl.x = 16; statLbl.y = cy + 34;
          this.bodyLayer.addChild(statLbl);

          // Any family leader (except the current leader family) can launch / vote a removal.
          if (this.isFamilyLeader && !isLeaderFam) {
            const voteBtn = sketchPanel(56, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 1, 56) });
            voteBtn.x = w - 66; voteBtn.y = cy + 12;
            this.bodyLayer.addChild(voteBtn);
            const vl = txt(t('sect.vote'), 10, C.red);
            vl.anchor.set(0.5, 0.5); vl.x = w - 38; vl.y = cy + 23;
            this.bodyLayer.addChild(vl);
            const nomId = fam.familyId;
            const nomLabel = `[${fam.tag}] ${fam.name}`;
            this.hitRects.push({ rect: { x: w - 66, y: cy + 12, w: 56, h: 22 }, action: () => this.confirmVote(nomId, nomLabel) });
          }
        }
        cy += ROW_H;
      }

      this.renderBottomBar(y0 + maxH - bottomBarH);
    }

    renderBottomBar(y: number): void {
      const { w } = this;
      if (this.isSectLeader) {
        // Leader: dissolve / ally / manage allies.
        this.addBarButton(t('sect.dissolve'), 6, y, C.red, () => this.confirmDissolve(), 0);
        this.addBarButton(t('sect.ally'), w / 2 - 50, y, C.accent, () => void this.openAllyList(), 1);
        this.addBarButton(t('sect.manageAllies'), w - 106, y, C.dark, () => void this.openManageAllies(), 2);
      } else if (this.isFamilyLeader) {
        this.addBarButton(t('sect.leave'), w / 2 - 60, y, C.accent, () => this.confirmLeave(), 0);
      }
    }

    renderChannel(y0: number, maxH: number): void {
      const { w } = this;
      const inputH = 44;
      const listH2 = maxH - inputH - 6;

      if (this.messages.length === 0) {
        const empty = txt(t('sect.noMessages'), 12, C.mid);
        empty.anchor.set(0.5, 0); empty.x = w / 2; empty.y = y0 + 8;
        this.bodyLayer.addChild(empty);
      }

      const msgH = this.messages.length * ROW_H;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, msgH - listH2)));

      // Channel is returned newest-first; render oldest-at-top for natural reading.
      const ordered = [...this.messages].reverse();
      let cy = y0 - this.scrollY;
      for (const msg of ordered) {
        if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
        const nameLbl = txt(msg.senderName, 11, C.accent);
        nameLbl.x = 12; nameLbl.y = cy + 4;
        this.bodyLayer.addChild(nameLbl);
        const bodyLbl = txt(msg.body, 12, C.dark);
        bodyLbl.x = 12; bodyLbl.y = cy + 18;
        this.bodyLayer.addChild(bodyLbl);
        cy += ROW_H;
      }

      const inputY = y0 + listH2 + 4;
      const field = sketchPanel(w - 80, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, w - 80) });
      field.x = 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      const fl = txt(t('sect.msgPlaceholder'), 12, C.mid);
      fl.x = 12; fl.y = inputY + 10;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: 6, y: inputY, w: w - 80, h: 36 }, action: () => this.openSendInput() });

      const sendBtn = sketchPanel(66, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 66) });
      sendBtn.x = w - 72; sendBtn.y = inputY;
      this.bodyLayer.addChild(sendBtn);
      const sl = txt(t('sect.send'), 13, C.light);
      sl.anchor.set(0.5, 0.5); sl.x = w - 39; sl.y = inputY + 18;
      this.bodyLayer.addChild(sl);
      this.hitRects.push({ rect: { x: w - 72, y: inputY, w: 66, h: 36 }, action: () => this.openSendInput() });
    }

    // ── Small render helpers ────────────────────────────────────────────────────

    centerMessage(msg: string): void {
      const lbl = txt(msg, 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    addCenterButton(label: string, x: number, y: number, action: () => void, seed: number): void {
      const btn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(seed, 0, 120) });
      btn.x = x; btn.y = y;
      this.bodyLayer.addChild(btn);
      const lbl = txt(label, 13, C.light);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + 60; lbl.y = y + 18;
      this.bodyLayer.addChild(lbl);
      this.hitRects.push({ rect: { x, y, w: 120, h: 36 }, action });
    }

    addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number): void {
      const bw = 100;
      const btn = sketchPanel(bw, 32, { fill: 0xf8f8f0, border: color, seed: seedFor(seed, 2, bw) });
      btn.x = x; btn.y = y;
      this.bodyLayer.addChild(btn);
      const lbl = txt(label, 12, color);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = y + 16;
      this.bodyLayer.addChild(lbl);
      this.hitRects.push({ rect: { x, y, w: bw, h: 32 }, action });
    }
  };
}
