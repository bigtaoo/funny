// Render domain: the mode-specific views (loading / no-sect / create form / my-sect with the
// families + channel tabs) plus the small center-message / center-button / bottom-bar-button helpers.
import * as PIXI from 'pixi.js-legacy';
import { SECT_CREATE_COST } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { caretDisplay } from '../../render/inputDisplay';
import { type Constructor, type SectSceneBaseCtor, type SectTab, ROW_H } from './base';

export interface RenderHandlers {
  renderLoading(): void;
  renderNoSect(): void;
  renderCreate(): void;
  renderMySect(): void;
  renderFamilies(y0: number, maxH: number): void;
  renderBottomBar(y: number): void;
  renderChannel(y0: number, maxH: number): void;
  centerMessage(msg: string): void;
  addCenterButton(label: string, x: number, y: number, action: () => void, seed: number, enabled?: boolean): void;
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

      const lbl = txt(t('sect.noSect'), 28, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - 100;
      this.bodyLayer.addChild(lbl);

      const hint = txt(t('sect.createHint', { n: SECT_CREATE_COST }), 22, C.mid);
      hint.anchor.set(0.5, 0.5);
      hint.x = w / 2; hint.y = h / 2 - 56;
      this.bodyLayer.addChild(hint);

      const canAffordCreate = this.cb.getCoins() >= SECT_CREATE_COST;
      this.addCenterButton(
        t('sect.create'), w / 2 - 260, h / 2,
        () => { this.mode = 'create'; this.render(); },
        0, canAffordCreate,
      );
      this.addCenterButton(t('sect.browse'), w / 2 + 20, h / 2, () => void this.openBrowseList(), 1);
    }

    renderCreate(): void {
      const { w, h } = this;

      // Everything lives inside a centered card in the region RIGHT of the social rail — the
      // old absolute-x layout overlapped the rail (Family/Sect/World/Mail) and the header text.
      const left = this.railW;
      const availW = w - left;
      const cardW = Math.min(720, availW * 0.82);
      const cardX = left + (availW - cardW) / 2;
      const pad = 36;
      const cx = cardX + cardW / 2;      // card horizontal center (used for title + buttons)
      const inX = cardX + pad;            // inner content left edge
      const inW = cardW - pad * 2;        // inner content width
      const fieldH = 48;

      // Field metrics chosen up front so we can size the card to its content.
      const titleH = 34, gapAfterTitle = 26;
      const labelH = 26, gapLabelField = 8;
      const gapAfterName = 30;
      const tagLabelH = 24, tagHintH = 20;
      const tagFieldW = Math.min(260, inW);
      const gapAfterTag = 40;
      const btnH = 48;

      const cardH = pad
        + titleH + gapAfterTitle
        + labelH + gapLabelField + fieldH + gapAfterName
        + tagLabelH + tagHintH + fieldH + gapAfterTag
        + btnH
        + pad;
      const cardY = Math.max(this.headerH + 20, this.headerH + (h - this.headerH - cardH) / 2);

      // Card background.
      const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(7, 0, cardW) });
      card.x = cardX; card.y = cardY;
      this.bodyLayer.addChild(card);

      let y = cardY + pad;

      // Title.
      const title = txt(t('sect.createTitle'), 24, C.dark);
      title.anchor.set(0.5, 0); title.x = cx; title.y = y;
      this.bodyLayer.addChild(title);
      y += titleH + gapAfterTitle;

      // ── Sect name ──
      const nameLbl = txt(t('sect.name'), 18, C.dark);
      nameLbl.x = inX; nameLbl.y = y;
      this.bodyLayer.addChild(nameLbl);
      y += labelH + gapLabelField;

      const nameFocused = this.createField === 'name';
      const nameField = sketchPanel(inW, fieldH, { fill: 0xfaf9f5, border: nameFocused ? C.accent : C.mid, seed: seedFor(0, 0, inW) });
      nameField.x = inX; nameField.y = y;
      this.bodyLayer.addChild(nameField);
      const nameEmpty = this.createName.length === 0 && !nameFocused;
      const nl = txt(nameEmpty ? t('social.sect.namePlaceholder') : caretDisplay(this.createName, nameFocused && this.caretOn, ' '), 20, nameEmpty ? C.mid : C.dark);
      nl.anchor.set(0, 0.5); nl.x = inX + 12; nl.y = y + fieldH / 2;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: inX, y, w: inW, h: fieldH }, action: () => this.openInputFor('name') });
      y += fieldH + gapAfterName;

      // ── Tag (short label + hint line underneath) ──
      const tagLbl = txt(t('sect.tagLabel'), 18, C.dark);
      tagLbl.x = inX; tagLbl.y = y;
      this.bodyLayer.addChild(tagLbl);
      y += tagLabelH;
      const tagHint = txt(t('sect.tagHint'), 12, C.mid);
      tagHint.x = inX; tagHint.y = y;
      this.bodyLayer.addChild(tagHint);
      y += tagHintH;

      const tagFocused = this.createField === 'tag';
      const tagField = sketchPanel(tagFieldW, fieldH, { fill: 0xfaf9f5, border: tagFocused ? C.accent : C.mid, seed: seedFor(1, 0, tagFieldW) });
      tagField.x = inX; tagField.y = y;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, tagFocused && this.caretOn, ' '), 20, C.dark);
      tl.anchor.set(0, 0.5); tl.x = inX + 12; tl.y = y + fieldH / 2;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: inX, y, w: tagFieldW, h: fieldH }, action: () => this.openInputFor('tag') });
      y += fieldH + gapAfterTag;

      // ── Buttons (create + cancel, side by side, centered under the fields) ──
      const btnW = 150, btnGap = 24;
      const okX = cx - btnW - btnGap / 2;
      const cancelX = cx + btnGap / 2;

      const okBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(0, 1, btnW) });
      okBtn.x = okX; okBtn.y = y;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('sect.create'), 18, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = okX + btnW / 2; ok.y = y + btnH / 2;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: okX, y, w: btnW, h: btnH }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 1, btnW) });
      cancelBtn.x = cancelX; cancelBtn.y = y;
      this.bodyLayer.addChild(cancelBtn);
      const ca = txt(t('social.sect.cancel'), 18, C.dark);
      ca.anchor.set(0.5, 0.5); ca.x = cancelX + btnW / 2; ca.y = y + btnH / 2;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: cancelX, y, w: btnW, h: btnH }, action: () => { this.mode = 'noSect'; this.render(); } });
    }

    renderMySect(): void {
      if (!this.sect) return;
      const { w, h } = this;

      // Rail itself is now drawn unconditionally by the base render() dispatcher (see base.ts).
      const left = this.railW;

      // Tab bar — starts to the right of the rail, same convention as FamilyScene.
      const tabs: SectTab[] = ['families', 'channel'];
      const tabW = (w - left) / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tx = left + i * tabW;
        const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = tx; tp.y = this.headerH;
        this.bodyLayer.addChild(tp);
        const tl = txt(t(tab === 'families' ? 'sect.tabFamilies' : 'sect.tabChannel'), 13, active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = this.headerH + 18;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: tx, y: this.headerH, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const contentY = this.headerH + 36;
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
      const left = this.railW;
      const sect = this.sect;

      // Sect summary line (name [tag] · families · prosperity).
      const summary = txt(
        `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
        12, C.mid,
      );
      summary.x = left + 12; summary.y = y0;
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
        banner.x = left + 12; banner.y = listTop;
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
          bar.x = left + 6; bar.y = cy + 2;
          this.bodyLayer.addChild(bar);

          if (isLeaderFam) {
            const ldr = txt(t('sect.leaderFamily'), 10, C.accent);
            ldr.x = left + 16; ldr.y = cy + 4;
            this.bodyLayer.addChild(ldr);
          }
          const nameLbl = txt(`[${fam.tag}] ${fam.name}`, 13, C.dark);
          nameLbl.x = left + 16; nameLbl.y = cy + 18;
          this.bodyLayer.addChild(nameLbl);
          const statLbl = txt(`${t('family.members', { n: fam.memberCount })} · ${t('sect.territory', { n: fam.territoryCount })}`, 10, C.mid);
          statLbl.x = left + 16; statLbl.y = cy + 34;
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

      drawScrollIndicator(this.bodyLayer, { x: left, y: listTop, w: w - left, h: viewH }, this.scrollY, Math.max(0, listH - viewH));

      this.renderBottomBar(y0 + maxH - bottomBarH);
    }

    renderBottomBar(y: number): void {
      const { w } = this;
      const left = this.railW;
      const midX = (left + w) / 2;
      if (this.isSectLeader) {
        // Leader: dissolve / ally / manage allies.
        this.addBarButton(t('sect.dissolve'), left + 6, y, C.red, () => this.confirmDissolve(), 0);
        this.addBarButton(t('sect.ally'), midX - 50, y, C.accent, () => void this.openAllyList(), 1);
        this.addBarButton(t('sect.manageAllies'), w - 106, y, C.dark, () => void this.openManageAllies(), 2);
      } else if (this.isFamilyLeader) {
        this.addBarButton(t('sect.leave'), midX - 60, y, C.accent, () => this.confirmLeave(), 0);
      }
    }

    renderChannel(y0: number, maxH: number): void {
      const { w } = this;
      const left = this.railW;
      const inputH = 44;
      const listH2 = maxH - inputH - 6;

      if (this.messages.length === 0) {
        const empty = txt(t('sect.noMessages'), 12, C.mid);
        empty.anchor.set(0.5, 0); empty.x = (left + w) / 2; empty.y = y0 + 8;
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
        nameLbl.x = left + 12; nameLbl.y = cy + 4;
        this.bodyLayer.addChild(nameLbl);
        const bodyLbl = txt(msg.body, 12, C.dark);
        bodyLbl.x = left + 12; bodyLbl.y = cy + 18;
        this.bodyLayer.addChild(bodyLbl);
        cy += ROW_H;
      }

      drawScrollIndicator(this.bodyLayer, { x: left, y: y0, w: w - left, h: listH2 }, this.scrollY, Math.max(0, msgH - listH2));

      const inputY = y0 + listH2 + 4;
      const fieldW = w - left - 80;
      const field = sketchPanel(fieldW, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, fieldW) });
      field.x = left + 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      const fl = txt(t('sect.msgPlaceholder'), 12, C.mid);
      fl.x = left + 12; fl.y = inputY + 10;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: left + 6, y: inputY, w: fieldW, h: 36 }, action: () => this.openSendInput() });

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

    addCenterButton(label: string, x: number, y: number, action: () => void, seed: number, enabled = true): void {
      const btn = sketchPanel(240, 72, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(seed, 0, 240) });
      btn.x = x; btn.y = y;
      this.bodyLayer.addChild(btn);
      const lbl = txt(label, 26, enabled ? C.light : C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + 120; lbl.y = y + 36;
      this.bodyLayer.addChild(lbl);
      if (enabled) this.hitRects.push({ rect: { x, y, w: 240, h: 72 }, action });
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
